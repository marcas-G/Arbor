import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { patchExecutor } from "../src/index.js";
import { executeFsTool, fsToolSandbox } from "./fs-tool-harness.js";

const root = mkdtempSync(join(tmpdir(), "arbor-patch-"));
const file = join(root, "a.txt");
writeFileSync(file, "line1\nline2\nline3");
const sandbox = fsToolSandbox(root, "ReadWrite");

const executePatch = (unifiedDiff: string, path = "a.txt") =>
  executeFsTool(
    patchExecutor,
    {
      toolName: "patch",
      toolVersion: "2",
      argumentsJson: JSON.stringify({
        target: { mount: "workspace", path },
        unifiedDiff,
      }),
    },
    sandbox,
  );

describe("patch tool", () => {
  it.effect("applies a unified diff", () =>
    Effect.gen(function* () {
      const result = yield* executePatch("@@ -2,1 +2,1 @@\n-line2\n+LINE2");
      expect(result.settlement._tag).toBe("Success");
      expect(readFileSync(file, "utf8")).toBe("line1\nLINE2\nline3");
    }),
  );

  it.effect("returns ExpectedFailure for a diff with no hunk", () =>
    Effect.gen(function* () {
      const result = yield* executePatch("no hunks");
      expect(result.settlement._tag).toBe("ExpectedFailure");
    }),
  );

  it.effect(
    "rejects a stale hunk instead of overwriting unrelated content",
    () =>
      Effect.gen(function* () {
        writeFileSync(file, "line1\nnew concurrent line\nline3");
        const result = yield* executePatch("@@ -2,1 +2,1 @@\n-line2\n+LINE2");
        expect(result.settlement._tag).toBe("ExpectedFailure");
        expect(readFileSync(file, "utf8")).toBe(
          "line1\nnew concurrent line\nline3",
        );
      }),
  );

  it.effect("treats an already-applied insertion as an idempotent replay", () =>
    Effect.gen(function* () {
      writeFileSync(file, "line1\nline2");
      const diff = "@@ -1,0 +1,1 @@\n+inserted";
      const first = yield* executePatch(diff);
      const second = yield* executePatch(diff);
      expect(first.settlement._tag).toBe("Success");
      expect(second.settlement._tag).toBe("Success");
      expect(readFileSync(file, "utf8")).toBe("inserted\nline1\nline2");
    }),
  );

  it.effect(
    "fails closed without a defect when the target escapes the sandbox",
    () =>
      Effect.gen(function* () {
        const result = yield* executePatch(
          "@@ -0,0 +1,1 @@\n+outside",
          "../outside.txt",
        );
        expect(result.settlement._tag).toBe("ExpectedFailure");
      }),
  );

  it.effect(
    "creates a missing file and treats an identical replay as idempotent",
    () =>
      Effect.gen(function* () {
        const diff = "@@ -0,0 +1,2 @@\n+first\n+second\n";
        const first = yield* executePatch(diff, "created.txt");
        const second = yield* executePatch(diff, "created.txt");
        expect(first.settlement._tag).toBe("Success");
        expect(second.settlement._tag).toBe("Success");
        expect(readFileSync(join(root, "created.txt"), "utf8")).toBe(
          "first\nsecond",
        );
      }),
  );

  it.effect("accepts the common Begin Patch Add File format", () =>
    Effect.gen(function* () {
      const diff =
        "*** Begin Patch\n*** Add File: begin-end-created.txt\n+created by a coding model\n*** End Patch";
      const first = yield* executePatch(diff, "begin-end-created.txt");
      const second = yield* executePatch(diff, "begin-end-created.txt");
      expect(first.settlement._tag).toBe("Success");
      expect(second.settlement._tag).toBe("Success");
      expect(readFileSync(join(root, "begin-end-created.txt"), "utf8")).toBe(
        "created by a coding model",
      );
    }),
  );

  it.effect("accepts the common Begin Patch Update File format", () =>
    Effect.gen(function* () {
      writeFileSync(file, "line1\nline2\nline3");
      const diff =
        "*** Begin Patch\n*** Update File: a.txt\n@@\n line1\n-line2\n+LINE2\n line3\n*** End Patch";
      const result = yield* executePatch(diff);
      expect(result.settlement._tag).toBe("Success");
      expect(readFileSync(file, "utf8")).toBe("line1\nLINE2\nline3");
    }),
  );
});
