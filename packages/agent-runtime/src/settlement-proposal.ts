import type { ExecutionSettlement } from "@arbor/domain";

/** Immutable Agent Runtime output. Application owns the durable commit. */
export interface SettlementProposal {
  readonly _tag: "SettlementProposal";
  readonly settlement: ExecutionSettlement;
}

export const settlementProposal = (
  settlement: ExecutionSettlement,
): SettlementProposal => ({ _tag: "SettlementProposal", settlement });
