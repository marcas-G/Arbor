import {
  type CommandHandler,
  commandErr,
  commandOk,
  stopExecutionAndCancelExecutableApprovals,
} from "@arbor/application";
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
      const firstStop = current.stopRequestedAt === null;
      if (firstStop) {
        const stopped = stopExecution(current, envelope.issuedAt);
        if (!stopped.ok) return commandErr(stopped.error);
      }
      const resolvedApprovalEvents =
        yield* stopExecutionAndCancelExecutableApprovals(
          {
            projectId: envelope.projectId,
            executionId: payload.executionId,
            stopRequestedAt: current.stopRequestedAt ?? envelope.issuedAt,
            actor: envelope.actor,
            actorPrincipal: envelope.actor as unknown as Principal,
            commandId: envelope.commandId,
          },
          {
            executions: dependencies.executions,
            approvals: dependencies.executableApprovals ?? {
              cancelForExecution: () => Effect.succeed([]),
            },
          },
        );
      const stopEvent: PendingDomainEvent | undefined = firstStop
        ? {
            projectId: envelope.projectId,
            eventType: "ExecutionStopRequested",
            eventVersion: 1,
            occurredAt: envelope.issuedAt,
            aggregateRef: payload.executionId,
            actor: envelope.actor,
            causedByCommandId: envelope.commandId,
            payload: { executionId: payload.executionId },
          }
        : undefined;
      const events: PendingDomainEvent[] = [
        ...(stopEvent === undefined ? [] : [stopEvent]),
        ...resolvedApprovalEvents,
      ];
      return commandOk({
        result: {
          executionId: payload.executionId,
          stopRequestedAt: current.stopRequestedAt ?? envelope.issuedAt,
        },
        events,
      });
    }),
});
