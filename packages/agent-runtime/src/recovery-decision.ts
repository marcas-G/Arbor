import type { AgentLoopStepRecord } from "@arbor/ports";

export type PersistedProviderResult =
  | "NotFound"
  | "Unsettled"
  | "SettledSuccess"
  | "SettledFailure";

export type RecoveryDecision =
  | { readonly _tag: "Continue" }
  | {
      readonly _tag: "PublishProviderResult";
      readonly providerTurnId: AgentLoopStepRecord["providerTurnId"];
    }
  | {
      readonly _tag: "EnsureSuccessor";
      readonly successor: NonNullable<AgentLoopStepRecord["successor"]>;
    }
  | { readonly _tag: "RepairRequired"; readonly reason: string }
  | { readonly _tag: "Settle"; readonly reason: "PersistedProposal" };

export interface DurableRecoverySnapshot {
  readonly step: AgentLoopStepRecord;
  readonly providerResult: PersistedProviderResult;
}

/** Pure recovery choice over a complete durable snapshot. */
export const decideDurableRecovery = (
  snapshot: DurableRecoverySnapshot,
): RecoveryDecision => {
  const { step, providerResult } = snapshot;
  if (step.state === "SettlementProposed" && step.settlement !== undefined)
    return { _tag: "Settle", reason: "PersistedProposal" };
  if (
    (step.state === "NextStepReady" || step.state === "OutputRejected") &&
    step.successor !== undefined
  )
    return { _tag: "EnsureSuccessor", successor: step.successor };
  if (step.state === "OutputRejected" && step.successor === undefined)
    return { _tag: "RepairRequired", reason: "OutputRejectedWithoutSuccessor" };
  if (step.state === "Prepared" && providerResult === "SettledSuccess")
    return {
      _tag: "PublishProviderResult",
      providerTurnId: step.providerTurnId,
    };
  return { _tag: "Continue" };
};
