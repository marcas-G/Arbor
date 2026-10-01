import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext, ToolIntent } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { patchExecutor } from "../src/index.js";

const root = mkdtempSync(join(tmpdir(), "p4-patch-"));
const file = join(root, "a.txt");
writeFileSync(file, "line1\nline2\nline3");

const intent = (argumentsJson: string): ToolIntent => ({
  callRef: "c",
  toolName: "patch",
  toolVersion: "1",
  argumentsJson,
  invocationId: "tin_x" as never,
  approvalId: null,
});
const context = {} as ToolExecutionContext;
const sandbox = { handleId: "s", rootPath: root, writableRegions: [] };

describe("P4 patch tool", () => {
  it("applies a unified diff", async () => {
    const diff = "@@ -2,1 +2,1 @@\n-line2\n+LINE2";
    const result = await Effect.runPromise(
      patchExecutor.execute({
        intent: intent(
          JSON.stringify({ path: { path: "a.txt" }, unifiedDiff: diff }),
        ),
        definition: {} as never,
        context,
        sandbox,
        regions: [],
      }),
    );
    expect(result.settlement._tag).toBe("Success");
    expect(readFileSync(file, "utf8")).toBe("line1\nLINE2\nline3");
  });

  it("returns ExpectedFailure for a diff with no hunk", async () => {
    const result = await Effect.runPromise(
      patchExecutor.execute({
        intent: intent(
          JSON.stringify({ path: { path: "a.txt" }, unifiedDiff: "no hunks" }),
        ),
        definition: {} as never,
        context,
        sandbox,
        regions: [],
      }),
    );
    expect(result.settlement._tag).toBe("ExpectedFailure");
  });

  it("rejects a stale hunk instead of overwriting unrelated content", async () => {
    writeFileSync(file, "line1\nnew concurrent line\nline3");
    const result = await Effect.runPromise(
      patchExecutor.execute({
        intent: intent(
          JSON.stringify({
            path: { path: "a.txt" },
            unifiedDiff: "@@ -2,1 +2,1 @@\n-line2\n+LINE2",
          }),
        ),
        definition: {} as never,
        context,
        sandbox,
        regions: [],
      }),
    );
    expect(result.settlement._tag).toBe("ExpectedFailure");
    expect(readFileSync(file, "utf8")).toBe(
      "line1\nnew concurrent line\nline3",
    );
  });

  it("treats an already-applied insertion as an idempotent replay", async () => {
    writeFileSync(file, "line1\nline2");
    const diff = "@@ -1,0 +1,1 @@\n+inserted";
    const execute = () =>
      Effect.runPromise(
        patchExecutor.execute({
          intent: intent(
            JSON.stringify({ path: { path: "a.txt" }, unifiedDiff: diff }),
          ),
          definition: {} as never,
          context,
          sandbox,
          regions: [],
        }),
      );
    const first = await execute();
    const second = await execute();
    expect(first.settlement._tag).toBe("Success");
    expect(second.settlement._tag).toBe("Success");
    expect(readFileSync(file, "utf8")).toBe("inserted\nline1\nline2");
  });

  it("fails closed without a defect when the target escapes the sandbox", async () => {
    const result = await Effect.runPromise(
      patchExecutor.execute({
        intent: intent(
          JSON.stringify({
            path: { path: "../outside.txt" },
            unifiedDiff: "@@ -0,0 +1,1 @@\n+outside",
          }),
        ),
        definition: {} as never,
        context,
        sandbox,
        regions: [],
      }),
    );

    expect(result.settlement._tag).toBe("ExpectedFailure");
  });
});
