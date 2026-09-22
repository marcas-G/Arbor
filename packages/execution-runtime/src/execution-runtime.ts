import {
  CommandGateway,
  type CommandRejection,
  semanticRequestFingerprint,
  type VerifiedRuntimeCommandAuthority,
} from "@arbor/application";
import type {
  CommandSubmissionContext,
  ExecutionId,
  LeaseGeneration,
  Principal,
  WakeReason,
} from "@arbor/domain";
import {
  AgentExecutionStateStore,
  ExecutionDriverPort,
  ExecutionRepository,
  type ExecutionRepositoryError,
  type LeaseRecord,
  LeaseService,
  RuntimeSafetyGate,
  type TransactionOperationalFailure,
  TransactionPort,
  WorkerDispatchPort,
} from "@arbor/ports";
import { Effect, Option } from "effect";

/** Empirical TTL value (P2 `03` §8 keeps lease duration non-contract); only
 * the TTL/3 renewal-cadence convention is contract (P9 `03` §1). */
export const LEASE_TTL_MS = 30_000;
export const LEASE_RENEW_INTERVAL_MS = LEASE_TTL_MS / 3;

const WORKER_ID = "worker:local";

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
      .transact(leases.renew(executionId, workerId, generation))
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
  generation: LeaseGeneration,
  intervalMs: number = LEASE_RENEW_INTERVAL_MS,
): Effect.Effect<
  never,
  LeaseLost | ExecutionRepositoryError | TransactionOperationalFailure,
  TransactionPort | LeaseService
> =>
  Effect.forever(
    Effect.gen(function* () {
      yield* Effect.sleep(intervalMs);
      yield* renewLeaseOnce(executionId, workerId, generation);
    }),
  );

/**
 * Orchestration: durable admission already exists; dispatch, acquire a lease,
 * drive, and persist the driver's settlement proposal through the command
 * pipeline (ExecutionOrigin, fenced).
 */
export const runExecution = (
  executionId: ExecutionId,
  wakeReason: WakeReason,
  principal: Principal,
  renewIntervalMs: number = LEASE_RENEW_INTERVAL_MS,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const repository = yield* ExecutionRepository;
    const states = yield* AgentExecutionStateStore;
    const leases = yield* LeaseService;
    const dispatch = yield* WorkerDispatchPort;
    const driver = yield* ExecutionDriverPort;
    const safety = yield* RuntimeSafetyGate;
    const gateway = yield* CommandGateway;

    const execution = yield* tx.transact(repository.findById(executionId));
    if (Option.isNone(execution)) {
      return yield* Effect.fail({ _tag: "ExecutionNotFound" as const });
    }
    yield* dispatch.dispatch({
      executionId,
      workspaceId: execution.value.workspaceId,
      workerKind: "Agent",
    });
    const lease = yield* tx.transact(leases.acquire(executionId, WORKER_ID));
    const state = yield* tx.transact(states.find(executionId));
    // P9 `03` §1: race the drive against the renewal loop — the first to
    // complete wins; a lost renewal (LeaseLost) interrupts the drive so no
    // durable mutation is attempted, and no ordinary retry occurs.
    const settlement = yield* Effect.raceFirst(
      driver.drive({
        execution: execution.value,
        agentExecutionState: Option.getOrElse(state, () => ({
          executionId,
          focus: { _tag: "Coordination" as const },
          wakeReason,
          currentMode: null,
          activeSkillRefs: [],
          turnNo: 0,
          recentDirectiveRefs: [],
          recentActionFingerprints: [],
          updatedAt: "t",
        })),
        wakeReason,
        context: {
          _tag: "ExecutionOrigin",
          principal,
          executionId,
          fencingGeneration: lease.generation,
        },
        safetyGate: safety,
      }),
      leaseRenewalLoop(
        executionId,
        lease.workerId,
        lease.generation,
        renewIntervalMs,
      ),
    );

    const payload = {
      executionId,
      settlement,
      expectedFencingGeneration: lease.generation as LeaseGeneration,
    };
    const commandId = `cmd_settle_${executionId}_${lease.generation}` as never;
    const authority: VerifiedRuntimeCommandAuthority = {
      _tag: "SettleExecutionAuthority",
      submissionOrigin: "ExecutionOrigin",
      principal,
      commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "SettleExecution",
        projectId: execution.value.projectId,
        actor: principal as never,
        schemaVersion: "1",
        payload,
      }),
      projectId: execution.value.projectId,
      commandKind: "SettleExecution",
      executionId,
      fencingGeneration: lease.generation,
    };
    const context: CommandSubmissionContext = {
      _tag: "ExecutionOrigin",
      principal,
      executionId,
      fencingGeneration: lease.generation,
    };
    const receipt = yield* gateway.execute(
      {
        commandType: "SettleExecution",
        commandId,
        projectId: execution.value.projectId,
        actor: principal as never,
        issuedAt: "t",
        payload,
      },
      context,
      authority,
    );
    if (receipt.resolution._tag === "TerminalRejected") {
      return yield* Effect.fail(
        receipt.resolution.error as unknown as CommandRejection,
      );
    }
    // P9 `03` §1 soft release: worker-initiated CAS deleting the live lease
    // row's liveness. Release never settles the Execution and never changes
    // Work lifecycle (DID §6A.6); lazy invalidation remains the only
    // lease-expiry authority — a failed release is a lost optimization, not
    // a correctness failure.
    yield* tx
      .transact(leases.release(executionId, lease.workerId, lease.generation))
      .pipe(Effect.ignore);
    return settlement;
  });
