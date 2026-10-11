import { type CommandHandler, commandErr, commandOk } from "@arbor/application";
import { type ExecutionId, type Principal, stopExecution } from "@arbor/domain";
import type {
  ExecutableApprovalStoreService,
  ExecutionRepositoryService,
  PendingDomainEvent,
} from "@arbor/ports";
import { Effect, Option } from "effect";

export interface StopExecutionPayload {
  readonly executionId: ExecutionId;
}

export interface StopExecutionResult {
  readonly executionId: ExecutionId;
  readonly stopRequestedAt: string;
}

export interface StopExecutionDependencies {
  readonly executions: ExecutionRepositoryService;
  /** Provided only when the ordered P38 storage suffix is installed. */
  readonly executableApprovals?: Pick<
    ExecutableApprovalStoreService,
    "cancelForExecution"
  >;
}

export const makeStopExecutionHandler = (
  dependencies: StopExecutionDependencies,
): CommandHandler<StopExecutionPayload, StopExecutionResult> => ({
  commandType: "StopExecution",
  schemaVersion: "1",
  authority: {
    tag: "StopExecutionAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "StopExecutionAuthority" &&
      authority.executionId === payload.executionId,
  },
  stopAdmission: { _tag: "StopControl" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      const execution = yield* dependencies.executions.findById(
        payload.executionId,
      );
      if (Option.isNone(execution)) {
        return commandErr({
          _tag: "ExecutionNotFound",
          executionId: payload.executionId,
        });
      }
      const current = execution.value;
      if (current.projectId !== envelope.projectId) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "execution belongs to another project",
        });
      }
      if (current.state.status !== "Active") {
        return commandErr({
          _tag: "TerminalLifecycleMutation",
          entity: "Execution",
          lifecycle: "Settled",
        });
      }
      if (current.stopRequestedAt !== null) {
        return commandOk({
          result: {
            executionId: payload.executionId,
            stopRequestedAt: current.stopRequestedAt,
          },
          events: [],
        });
      }
      const stopped = stopExecution(current, envelope.issuedAt);
      if (!stopped.ok) {
        return commandErr(stopped.error);
      }
      yield* dependencies.executions.requestStop(
        payload.executionId,
        envelope.issuedAt,
      );
      const cancelledApprovals =
        dependencies.executableApprovals === undefined
          ? []
          : yield* dependencies.executableApprovals.cancelForExecution({
              executionId: payload.executionId,
              cancelledAt: envelope.issuedAt,
              cancelledBy: envelope.actor as unknown as Principal,
              reason: "StopRequested",
            });
      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "ExecutionStopRequested",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.executionId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: { executionId: payload.executionId },
        },
        ...cancelledApprovals.map((approval) => ({
          projectId: envelope.projectId,
          eventType: "ExecutableApprovalResolved" as const,
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: approval.approvalId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          correlationRef: approval.logicalActionId,
          payload: {
            approvalId: approval.approvalId,
            routeKind: "Executable" as const,
            workspaceId: approval.workspaceId,
            executionId: approval.executionId,
            logicalActionId: approval.logicalActionId,
            toolInvocationId: approval.toolInvocationId,
            revision: approval.revision,
            resolution: "Cancelled" as const,
            reasonCode: "StopRequested",
          },
        })),
      ];
      return commandOk({
        result: {
          executionId: payload.executionId,
          stopRequestedAt: envelope.issuedAt,
        },
        events,
      });
    }),
});
