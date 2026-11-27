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
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterAll, describe, expect } from "vitest";
import { globExecutor, writeExecutor } from "../src/index.js";
import { executeFsTool, fsToolSandbox } from "./fs-tool-harness.js";

const root = mkdtempSync(join(tmpdir(), "arbor-filesystem-tools-"));
const extraRoots: string[] = [];
afterAll(() => {
  for (const directory of [root, ...extraRoots])
    rmSync(directory, { recursive: true, force: true });
});
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "main.ts"), "const answer = 42;\n");
writeFileSync(join(root, "src", "notes.md"), "answer appears here\n");

const sandbox = fsToolSandbox(root, "ReadWrite");

const execute = (
  executor: typeof writeExecutor | typeof globExecutor,
  toolName: string,
  input: unknown,
) =>
  executeFsTool(
    executor,
    { toolName, toolVersion: "1", argumentsJson: JSON.stringify(input) },
    sandbox,
  );

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
      // Out-of-mount and parent-symlink write rejection is covered by
      // filesystem-boundaries.test.ts ("does not read or overwrite another
      // workspace through final or parent symlinks") with the same write
      // path plus the read tools and content assertions.
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

    // Regex search with mount-relative line/column/text results is covered
    // by filesystem-boundaries.test.ts ("keeps concurrent same-path writes…"
    // for root-targeted search and "searches a selected directory relative
    // to it…" for the exact match shape).
  },
);
