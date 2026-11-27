import { describe, it } from "vitest";
import type { ToolExecutionResult } from "../src/runtime.js";

const rnoSettlement = {
  _tag: "ReconciledNoEffect",
  reasonCode: "ReplayLimitReached",
  reconciliationFactRef: "fact_p39_selected",
} as const;

const _runtimeResult: ToolExecutionResult = {
  settlement: rnoSettlement,
  observation: { text: "no effect", truncated: false },
  resultRef: "artifact_p4_result",
};

const _executorSelectedResult: ToolExecutionResult = {
  settlement: rnoSettlement,
  observation: { text: "no effect", truncated: false },
  resultRef: "artifact_p4_result",
  // @ts-expect-error Selection is derived from RecoveryEvidenceStore, not executor output.
  reconciliationSelection: {
    attemptNo: 1,
    factId: "fact_p39_selected",
  },
};

describe("reconciliation selection typing", () => {
  it("accepts the effect outcome without accepting executor-authored selection", () => {
    // The contract is compile-time only: the @ts-expect-error above proves
    // ToolExecutionResult rejects an executor-authored reconciliationSelection
    // (selection is derived from RecoveryEvidenceStore, not executor output).
    // No runtime surface exists to assert.
  });
});
