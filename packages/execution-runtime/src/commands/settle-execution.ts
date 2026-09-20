import { type CommandHandler, commandErr, commandOk } from "@arbor/application";
import type {
  ExecutionId,
  ExecutionSettlement,
  LeaseGeneration,
  WorkId,
} from "@arbor/domain";
import type {
  ExecutionRepositoryService,
  PendingDomainEvent,
  WorkWait,
  WorkWaitStoreService,
} from "@arbor/ports";
import { Effect, Option } from "effect";

export interface SettleExecutionPayload {
  readonly executionId: ExecutionId;
  readonly settlement: ExecutionSettlement;
  readonly expectedFencingGeneration?: LeaseGeneration;
}

export interface SettleExecutionResult {
  readonly executionId: ExecutionId;
  readonly settlement: ExecutionSettlement;
}

export interface SettleExecutionDependencies {
  readonly executions: ExecutionRepositoryService;
  readonly workWaits: WorkWaitStoreService;
}

const invalidSettlement = (reason: string) =>
  Effect.die(new Error(`invalid ExecutionSettlement: ${reason}`));

const validateSettlement = (
  settlement: ExecutionSettlement,
): Effect.Effect<void> => {
  switch (settlement._tag) {
    case "Completed": {
      if (settlement.result._tag === "Yielded") {
        return settlement.result.waitSpec.conditions.length > 0
          ? Effect.void
          : invalidSettlement("Yielded requires a non-empty WaitSpec");
      }
      return Effect.void;
    }
    case "OutcomeUnknown":
      return settlement.reconciliation.invocationRefs.length > 0
        ? Effect.void
        : invalidSettlement("OutcomeUnknown requires invocationRefs");
    default:
      return Effect.void;
  }
};

const yieldedWorkId = (settlement: ExecutionSettlement): WorkId | null => null;

export const makeSettleExecutionHandler = (
  dependencies: SettleExecutionDependencies,
): CommandHandler<SettleExecutionPayload, SettleExecutionResult> => ({
  commandType: "SettleExecution",
  schemaVersion: "1",
  authority: {
    tag: "SettleExecutionAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "SettleExecutionAuthority" &&
      authority.executionId === payload.executionId,
  },
  stopAdmission: { _tag: "QuiescenceControlMutation" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      yield* validateSettlement(payload.settlement);
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

      if (
        payload.settlement._tag === "Completed" &&
        payload.settlement.result._tag === "Yielded"
      ) {
        const workId = yieldedWorkId(payload.settlement);
        if (workId !== null) {
          const wait: WorkWait = {
            workId,
            waitSpec: payload.settlement.result.waitSpec,
            registeredAt: envelope.issuedAt,
            updatedAt: envelope.issuedAt,
          };
          yield* dependencies.workWaits.upsert(wait);
        }
      }

      yield* dependencies.executions.settle(
        payload.executionId,
        payload.settlement,
        envelope.issuedAt,
      );

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "ExecutionSettled",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.executionId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            executionId: payload.executionId,
            settlement: payload.settlement,
          },
        },
      ];

      return commandOk({
        result: {
          executionId: payload.executionId,
          settlement: payload.settlement,
        },
        events,
      });
    }),
});
