import type { StopAdmission } from "@arbor/application";
import { FenceStopCheck, type FenceStopOutcome } from "@arbor/application";
import type { CommandSubmissionContext } from "@arbor/domain";
import { Clock, ExecutionRepository } from "@arbor/ports";
import { Effect, Layer, Option } from "effect";

/**
 * Authoritative fence + stop admission (P2 `02` §4, `03` §3–§4).
 * Runs in the ambient command transaction; never opens its own.
 */
export const FenceStopCheckLive: Layer.Layer<
  FenceStopCheck,
  never,
  ExecutionRepository | Clock
> = Layer.effect(
  FenceStopCheck,
  Effect.gen(function* () {
    const repository = yield* ExecutionRepository;
    const clock = yield* Clock;

    const check = (
      context: CommandSubmissionContext,
      stopAdmission: StopAdmission,
    ) =>
      Effect.gen(function* () {
        if (context._tag !== "ExecutionOrigin") {
          return "Pass" as const;
        }
        const execution = yield* repository.findById(context.executionId);
        if (
          Option.isNone(execution) ||
          execution.value.state.status !== "Active"
        ) {
          return "FencingRejected" as const;
        }
        const lease = yield* repository.currentLease(context.executionId);
        if (Option.isNone(lease)) {
          return "FencingRejected" as const;
        }
        const now = yield* clock.now();
        if (lease.value.generation !== context.fencingGeneration) {
          return "FencingRejected" as const;
        }
        if (lease.value.expiresAt <= now) {
          return "FencingRejected" as const;
        }
        if (execution.value.stopRequested) {
          return stopAdmission._tag === "NormalExecutionMutation"
            ? ("ExecutionStopping" as const)
            : ("Pass" as const);
        }
        return "Pass" as const;
      });

    return FenceStopCheck.of({ check });
  }),
);
