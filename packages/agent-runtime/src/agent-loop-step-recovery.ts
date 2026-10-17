import type { ExecutionSettlement } from "@arbor/domain";
import type { AgentLoopStepRecord } from "@arbor/ports";

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key))
  );
};

/** Decode only the settlement shape produced by exhausted output-contract
 * repair. This marker is a terminal frontier only when the persisted payload
 * is complete and internally consistent. */
export const decodeExhaustedRepairDisposition = (
  value: unknown,
): ExecutionSettlement | undefined => {
  const disposition = recordOf(value);
  if (
    disposition === undefined ||
    !hasExactKeys(disposition, ["_tag", "settlement"]) ||
    disposition._tag !== "Exhausted"
  ) {
    return undefined;
  }
  const settlement = recordOf(disposition.settlement);
  if (settlement === undefined) return undefined;
  if (
    settlement._tag === "Failed" &&
    hasExactKeys(settlement, ["_tag", "failure"])
  ) {
    const failure = recordOf(settlement.failure);
    if (
      failure !== undefined &&
      hasExactKeys(failure, ["_tag", "reason"]) &&
      failure._tag === "ExecutionFailure" &&
      typeof failure.reason === "string" &&
      failure.reason.length > 0
    ) {
      return settlement as unknown as ExecutionSettlement;
    }
    return undefined;
  }
  if (
    settlement._tag === "Interrupted" &&
    hasExactKeys(settlement, ["_tag", "result"])
  ) {
    const result = recordOf(settlement.result);
    if (
      result !== undefined &&
      hasExactKeys(result, ["_tag", "reason"]) &&
      result._tag === "ControlledInterruption" &&
      result.reason === "RuntimeSafetyStop"
    ) {
      return settlement as unknown as ExecutionSettlement;
    }
  }
  return undefined;
};

/** Retry OutputRejected rows must point to the exact next repair attempt in
 * both the row's successor column and its persisted disposition. */
export const retryDispositionMatchesSuccessor = (
  step: AgentLoopStepRecord,
  successor: AgentLoopStepRecord,
): boolean => {
  const disposition = recordOf(step.repairDisposition);
  const target = recordOf(disposition?.successor);
  return (
    disposition !== undefined &&
    hasExactKeys(disposition, ["_tag", "successor"]) &&
    disposition._tag === "Retry" &&
    target !== undefined &&
    hasExactKeys(target, [
      "executionId",
      "logicalStepNo",
      "repairAttempt",
      "providerTurnId",
    ]) &&
    target.executionId === successor.identity.executionId &&
    target.logicalStepNo === successor.identity.logicalStepNo &&
    target.repairAttempt === successor.identity.repairAttempt &&
    target.providerTurnId === successor.providerTurnId
  );
};
