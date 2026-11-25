import type { ExecutionId, LeaseGeneration } from "@arbor/domain";
import {
  ExecutionRepository,
  type ExecutionRepositoryError,
  type LeaseRecord,
  LeaseService,
  type TransactionOperationalFailure,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Option } from "effect";

/** Empirical TTL value (P2 `03` §8 keeps lease duration non-contract); only
 * the TTL/3 renewal-cadence convention is contract (P9 `03` §1). */
export const LEASE_TTL_MS = 30_000;
export const LEASE_RENEW_INTERVAL_MS = LEASE_TTL_MS / 3;

/** Bound the time between a durable StopExecution commit and interruption of
 * the running provider/tool fiber. Durable settlement remains owned by the
 * existing recovery path after the interruption. */
export const STOP_REQUEST_POLL_INTERVAL_MS = 100;

/** Test-child-only seam for proving real lease takeover without editing the
 * durable lease. Production Composition leaves this probe absent. */
export type ExecutionLeaseQualificationProbe = (
  event:
    | {
        readonly boundary: "AH10BeforeLeaseRenewal" | "AH10AfterLeaseAcquired";
        readonly executionId: ExecutionId;
        readonly workerId?: string;
        readonly workerIncarnationId?: string;
        readonly fencingGeneration: LeaseGeneration;
      }
    | {
        readonly boundary: "AH10BeforeLeaseAcquired";
        readonly executionId: ExecutionId;
      }
    | {
        /** Scheduler observed a live lease and skipped before runExecution. */
        readonly boundary: "AH10PreDispatchSkippedLiveLease";
        readonly executionId: ExecutionId;
      }
    | {
        /** Emitted only after this process's real LeaseService.acquire call rejects. */
        readonly boundary: "AH10LeaseAcquisitionRejected";
        readonly executionId: ExecutionId;
        readonly workerId: string;
        readonly workerIncarnationId: string;
        readonly fencingGeneration: LeaseGeneration;
      },
) => Promise<void>;

/** P2 `03` §7 / P9 `03` §1: the renewal CAS failed (stale generation / no
 * live lease) — the worker lost ownership, must stop durable mutation and
 * must not ordinary-retry. */
export interface LeaseLost {
  readonly _tag: "LeaseLost";
  readonly executionId: ExecutionId;
  readonly generation: LeaseGeneration;
}

/** One renewal CAS on (worker_id, generation) extending `expires_at`;
 * generation UNCHANGED, no new lease row identity (P2 `03` §2). A fencing
 * rejection maps to the local `LeaseLost`. */
export const renewLeaseOnce = (
  executionId: ExecutionId,
  workerId: string,
  workerIncarnationId: string,
  generation: LeaseGeneration,
): Effect.Effect<
  LeaseRecord,
  LeaseLost | ExecutionRepositoryError | TransactionOperationalFailure,
  TransactionPort | LeaseService
> =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const leases = yield* LeaseService;
    return yield* tx
      .transact(
        leases.renew(executionId, workerId, workerIncarnationId, generation),
      )
      .pipe(
        Effect.mapError(
          (
            error,
          ):
            | LeaseLost
            | ExecutionRepositoryError
            | TransactionOperationalFailure =>
            error._tag === "LeaseFencingRejected"
              ? { _tag: "LeaseLost", executionId, generation }
              : error,
        ),
      );
  });

/** P9 `03` §1: the renewal loop — every TTL/3 during a drive; bounded by
 * the drive lifetime (raced against it), never an independent daemon
 * thread. A drive shorter than one interval needs no renewal. */
export const leaseRenewalLoop = (
  executionId: ExecutionId,
  workerId: string,
  workerIncarnationId: string,
  generation: LeaseGeneration,
  intervalMs: number = LEASE_RENEW_INTERVAL_MS,
  qualificationProbe?: ExecutionLeaseQualificationProbe,
): Effect.Effect<
  never,
  LeaseLost | ExecutionRepositoryError | TransactionOperationalFailure,
  TransactionPort | LeaseService
> =>
  Effect.forever(
    Effect.gen(function* () {
      yield* Effect.sleep(intervalMs);
      if (qualificationProbe !== undefined) {
        yield* Effect.promise(() =>
          qualificationProbe({
            boundary: "AH10BeforeLeaseRenewal",
            executionId,
            fencingGeneration: generation,
          }),
        );
      }
      yield* renewLeaseOnce(
        executionId,
        workerId,
        workerIncarnationId,
        generation,
      );
    }),
  );

/** Read the durable stop fence while an Execution is running. This loop only
 * interrupts the in-flight driver; it deliberately does not settle the
 * Execution, so ProviderRuntime cancellation and unresolved-side-effect
 * recovery keep their existing ownership and fail-closed rules. */
export const stopRequestLoop = (
  executionId: ExecutionId,
  intervalMs: number = STOP_REQUEST_POLL_INTERVAL_MS,
  onStop?: () => void,
): Effect.Effect<
  { readonly _tag: "StopRequestedByControl" },
  ExecutionRepositoryError | TransactionOperationalFailure,
  TransactionPort | ExecutionRepository
> =>
  Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(intervalMs);
      const tx = yield* TransactionPort;
      const repository = yield* ExecutionRepository;
      const current = yield* tx.transact(repository.findById(executionId));
      if (Option.isSome(current) && current.value.stopRequestedAt !== null) {
        onStop?.();
        return {
          _tag: "StopRequestedByControl" as const,
        };
      }
    }
  });
