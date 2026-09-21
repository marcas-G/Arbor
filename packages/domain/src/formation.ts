import type { DomainError } from "./errors.js";
import type { ExecutionSettlement } from "./execution.js";
import type { ExecutionId, FormationProposalId, WorkspaceId } from "./ids.js";
import type {
  ResourceBoundary,
  ResponsibilityDefinition,
} from "./resources.js";
import type { DomainResult } from "./result.js";
import { err, ok } from "./result.js";

/** P6 `01` §2. Model-visible formation proposal payload (fills the P3 `03`
 * name-only slot). */
export interface ChildWorkspaceProposal {
  readonly name: string;
  readonly responsibilityDraft: ResponsibilityDefinition;
  readonly resourceBoundaryDraft: ResourceBoundary;
  readonly rationale: string;
  readonly initialWork?:
    | {
        readonly objective: string;
        readonly why: string;
        readonly constraints: ReadonlyArray<string>;
        readonly completionExpectation: string;
      }
    | undefined;
  readonly formationDepthHint?: "Single" | "Recursive";
}

/** P6 `01` §3. Specialist spawn payload; becomes
 * `AdmitExecution(ExecutionBound).mission` plus session control context. */
export interface SpecialistSpec {
  readonly mission: string;
  readonly constraints: ReadonlyArray<string>;
  readonly skillIds: ReadonlyArray<string>;
}

/** P6 `01` §4.1 (D1). Governance entity with exact-revision decisions. */
export type FormationProposalState = "Pending" | "Approved" | "Rejected";

export interface FormationProposalRecord {
  readonly proposalId: FormationProposalId;
  readonly parentWorkspaceId: WorkspaceId;
  readonly proposal: ChildWorkspaceProposal;
  readonly revision: number;
  readonly state: FormationProposalState;
}

export type FormationProposalDecisionOutcome =
  | { readonly _tag: "Approve" }
  | { readonly _tag: "Reject" }
  | { readonly _tag: "Modify"; readonly proposal: ChildWorkspaceProposal };

export interface FormationProposalDecision {
  readonly expectedProposalRevision: number;
  readonly outcome: FormationProposalDecisionOutcome;
}

/** The governance fact an approval produces — and all it produces (D1). */
export interface FormationGovernanceFact {
  readonly proposalId: FormationProposalId;
  readonly proposalRevision: number;
  readonly decision: "Approve" | "Reject" | "Modify";
}

export const admitFormationProposal = (input: {
  readonly proposalId: FormationProposalId;
  readonly parentWorkspaceId: WorkspaceId;
  readonly proposal: ChildWorkspaceProposal;
}): FormationProposalRecord => ({
  proposalId: input.proposalId,
  parentWorkspaceId: input.parentWorkspaceId,
  proposal: input.proposal,
  revision: 1,
  state: "Pending",
});

const terminalRejection = (): DomainError => ({
  _tag: "TerminalLifecycleMutation",
  entity: "FormationProposal",
  lifecycle: "Approved",
});

/** P6 `01` §4.2 (D1): decisions bind the exact proposal revision; approve is a
 * governance fact only; modify supersedes content (supersede, no in-place
 * history rewrite — DID §12.10). */
export const decideFormationProposal = (
  record: FormationProposalRecord,
  decision: FormationProposalDecision,
): DomainResult<{
  readonly record: FormationProposalRecord;
  readonly fact: FormationGovernanceFact;
}> => {
  if (record.revision !== decision.expectedProposalRevision) {
    return err({
      _tag: "RevisionConflict",
      expected: decision.expectedProposalRevision,
      actual: record.revision,
    });
  }
  if (record.state !== "Pending") {
    return err(terminalRejection());
  }
  switch (decision.outcome._tag) {
    case "Modify":
      return ok({
        record: {
          ...record,
          proposal: decision.outcome.proposal,
          revision: record.revision + 1,
          state: "Pending",
        },
        fact: {
          proposalId: record.proposalId,
          proposalRevision: record.revision,
          decision: "Modify",
        },
      });
    case "Approve":
    case "Reject":
      return ok({
        record: {
          ...record,
          state: decision.outcome._tag === "Approve" ? "Approved" : "Rejected",
        },
        fact: {
          proposalId: record.proposalId,
          proposalRevision: record.revision,
          decision: decision.outcome._tag,
        },
      });
  }
};

/** P6 `01` §3 (D3). Deterministic settlement fingerprint derived from the
 * settlement ADT discriminant and payload — never from model text. */
export const settlementFingerprint = (
  settlement: ExecutionSettlement,
): string => {
  const stable = (value: unknown): string =>
    typeof value === "object" && value !== null
      ? Object.keys(value as Record<string, unknown>)
          .sort()
          .map(
            (key) =>
              `${key}:${stable((value as Record<string, unknown>)[key])}`,
          )
          .join(",")
      : String(value);
  return stable(settlement);
};

/** P6 `01` §3 (D3). Observation emitted when a specialist Execution settles;
 * enters ONLY the parent Workspace Inbox projection. */
export interface SpecialistSettled {
  readonly _tag: "SpecialistSettled";
  readonly specialistExecutionId: ExecutionId;
  readonly settlementFingerprint: string;
  readonly summary: string;
}

/** Replay-safe dedup key (D3). */
export const specialistSettlementEntryKey = (
  specialistExecutionId: ExecutionId,
  fingerprint: string,
): string => `spc:${specialistExecutionId}:${fingerprint}`;

/** P6 `02` §6. The two minimally routed governance request kinds; every other
 * kind keeps the P5 observation-only behavior. */
export type GovernanceRequest =
  | {
      readonly _tag: "FormationApproval";
      readonly proposalId: FormationProposalId;
      readonly proposalRevision: number;
    }
  | {
      readonly _tag: "DecisionRequest";
      readonly question: string;
      readonly correlationId?: string | undefined;
    };
