import type {
  Actor,
  CommandId,
  ExecutionId,
  Principal,
  ProjectId,
} from "@arbor/domain";
import type {
  ExecutableApprovalStoreService,
  ExecutionRepositoryError,
  ExecutionRepositoryService,
  PendingDomainEvent,
  ToolInvocationStoreError,
  TransactionScope,
} from "@arbor/ports";
import { Effect } from "effect";

export interface StopExecutableApprovalsInput {
  readonly projectId: ProjectId;
  readonly executionId: ExecutionId;
  readonly stopRequestedAt: string;
  readonly actor: Actor;
  readonly actorPrincipal: Principal;
  readonly commandId: CommandId;
}

export interface StopExecutableApprovalsDependencies {
  readonly executions: Pick<ExecutionRepositoryService, "requestStop">;
  readonly approvals: Pick<
    ExecutableApprovalStoreService,
    "cancelForExecution"
  >;
}

/** Common Application stop path for every authorized StopExecution mutation.
 * Callers run this inside the owning CommandGateway TransactionScope. It
 * commits the stop flag, exact Executable approval cancellation and Inbox
 * consumption together; returned resolution events are journaled by that same
 * command transaction and serve as the durable same-Execution wake source. */
export const stopExecutionAndCancelExecutableApprovals = (
  input: StopExecutableApprovalsInput,
  dependencies: StopExecutableApprovalsDependencies,
): Effect.Effect<
  ReadonlyArray<PendingDomainEvent>,
  ExecutionRepositoryError | ToolInvocationStoreError,
  TransactionScope
> =>
  Effect.gen(function* () {
    yield* dependencies.executions.requestStop(
      input.executionId,
      input.stopRequestedAt,
    );
    const cancelled = yield* dependencies.approvals.cancelForExecution({
      executionId: input.executionId,
      cancelledAt: input.stopRequestedAt,
      cancelledBy: input.actorPrincipal,
      reason: "StopRequested",
    });
    return cancelled.map(
      (approval): PendingDomainEvent => ({
        projectId: input.projectId,
        eventType: "ExecutableApprovalResolved",
        eventVersion: 1,
        occurredAt: input.stopRequestedAt,
        aggregateRef: approval.approvalId,
        actor: input.actor,
        causedByCommandId: input.commandId,
        correlationRef: approval.logicalActionId,
        payload: {
          approvalId: approval.approvalId,
          routeKind: "Executable",
          workspaceId: approval.workspaceId,
          executionId: approval.executionId,
          logicalActionId: approval.logicalActionId,
          toolInvocationId: approval.toolInvocationId,
          revision: approval.revision,
          resolution: "Cancelled",
          reasonCode: "StopRequested",
        },
      }),
    );
  });
