/**
 * W-00 proof ③ — Governance Queue action-target feasibility (FROZEN
 * conclusion).
 *
 * The frozen P6 admission (legacy-governance-directive-handler.ts RequestGovernance/
 * FormationApproval) writes inbox entries with the DETERMINISTIC structured
 * key `gov:${proposalId}:${revision}` and kind "Governance". The key is a
 * machine identifier (not the presentation `summary` string), so the Queue
 * CAN structurally bind DecisionCards:
 *
 *   entryKey matching /^gov:(fpr_[^:]+):(\d+)$/  →  RecordDecision with
 *   { proposalId, expectedProposalRevision } (exact binding, P6 D1).
 *
 * Anything else (Message `msg:` keys, malformed, free text) degrades to the
 * read-only entry + jump per the frozen rule. If upstream ever changes the
 * key format, the strict regex fails closed → read-only display (never a
 * guess). Future full queue targets may still go through transport DTO
 * enhancement; this parser is the W-00-frozen v1 binding.
 */

export interface GovernanceTarget {
  readonly proposalId: string;
  readonly proposalRevision: number;
}

export interface ControlApprovalTarget {
  readonly approvalId: string;
  readonly approvalRevision: number;
}

const GOVERNANCE_ENTRY_KEY = /^gov:(fpr_[^:\s]+):(\d+)$/;
const CONTROL_APPROVAL_ENTRY_KEY = /^cap:(cap_[^:\s]+):(\d+)$/;

export const isGovernanceKind = (kind: string): boolean =>
  kind === "Governance";

/** Strict structural recovery — returns null on any non-conforming shape. */
export const parseGovernanceEntryKey = (
  entryKey: string,
  kind: string,
): GovernanceTarget | null => {
  if (!isGovernanceKind(kind)) {
    return null;
  }
  const match = GOVERNANCE_ENTRY_KEY.exec(entryKey);
  if (match === null) {
    return null;
  }
  const proposalId = match[1];
  const revision = Number(match[2]);
  if (proposalId === undefined || match[2] === undefined) {
    return null;
  }
  return { proposalId, proposalRevision: revision };
};

export const parseControlApprovalEntryKey = (
  entryKey: string,
  kind: string,
): ControlApprovalTarget | null => {
  if (!isGovernanceKind(kind)) return null;
  const match = CONTROL_APPROVAL_ENTRY_KEY.exec(entryKey);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return {
    approvalId: match[1],
    approvalRevision: Number(match[2]),
  };
};
