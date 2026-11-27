import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext, ToolIntent } from "@arbor/ports";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterAll, describe, expect } from "vitest";
import { globExecutor, grepExecutor, writeExecutor } from "../src/index.js";

const root = mkdtempSync(join(tmpdir(), "arbor-filesystem-tools-"));
const extraRoots: string[] = [];
afterAll(() => {
  for (const directory of [root, ...extraRoots])
    rmSync(directory, { recursive: true, force: true });
});
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "main.ts"), "const answer = 42;\n");
writeFileSync(join(root, "src", "notes.md"), "answer appears here\n");

const context = {} as ToolExecutionContext;
const sandbox = {
  handleId: "s",
  rootPath: root,
  mounts: [
    {
      ref: "workspace",
      rootPath: root,
      region: { resourceSpaceId: "filesystem", normalizedRegion: {} },
      access: "ReadWrite" as const,
    },
  ],
  writableRegions: [],
};

const intent = (toolName: string, argumentsJson: string): ToolIntent => ({
  callRef: "c",
  toolName,
  toolVersion: "1",
  argumentsJson,
  invocationId: "tin_x" as never,
  approvalId: null,
});

const execute = (
  executor: typeof writeExecutor | typeof globExecutor | typeof grepExecutor,
  toolName: string,
  input: unknown,
) =>
  executor.execute({
    intent: intent(toolName, JSON.stringify(input)),
    definition: {} as never,
    context,
    sandbox,
    regions: [],
  });

describe.runIf(process.platform === "linux")(
  "filesystem discovery and write tools",
  () => {
    it.effect(
      "writes nested files and avoids replacing identical content on a separate call",
      () =>
        Effect.gen(function* () {
          const input = {
            target: { mount: "workspace", path: "generated/config/app.json" },
            content: '{"enabled":true}\n',
          };
          const first = yield* execute(writeExecutor, "write", input);
          const second = yield* execute(writeExecutor, "write", input);
          expect(first.settlement._tag).toBe("Success");
          expect(second.settlement._tag).toBe("Success");
          expect(JSON.parse(second.observation.text)).toMatchObject({
            written: false,
            created: false,
          });
          expect(
            readFileSync(join(root, "generated", "config", "app.json"), "utf8"),
          ).toBe(input.content);
          expect(
            lstatSync(join(root, "generated", "config", "app.json")).isFile(),
          ).toBe(true);
        }),
    );

    it.effect(
      "rejects writes outside the selected mount and through a symlink parent",
      () =>
        Effect.gen(function* () {
          const outside = mkdtempSync(
            join(tmpdir(), "arbor-filesystem-outside-"),
          );
          extraRoots.push(outside);
          symlinkSync(outside, join(root, "escape"), "dir");
          const traversal = yield* execute(writeExecutor, "write", {
            target: { mount: "workspace", path: "../outside.txt" },
            content: "no",
          });
          const symlink = yield* execute(writeExecutor, "write", {
            target: { mount: "workspace", path: "escape/file.txt" },
            content: "no",
          });
          expect(traversal.settlement._tag).toBe("ExpectedFailure");
          expect(symlink.settlement._tag).toBe("ExpectedFailure");
        }),
    );

    it.effect(
      "finds files with bounded globbing without traversing symlink directories",
      () =>
        Effect.gen(function* () {
          const outside = mkdtempSync(join(tmpdir(), "arbor-glob-outside-"));
          extraRoots.push(outside);
          writeFileSync(join(outside, "secret.ts"), "secret");
          symlinkSync(outside, join(root, "linked"), "dir");
          const result = yield* execute(globExecutor, "glob", {
            target: { mount: "workspace", path: "." },
            pattern: "**/*.ts",
          });
          expect(result.settlement._tag).toBe("Success");
          const output = JSON.parse(result.observation.text) as {
            matches: string[];
          };
          expect(output.matches).toContain("src/main.ts");
          expect(output.matches).not.toContain("linked/secret.ts");
        }),
    );

    it.effect(
      "searches text with regex and returns mount-relative locations",
      () =>
        Effect.gen(function* () {
          const result = yield* execute(grepExecutor, "grep", {
            target: { mount: "workspace", path: "." },
            query: "answer\\s*=\\s*42",
          });
          expect(result.settlement._tag).toBe("Success");
          const output = JSON.parse(result.observation.text) as {
            matches: Array<{ path: string; line: number; column: number }>;
          };
          expect(output.matches).toEqual([
            expect.objectContaining({
              path: "src/main.ts",
              line: 1,
              column: 7,
            }),
          ]);
        }),
    );
  },
);
