import type { Principal } from "@arbor/domain";
import type { ExecutableApprovalStoreService } from "@arbor/ports";
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
  readonly state: "Approved" | "Rejected";
  readonly revision: number;
}

export interface ResolveExecutableApprovalDependencies {
  readonly approvals: Pick<
    ExecutableApprovalStoreService,
    "findById" | "decide"
  >;
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
      authority.approvalId === payload.approvalId,
  },
  stopAdmission: { _tag: "NormalExecutionMutation" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const existing = yield* dependencies.approvals.findById(
        payload.approvalId,
      );
      if (
        Option.isNone(existing) ||
        existing.value.projectId !== envelope.projectId ||
        existing.value.state !== "Pending"
      ) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "executable approval not found or no longer pending",
        });
      }
      const decided = yield* dependencies.approvals.decide({
        approvalId: payload.approvalId,
        commandId: envelope.commandId,
        expectedRevision: payload.expectedRevision,
        decision: payload.decision,
        decidedAt: envelope.issuedAt,
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
          state: decided.value.state as "Approved" | "Rejected",
          revision: decided.value.revision,
        },
      });
    }),
});
