import type { Principal } from "@arbor/domain";
import type {
  ExecutableApprovalStoreService,
  ExecutionRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";

export interface ResolveExecutableApprovalPayload {
  readonly approvalId: string;
  readonly expectedRevision: number;
  readonly decision: "Approve" | "Reject";
  readonly reason: string | null;
}

export interface ResolveExecutableApprovalResult {
  readonly approvalId: string;
  readonly executionId: string;
  readonly state: "Approved" | "Rejected" | "Expired";
  readonly revision: number;
}

export interface ResolveExecutableApprovalDependencies {
  readonly approvals: Pick<
    ExecutableApprovalStoreService,
    "findById" | "decide"
  >;
  readonly executions: Pick<ExecutionRepositoryService, "findById">;
  readonly now: () => Effect.Effect<string>;
}

/** P1/P12 human decision route for proven Executable ActionApproval rows.
 * The storage CAS consumes the exact revision's Inbox key and journals the
 * durable same-Execution wake fact in the Gateway transaction. */
export const makeResolveExecutableApprovalHandler = (
  dependencies: ResolveExecutableApprovalDependencies,
): CommandHandler<
  ResolveExecutableApprovalPayload,
  ResolveExecutableApprovalResult
> => ({
  commandType: "ResolveExecutableApproval",
  schemaVersion: "1",
  authority: {
    tag: "ExecutableApprovalDecisionAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "ExecutableApprovalDecisionAuthority" &&
      authority.approvalId === payload.approvalId &&
      authority.expectedRevision === payload.expectedRevision,
  },
  stopAdmission: { _tag: "NormalExecutionMutation" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const decisionAt = yield* dependencies.now();
      const existing = yield* dependencies.approvals.findById(
        payload.approvalId,
      );
      if (
        Option.isNone(existing) ||
        existing.value.projectId !== envelope.projectId
      ) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "executable approval not found",
        });
      }
      if (
        existing.value.state !== "Pending" ||
        existing.value.revision !== payload.expectedRevision
      ) {
        return commandErr({
          _tag: "RevisionConflict",
          expected: payload.expectedRevision,
          actual: existing.value.revision,
        });
      }
      const execution = yield* dependencies.executions.findById(
        existing.value.executionId,
      );
      if (
        Option.isNone(execution) ||
        execution.value.projectId !== envelope.projectId ||
        execution.value.workspaceId !== existing.value.workspaceId ||
        execution.value.state.status !== "Active" ||
        execution.value.stopRequestedAt !== null
      ) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "executable approval not found",
        });
      }
      const decided = yield* dependencies.approvals.decide({
        approvalId: payload.approvalId,
        commandId: envelope.commandId,
        expectedRevision: payload.expectedRevision,
        decision: payload.decision,
        decidedAt: decisionAt,
        decidedBy: String(envelope.actor) as Principal,
        reason: payload.reason,
      });
      if (Option.isNone(decided)) {
        return commandErr({
          _tag: "RevisionConflict",
          expected: payload.expectedRevision,
          actual: existing.value.revision,
        });
      }
      return commandOk({
        events: [],
        result: {
          approvalId: decided.value.approvalId,
          executionId: decided.value.executionId,
          state: decided.value.state as "Approved" | "Rejected" | "Expired",
          revision: decided.value.revision,
        },
      });
    }),
});
