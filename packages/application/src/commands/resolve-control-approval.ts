import type {
  ControlApprovalRecord,
  ControlApprovalStoreService,
  InboxProjectionStoreService,
  PendingDomainEvent,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";

export interface ResolveControlApprovalPayload {
  readonly approvalId: string;
  readonly expectedRevision: number;
  readonly decision: "Approve" | "Reject";
  readonly reason: string | null;
}

export interface ResolveControlApprovalResult {
  readonly approvalId: string;
  readonly executionId: string;
  readonly state: "Approved" | "Rejected";
  readonly revision: number;
}

export interface ResolveControlApprovalDependencies {
  readonly approvals: Pick<ControlApprovalStoreService, "findById" | "decide">;
  readonly inbox: Pick<InboxProjectionStoreService, "markConsumed">;
}

export const makeResolveControlApprovalHandler = (
  dependencies: ResolveControlApprovalDependencies,
): CommandHandler<
  ResolveControlApprovalPayload,
  ResolveControlApprovalResult
> => ({
  commandType: "ResolveControlApproval",
  schemaVersion: "1",
  authority: {
    tag: "ControlApprovalDecisionAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "ControlApprovalDecisionAuthority" &&
      authority.approvalId === payload.approvalId,
  },
  stopAdmission: { _tag: "NormalExecutionMutation" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const existing = yield* dependencies.approvals.findById(
        payload.approvalId,
      );
      if (Option.isNone(existing)) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "control approval not found",
        });
      }
      const decided = yield* dependencies.approvals.decide({
        approvalId: payload.approvalId,
        expectedRevision: payload.expectedRevision,
        decision: payload.decision,
        decidedAt: envelope.issuedAt,
        decidedBy: String(envelope.actor),
        reason: payload.reason,
      });
      if (Option.isNone(decided)) {
        return commandErr({
          _tag: "RevisionConflict",
          expected: payload.expectedRevision,
          actual: existing.value.revision,
        });
      }
      const record: ControlApprovalRecord = decided.value;
      yield* dependencies.inbox.markConsumed(
        record.workspaceId,
        `cap:${record.approvalId}:${payload.expectedRevision}`,
      );
      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "ControlApprovalResolved",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: record.approvalId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            approvalId: record.approvalId,
            executionId: record.executionId,
            decision: payload.decision,
            revision: record.revision,
          },
        },
      ];
      return commandOk({
        result: {
          approvalId: record.approvalId,
          executionId: record.executionId,
          state: record.state as "Approved" | "Rejected",
          revision: record.revision,
        },
        events,
      });
    }),
});
