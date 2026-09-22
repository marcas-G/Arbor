import type {
  CompletionConsumerDependencies,
  ConsumerLoopError,
  ConsumerLoopResult,
  ConsumerLoopStores,
  DriftError,
  DriftReport,
  EnvironmentDriftDeps,
  VerificationConsumerDependencies,
} from "@arbor/application";
import {
  completionConsumerLoop,
  pollOnce,
  probeDrift,
  verificationConsumerLoop,
} from "@arbor/application";
import type { Principal, ProjectId, ResourceAddress } from "@arbor/domain";
import { startupRecovery, sweepRecovery } from "@arbor/execution-runtime";
import { Effect } from "effect";

/**
 * P12 `10` §5 (F6) — deployment deliverables. Daemons are **composition-root
 * wiring** (`apps/*`), never new packages and never a second mutation face:
 * they submit through `CommandGateway` / Application ports (CI-1). The
 * consumer loops are offset-driven (P8 result; P9 `05`); the drift watcher is
 * a probe **trigger only** and never a truth source (P11 `05` §2).
 */

// --- production daemon -----------------------------------------------------

export interface RecoveryDaemon<R = never> {
  /** T1 (P9 `03` §2): startup full recovery pass, exactly once per daemon
   * start, before any new dispatch/admission. */
  readonly startup: Effect.Effect<void, unknown, R>;
  /** T2/T3 (P9 `03` §2): periodic / event-triggered sweeps. */
  readonly sweep: Effect.Effect<void, unknown, R>;
}

export const makeRecoveryDaemon = <R>(deps: {
  readonly startupRecovery: Effect.Effect<unknown, unknown, R>;
  readonly sweepRecovery: Effect.Effect<unknown, unknown, R>;
}): RecoveryDaemon<R> => ({
  startup: Effect.asVoid(deps.startupRecovery),
  sweep: Effect.asVoid(deps.sweepRecovery),
});

/** Binds the real P9 recovery passes (T1 startup + T2/T3 sweeps). The concrete
 * `R` is the slice's recovery capability set; the caller provides it. */
export const recoveryDaemonFromPrincipal = (principal: Principal) => ({
  startup: Effect.asVoid(startupRecovery(principal)),
  sweep: Effect.asVoid(sweepRecovery(principal)),
});

export interface ConsumerLoopDaemon<R = never> {
  readonly consumerId: string;
  readonly projectId: ProjectId;
  readonly batchSize: number;
  /** One offset-driven poll: read the batch after the stored offset, apply,
   * advance atomically (P1 `05` §4; P9 `05` §1). */
  readonly poll: Effect.Effect<ConsumerLoopResult, ConsumerLoopError, R>;
}

export const makeConsumerLoopDaemon = <R>(deps: {
  readonly consumerId: string;
  readonly projectId: ProjectId;
  readonly batchSize: number;
  readonly poll: Effect.Effect<ConsumerLoopResult, ConsumerLoopError, R>;
}): ConsumerLoopDaemon<R> => deps;

/** P8 consumer A (verification chain) wired onto the P1 offset infrastructure. */
export const verificationConsumerDaemon = <R>(deps: {
  readonly consumerId: string;
  readonly projectId: ProjectId;
  readonly batchSize: number;
  readonly stores: ConsumerLoopStores;
  readonly principal: Principal;
  readonly dependencies: VerificationConsumerDependencies<R>;
}): ConsumerLoopDaemon<R> =>
  makeConsumerLoopDaemon({
    consumerId: deps.consumerId,
    projectId: deps.projectId,
    batchSize: deps.batchSize,
    poll: pollOnce(deps.consumerId, deps.projectId, deps.batchSize, {
      ...deps.stores,
      handlers: verificationConsumerLoop(
        deps.projectId,
        deps.principal,
        deps.dependencies,
      ),
    }),
  });

/** P8 consumer B (completion chain) wired onto the P1 offset infrastructure. */
export const completionConsumerDaemon = (deps: {
  readonly consumerId: string;
  readonly projectId: ProjectId;
  readonly batchSize: number;
  readonly stores: ConsumerLoopStores;
  readonly principal: Principal;
  readonly dependencies: CompletionConsumerDependencies;
}): ConsumerLoopDaemon =>
  makeConsumerLoopDaemon({
    consumerId: deps.consumerId,
    projectId: deps.projectId,
    batchSize: deps.batchSize,
    poll: pollOnce(deps.consumerId, deps.projectId, deps.batchSize, {
      ...deps.stores,
      handlers: completionConsumerLoop(
        deps.projectId,
        deps.principal,
        deps.dependencies,
      ),
    }),
  });

// --- drift watcher trigger (probe only; never a truth source) --------------

export interface DriftWatcherTrigger {
  readonly trigger: (
    projectId: ProjectId,
    addresses: ReadonlyArray<ResourceAddress>,
  ) => Effect.Effect<DriftReport, DriftError>;
}

export const makeDriftWatcherTrigger = (deps: {
  readonly probe: (
    projectId: ProjectId,
    addresses: ReadonlyArray<ResourceAddress>,
  ) => Effect.Effect<DriftReport, DriftError>;
}): DriftWatcherTrigger => ({ trigger: deps.probe });

/** Binds the frozen `probeDrift` (P11 `05` §1). The watcher never advances the
 * anchor and never auto-submits by default; convergence stays governed. */
export const driftWatcherFromDeps = (
  deps: EnvironmentDriftDeps,
): DriftWatcherTrigger => ({
  trigger: (projectId, addresses) => probeDrift(projectId, addresses, deps),
});

// --- production daemon assembly --------------------------------------------

export interface ProductionDaemon<R = never> {
  /** Migrate the canonical store, then run the T1 startup recovery pass. */
  readonly start: Effect.Effect<void, unknown, R>;
  readonly recoveryTick: Effect.Effect<void, unknown, R>;
  /** Poll every offset-driven consumer loop exactly once. */
  readonly pollConsumers: Effect.Effect<
    ReadonlyArray<ConsumerLoopResult>,
    unknown,
    R
  >;
}

export const makeProductionDaemon = <R>(deps: {
  readonly migrate: Effect.Effect<unknown, unknown, R>;
  readonly recovery: RecoveryDaemon<R>;
  readonly consumers: ReadonlyArray<ConsumerLoopDaemon<R>>;
}): ProductionDaemon<R> => ({
  start: Effect.asVoid(
    Effect.flatMap(deps.migrate, () => deps.recovery.startup),
  ),
  recoveryTick: deps.recovery.sweep,
  pollConsumers: Effect.forEach(deps.consumers, (consumer) => consumer.poll, {
    concurrency: 1,
  }),
});
