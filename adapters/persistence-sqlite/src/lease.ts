import type { ExecutionId, LeaseGeneration } from "@arbor/domain";
import {
  Clock,
  ExecutionRepository,
  type ExecutionRepositoryError,
  type LeaseFencingRejected,
  LeaseService,
  type LeaseServiceService,
  type TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";

const LEASE_TTL_MS = 30_000;

export const LeaseServiceLive: Layer.Layer<
  LeaseService,
  never,
  ExecutionRepository | Clock
> = Layer.effect(
  LeaseService,
  Effect.gen(function* () {
    const repository = yield* ExecutionRepository;
    const clock = yield* Clock;

    const rejected = (
      executionId: ExecutionId,
      generation: LeaseGeneration,
    ): LeaseFencingRejected => ({
      _tag: "LeaseFencingRejected",
      executionId,
      generation,
    });

    const currentGeneration = (
      executionId: ExecutionId,
    ): Effect.Effect<
      LeaseGeneration,
      ExecutionRepositoryError,
      TransactionScope
    > =>
      Effect.gen(function* () {
        const current = yield* repository.currentLease(executionId);
        return Option.isSome(current)
          ? current.value.generation
          : (0 as LeaseGeneration);
      });

    const acquire: LeaseServiceService["acquire"] = (
      executionId,
      workerId,
      workerIncarnationId,
    ) =>
      Effect.gen(function* () {
        const now = yield* clock.now();
        const expiresAt = new Date(
          Date.parse(now) + LEASE_TTL_MS,
        ).toISOString();
        const lease = yield* repository.tryAcquireLease(
          executionId,
          workerId,
          workerIncarnationId,
          expiresAt,
        );
        if (Option.isSome(lease)) {
          return lease.value;
        }
        return yield* Effect.fail<LeaseFencingRejected>(
          rejected(executionId, yield* currentGeneration(executionId)),
        );
      });

    const renew: LeaseServiceService["renew"] = (
      executionId,
      workerId,
      workerIncarnationId,
      generation,
    ) =>
      Effect.gen(function* () {
        const now = yield* clock.now();
        const expiresAt = new Date(
          Date.parse(now) + LEASE_TTL_MS,
        ).toISOString();
        const lease = yield* repository.renewLease(
          executionId,
          workerId,
          workerIncarnationId,
          generation,
          expiresAt,
        );
        if (Option.isSome(lease)) {
          return lease.value;
        }
        return yield* Effect.fail<LeaseFencingRejected>(
          rejected(executionId, generation),
        );
      });

    const release: LeaseServiceService["release"] = (
      executionId,
      workerId,
      workerIncarnationId,
      generation,
    ) =>
      repository.releaseLease(
        executionId,
        workerId,
        workerIncarnationId,
        generation,
      );

    const invalidateExpired: LeaseServiceService["invalidateExpired"] = (now) =>
      Effect.gen(function* () {
        const expired = yield* repository.findExpiredActiveExecutions(now);
        return expired.length;
      });

    return LeaseService.of({ acquire, renew, release, invalidateExpired });
  }),
);
