import {
  admitFormationProposal,
  type ChildWorkspaceProposal,
  decideFormationProposal,
  type FormationProposalDecisionOutcome,
  type FormationProposalId,
  type FormationProposalRecord,
  type WorkspaceId,
} from "@arbor/domain";
import type {
  FormationProposalStoreService,
  InboxProjectionStoreService,
  PendingDomainEvent,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";

/** P6 `01` §4.2 (D1). RecordDecision binds the exact formation proposal
 * revision; approve/reject produce ONLY the `DecisionRecorded` governance
 * fact — no Workspace mutation happens here. The Application consumer
 * (P6-004) executes CreateChildWorkspace afterwards via the gateway. */
export interface RecordDecisionPayload {
  readonly proposalId: FormationProposalId;
  readonly expectedProposalRevision: number;
  readonly outcome: FormationProposalDecisionOutcome;
}

export interface RecordDecisionResult {
  readonly proposalId: FormationProposalId;
  readonly proposalRevision: number;
  readonly decision: "Approve" | "Reject" | "Modify";
  readonly state: FormationProposalRecord["state"];
}

export interface RecordDecisionDependencies {
  readonly proposals: Pick<FormationProposalStoreService, "findById"> &
    Pick<FormationProposalStoreService, "decideIfPendingRevision">;
  readonly inbox: Pick<InboxProjectionStoreService, "admitUpsert">;
  readonly originatingWorkspaceOf: (
    record: FormationProposalRecord,
  ) => WorkspaceId;
}

export const makeRecordDecisionHandler = (
  dependencies: RecordDecisionDependencies,
): CommandHandler<RecordDecisionPayload, RecordDecisionResult> => ({
  commandType: "RecordDecision",
  schemaVersion: "1",
  authority: {
    tag: "RecordDecisionAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "RecordDecisionAuthority" &&
      authority.proposalId === payload.proposalId,
  },
  stopAdmission: { _tag: "NormalExecutionMutation" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const existing = yield* dependencies.proposals.findById(
        payload.proposalId,
      );
      if (Option.isNone(existing)) {
        return commandErr({
          _tag: "FormationProposalNotFound",
          proposalId: payload.proposalId,
        });
      }
      const record = existing.value;
      const decided = decideFormationProposal(record, {
        expectedProposalRevision: payload.expectedProposalRevision,
        outcome: payload.outcome,
      });
      if (!decided.ok) {
        return commandErr(decided.error);
      }
      const applied = yield* dependencies.proposals.decideIfPendingRevision(
        payload.proposalId,
        payload.expectedProposalRevision,
        decided.value.record,
      );
      if (Option.isNone(applied)) {
        return commandErr({
          _tag: "RevisionConflict",
          expected: payload.expectedProposalRevision,
          actual: record.revision,
        });
      }

      const fact = decided.value.fact;
      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "DecisionRecorded",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.proposalId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            proposalId: payload.proposalId,
            proposalRevision: fact.proposalRevision,
            decision: fact.decision,
            decidedBy: envelope.actor,
          },
        },
      ];

      // The decision outcome returns to the originating Workspace Inbox as a
      // governance observation (P6 `01` §4.2) — Inbox admission only, never a
      // Session write.
      yield* dependencies.inbox.admitUpsert({
        recipientWorkspaceId: dependencies.originatingWorkspaceOf(record),
        entryKey: `dec:${payload.proposalId}:${fact.proposalRevision}:${fact.decision}`,
        kind: "Governance",
        summary: `formation proposal ${fact.decision === "Modify" ? "modified" : fact.decision === "Approve" ? "approved" : "rejected"} at revision ${fact.proposalRevision}`,
        admittedAt: envelope.issuedAt,
      });

      return commandOk({
        result: {
          proposalId: fact.proposalId,
          proposalRevision: fact.proposalRevision,
          decision: fact.decision,
          state: decided.value.record.state,
        },
        events,
      });
    }),
});

/** Convenience for the governance admission path (P6-003 tests + P6-010
 * routing): build the initial Pending record for a proposal. */
export const initialProposalRecord = admitFormationProposal;

export type { ChildWorkspaceProposal };
