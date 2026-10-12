import { describe, expect, it } from "vitest";
import type { ToolExecutionResult } from "../src/runtime.js";

const rnoSettlement = {
  _tag: "ReconciledNoEffect",
  reasonCode: "ReplayLimitReached",
  reconciliationFactRef: "fact_p39_selected",
} as const;

const runtimeResult: ToolExecutionResult = {
  settlement: rnoSettlement,
  observation: { text: "no effect", truncated: false },
  resultRef: "artifact_p4_result",
};

const executorSelectedResult: ToolExecutionResult = {
  settlement: rnoSettlement,
  observation: { text: "no effect", truncated: false },
  resultRef: "artifact_p4_result",
  // @ts-expect-error Selection is derived from P39RecoveryEvidenceStore, not executor output.
  reconciliationSelection: {
    attemptNo: 1,
    factId: "fact_p39_selected",
  },
};

describe("P40 reconciliation selection typing", () => {
  it("accepts the effect outcome without accepting executor-authored selection", () => {
    expect(runtimeResult.settlement).toEqual(rnoSettlement);
    expect(executorSelectedResult).toBeDefined();
  });
});
