import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SandboxHandle,
  ToolExecutionContext,
  ToolIntent,
} from "@arbor/ports";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  globExecutor,
  grepExecutor,
  type ToolExecutor,
  writeExecutor,
} from "../src/index.js";

let base: string;
let workspace: string;
let other: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "p12-boundaries-"));
  workspace = join(base, "a");
  other = join(base, "b");
  mkdirSync(workspace);
  mkdirSync(other);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const handle = (
  root: string,
  access: "ReadOnly" | "ReadWrite" = "ReadWrite",
): SandboxHandle => ({
  handleId: root,
  rootPath: root,
  writableRegions: [],
  mounts: [
    {
      ref: "workspace",
      rootPath: root,
      region: { resourceSpaceId: "filesystem", normalizedRegion: {} },
      access,
    },
  ],
});
const invoke = (
  executor: ToolExecutor,
  input: unknown,
  sandbox = handle(workspace),
) =>
  Effect.runPromise(
    executor.execute({
      intent: {
        invocationId: "tin_test" as never,
        callRef: "call",
        toolName: executor.name,
        toolVersion: "1",
        argumentsJson: JSON.stringify(input),
        approvalId: null,
      } satisfies ToolIntent,
      definition: {} as never,
      context: {} as ToolExecutionContext,
      sandbox,
      regions: [],
    }),
  );
const target = (path = ".") => ({ mount: "workspace", path });

describe.runIf(process.platform === "linux")(
  "filesystem tools respect each workspace's actual mount",
  () => {
    it("keeps concurrent same-path writes and searches in their own workspace", async () => {
      const results = await Promise.all([
        invoke(writeExecutor, {
          target: target("src/value.ts"),
          content: "const owner = 'alpha';\n",
        }),
        invoke(
          writeExecutor,
          {
            target: target("src/value.ts"),
            content: "const owner = 'bravo';\n",
          },
          handle(other),
        ),
      ]);
      expect(results.map((r) => r.settlement._tag)).toEqual([
        "Success",
        "Success",
      ]);
      expect(readFileSync(join(workspace, "src/value.ts"), "utf8")).toContain(
        "alpha",
      );
      expect(readFileSync(join(other, "src/value.ts"), "utf8")).toContain(
        "bravo",
      );
      const found = await invoke(grepExecutor, {
        target: target(),
        query: "alpha|bravo",
      });
      expect(JSON.parse(found.observation.text).matches).toEqual([
        expect.objectContaining({
          path: "src/value.ts",
          text: "const owner = 'alpha';",
        }),
      ]);
    });

    it("does not read or overwrite another workspace through final or parent symlinks", async () => {
      writeFileSync(join(other, "value.txt"), "other workspace");
      symlinkSync(other, join(workspace, "linked"), "dir");
      symlinkSync(join(other, "value.txt"), join(workspace, "value.txt"));
      for (const path of ["value.txt", "linked/value.txt", "../b/value.txt"]) {
        expect(
          (
            await invoke(writeExecutor, {
              target: target(path),
              content: "incorrect",
            })
          ).settlement._tag,
        ).toBe("ExpectedFailure");
        expect(
          (await invoke(grepExecutor, { target: target(path), query: "other" }))
            .settlement._tag,
        ).toBe("ExpectedFailure");
      }
      const listed = await invoke(globExecutor, {
        target: target(),
        pattern: "**/*",
      });
      expect(JSON.parse(listed.observation.text).matches).toEqual([]);
      expect(readFileSync(join(other, "value.txt"), "utf8")).toBe(
        "other workspace",
      );
    });

    it("rejects missing, ambiguous and read-only mounts before creating directories", async () => {
      for (const sandbox of [
        { ...handle(workspace), mounts: [] },
        {
          ...handle(workspace),
          mounts: [
            ...(handle(workspace).mounts ?? []),
            ...(handle(other).mounts ?? []),
          ],
        },
        handle(workspace, "ReadOnly"),
      ]) {
        expect(
          (
            await invoke(
              writeExecutor,
              { target: target("created/value.txt"), content: "text" },
              sandbox,
            )
          ).settlement._tag,
        ).toBe("ExpectedFailure");
      }
      expect(existsSync(join(workspace, "created"))).toBe(false);
      expect(existsSync(join(other, "created"))).toBe(false);
    });

    it("preserves an existing script's ordinary mode and leaves no temporary files", async () => {
      const filename = join(workspace, "script.sh");
      writeFileSync(filename, "old\n");
      chmodSync(filename, 0o777);
      expect(
        (
          await invoke(writeExecutor, {
            target: target("script.sh"),
            content: "new\n",
          })
        ).settlement._tag,
      ).toBe("Success");
      expect(lstatSync(filename).mode & 0o777).toBe(0o777);
      expect(readdirSync(workspace)).toEqual(["script.sh"]);
    });

    it("rejects an oversized full write without touching the existing file", async () => {
      writeFileSync(join(workspace, "value.txt"), "keep");
      const result = await invoke(writeExecutor, {
        target: target("value.txt"),
        content: "x".repeat(5_000_001),
      });
      expect(result.settlement._tag).toBe("ExpectedFailure");
      expect(readFileSync(join(workspace, "value.txt"), "utf8")).toBe("keep");
    });

    it("finds a matching glob after unrelated files without consuming the match budget", async () => {
      for (let i = 0; i < 30; i++)
        writeFileSync(join(workspace, `a-${i}.txt`), "noise");
      writeFileSync(join(workspace, "z.ts"), "code");
      const result = await invoke(globExecutor, {
        target: target(),
        pattern: "*.ts",
        maxResults: 1,
      });
      expect(JSON.parse(result.observation.text)).toEqual({
        matches: ["z.ts"],
        truncated: false,
      });
    });

    it("searches a selected directory relative to it and reports mount-relative paths", async () => {
      mkdirSync(join(workspace, "src"));
      writeFileSync(join(workspace, "src/index.ts"), "const x = 42;\n");
      const files = await invoke(globExecutor, {
        target: target("src"),
        pattern: "*.ts",
      });
      expect(JSON.parse(files.observation.text).matches).toEqual([
        "src/index.ts",
      ]);
      const lines = await invoke(grepExecutor, {
        target: target("src/index.ts"),
        query: "x = 42",
      });
      expect(JSON.parse(lines.observation.text).matches).toEqual([
        { path: "src/index.ts", line: 1, column: 7, text: "const x = 42;" },
      ]);
    });

    it("bounds observations as valid JSON and declares omitted matches", async () => {
      for (let i = 0; i < 25; i++)
        writeFileSync(
          join(
            workspace,
            `${String(i).padStart(2, "0")}-${"n".repeat(150)}.ts`,
          ),
          "code",
        );
      const result = await invoke(globExecutor, {
        target: target(),
        pattern: "*.ts",
      });
      const output = JSON.parse(result.observation.text);
      expect(output.truncated).toBe(true);
      expect(output.matches.length).toBeGreaterThan(0);
      expect(output.matches.length).toBeLessThan(25);
      expect(result.observation.text.length).toBeLessThanOrEqual(1900);
    });

    it("skips binary, invalid UTF-8 and oversized files and marks the search incomplete", async () => {
      writeFileSync(
        join(workspace, "binary.dat"),
        Buffer.from("needle\0binary"),
      );
      writeFileSync(join(workspace, "invalid.dat"), Buffer.from([0xff, 0xfe]));
      writeFileSync(
        join(workspace, "large.txt"),
        `needle${"x".repeat(2 * 1024 * 1024)}`,
      );
      writeFileSync(join(workspace, "text.txt"), "Needle\n");
      const result = await invoke(grepExecutor, {
        target: target(),
        query: "needle",
        caseSensitive: false,
      });
      expect(JSON.parse(result.observation.text)).toEqual({
        matches: [{ path: "text.txt", line: 1, column: 1, text: "Needle" }],
        truncated: true,
      });
    });

    it("reports match and depth limits without claiming a complete search", async () => {
      writeFileSync(join(workspace, "lines.txt"), "match\nmatch\n");
      const limited = await invoke(grepExecutor, {
        target: target("lines.txt"),
        query: "match",
        maxResults: 1,
      });
      expect(JSON.parse(limited.observation.text)).toMatchObject({
        matches: [{ path: "lines.txt", line: 1 }],
        truncated: true,
      });
      mkdirSync(join(workspace, "nested"));
      writeFileSync(join(workspace, "nested/file.ts"), "code");
      const shallow = await invoke(globExecutor, {
        target: target(),
        pattern: "**/*.ts",
        maxDepth: 0,
      });
      expect(JSON.parse(shallow.observation.text)).toEqual({
        matches: [],
        truncated: true,
      });
    });

    it("rejects unsupported regex and malformed limits as ordinary tool failures", async () => {
      for (const input of [
        { query: "(?<=x)y" },
        { query: "(" },
        { query: "text", maxResults: 0 },
        { query: "text", maxDepth: -1 },
        { query: "text", caseSensitive: "yes" },
      ]) {
        expect(
          (await invoke(grepExecutor, { target: target(), ...input }))
            .settlement._tag,
        ).toBe("ExpectedFailure");
      }
    });

    it("handles a nested repetition regex on a long nonmatching line", async () => {
      writeFileSync(join(workspace, "long.txt"), `${"a".repeat(40_000)}b`);
      const result = await invoke(grepExecutor, {
        target: target(),
        query: "^(a+)+$",
      });
      expect(result.settlement._tag).toBe("Success");
      expect(JSON.parse(result.observation.text)).toEqual({
        matches: [],
        truncated: false,
      });
    });
  },
);
