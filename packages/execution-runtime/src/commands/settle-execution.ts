import { type CommandHandler, commandErr, commandOk } from "@arbor/application";
import type {
  ExecutionId,
  ExecutionSettlement,
  LeaseGeneration,
  WorkId,
} from "@arbor/domain";
import { settlementMatchesEpisode, workEpisode } from "@arbor/domain";
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

const yieldedWorkId = (execution: {
  readonly binding: import("@arbor/domain").ExecutionBinding;
}): WorkId | null => {
  const candidate = execution as import("@arbor/domain").Execution;
  return workEpisode(candidate)?.workId ?? null;
};

export const executionSettledEventPayload = (
  execution: {
    readonly executionId: ExecutionId;
    readonly binding: import("@arbor/domain").ExecutionBinding;
  },
  settlement: ExecutionSettlement,
) => {
  const boundWork = workEpisode(execution as import("@arbor/domain").Execution);
  const completionClaimFields =
    boundWork !== null &&
    settlement._tag === "Completed" &&
    settlement.result._tag === "CompletionClaimed"
      ? {
          workId: boundWork.workId,
          workRevision: settlement.result.workRevision,
          claimRef: settlement.result.claimRef,
        }
      : {};
  return {
    executionId: execution.executionId,
    ...completionClaimFields,
    settlement,
  };
};

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
      if (!settlementMatchesEpisode(current, payload.settlement)) {
        return yield* invalidSettlement(
          "completed result does not match exact EpisodeBinding",
        );
      }
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
        const workId = yieldedWorkId(current);
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
          payload: executionSettledEventPayload(current, payload.settlement),
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
