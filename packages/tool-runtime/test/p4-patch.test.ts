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
});
