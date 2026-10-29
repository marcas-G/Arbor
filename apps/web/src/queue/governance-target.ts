import type { ExecutableApprovalInboxTarget } from "@arbor/api-contracts";

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

/** Display-only projection of P10's exact Executable Inbox target. */
export type ExecutableApprovalTarget = ExecutableApprovalInboxTarget;

const GOVERNANCE_ENTRY_KEY = /^gov:(fpr_[^:\s]+):(\d+)$/;
const CONTROL_APPROVAL_ENTRY_KEY = /^cap:(cap_[^:\s]+):(\d+)$/;
// ApprovalId is opaque and may itself contain colons (P12's stable eap ID).
// Bind the final numeric segment as Inbox revision and preserve the full ID.
const EXECUTABLE_APPROVAL_ENTRY_KEY = /^eap:(.+):(\d+)$/;
const EXECUTABLE_SIDE_EFFECTS = new Set([
  "ReadOnly",
  "Idempotent",
  "Reconcilable",
  "NonIdempotent",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every(isNonEmptyString);

const isExecutableApprovalTarget = (
  value: unknown,
): value is ExecutableApprovalTarget => {
  if (!isRecord(value)) return false;
  return (
    value.kind === "ExecutableApproval" &&
    typeof value.approvalId === "string" &&
    value.approvalId.length > 0 &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    isNonEmptyString(value.executionId) &&
    isNonEmptyString(value.toolName) &&
    isNonEmptyString(value.toolVersion) &&
    isNonEmptyString(value.validatedArgumentsPreview) &&
    isStringArray(value.targetResourceSpaceIds) &&
    isStringArray(value.capabilities) &&
    typeof value.sideEffectSemantics === "string" &&
    EXECUTABLE_SIDE_EFFECTS.has(value.sideEffectSemantics) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    isNonEmptyString(value.actionDigest)
  );
};

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

/**
 * Strictly bind the opaque `eap:` Inbox key to P10's server-projected target.
 * A key alone is never enough to render an approval form, and a cap: target
 * can never be interpreted as Executable.
 */
export const parseExecutableApprovalEntry = (
  entryKey: string,
  kind: string,
  target: unknown,
): ExecutableApprovalTarget | null => {
  if (kind !== "Governance") return null;
  const match = EXECUTABLE_APPROVAL_ENTRY_KEY.exec(entryKey);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  const approvalRevision = Number(match[2]);
  if (!Number.isSafeInteger(approvalRevision) || approvalRevision < 0) {
    return null;
  }
  if (
    !isExecutableApprovalTarget(target) ||
    target.approvalId !== match[1] ||
    target.revision !== approvalRevision
  ) {
    return null;
  }
  return target;
};
