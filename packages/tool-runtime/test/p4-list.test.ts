import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext, ToolIntent } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { listExecutor } from "../src/index.js";

const root = mkdtempSync(join(tmpdir(), "p4-list-"));
writeFileSync(join(root, "a.txt"), "a");

const intent = (argumentsJson: string): ToolIntent => ({
  callRef: "c",
  toolName: "list",
  toolVersion: "1",
  argumentsJson,
  invocationId: "tin_x" as never,
  approvalId: null,
});
const context = {} as ToolExecutionContext;
const sandbox = { handleId: "s", rootPath: root, writableRegions: [] };

describe("P4 list tool", () => {
  it("lists a relative target within the sandbox", async () => {
    const result = await Effect.runPromise(
      listExecutor.execute({
        intent: intent('{"path":{"path":"."},"depth":0}'),
        definition: {} as never,
        context,
        sandbox,
        regions: [],
      }),
    );

    expect(result.settlement._tag).toBe("Success");
    expect(JSON.parse(result.observation.text).entries).toContain("a.txt");
  });

  it("fails closed without a defect when v1 receives an absolute ResourceAddress", async () => {
    const result = await Effect.runPromise(
      listExecutor.execute({
        intent: intent(
          JSON.stringify({ path: { _tag: "GitWorktree", path: root } }),
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
