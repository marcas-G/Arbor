import { type CommandHandler, commandErr, commandOk } from "@arbor/application";
import { type ExecutionId, stopExecution } from "@arbor/domain";
import type {
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
