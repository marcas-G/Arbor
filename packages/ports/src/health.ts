import { Context, type Effect } from "effect";

/**
 * P12 `04` §4 (E-17; TR-6): the frozen DID §7.2 Port Catalog addition.
 *
 * `HealthPort` is a read-only derived operational surface. It never mutates
 * canonical state and is never an authority input (CI-3): no scheduler /
 * admission / authority decision may read it. Readiness is derived
 * exclusively from the injected `PersistenceHealthProbe` — never a telemetry
 * service.
 */

/** The P12 migration baseline (TR-7): `PRAGMA user_version == max(P12_MIGRATIONS)`. */
export const P12_MIGRATION_BASELINE = 13;

/** P14 migration baseline: `PRAGMA user_version == max(P14_MIGRATIONS)` = 14
 * (adds `human_messages`, P14 `01` §4). */
export const P14_MIGRATION_BASELINE = 14;

/** Provider Runtime Correctness Phase 1 migration baseline. */
export const P16_MIGRATION_BASELINE = 16;

/** DID v1.21 ALS-I1 AgentLoopStep migration baseline. */
export const P18_MIGRATION_BASELINE = 18;

/** DID v1.22 SCRC typed Session Timeline migration baseline. */
export const P19_MIGRATION_BASELINE = 19;
export const P20_MIGRATION_BASELINE = 20;
export const P21_MIGRATION_BASELINE = 21;
export const P22_MIGRATION_BASELINE = 22;
export const P23_MIGRATION_BASELINE = 23;
export const P24_MIGRATION_BASELINE = 24;
export const P25_MIGRATION_BASELINE = 25;
export const P26_MIGRATION_BASELINE = 26;
export const P27_MIGRATION_BASELINE = 27;
export const P28_MIGRATION_BASELINE = 28;
export const P29_MIGRATION_BASELINE = 29;
export const P34_MIGRATION_BASELINE = 34;
/** Current single-workspace production schema baseline. */
export const P35_MIGRATION_BASELINE = 35;
/** @deprecated historical name; baseline is P34. */
export const P32_MIGRATION_BASELINE = P34_MIGRATION_BASELINE;
/** @deprecated historical name; baseline is P34. */
export const P31_MIGRATION_BASELINE = P34_MIGRATION_BASELINE;
/** @deprecated historical name; baseline is P34. */
export const P30_MIGRATION_BASELINE = P34_MIGRATION_BASELINE;

/** @deprecated Legacy alias kept for compiled references; the baseline is P16. */
export const P15_MIGRATION_BASELINE = P16_MIGRATION_BASELINE;

export interface ReadinessState {
  /** Canonical DB connection is open (reopen / integrity_check path available). */
  readonly dbOpen: boolean;
  /** `PRAGMA user_version` equals the composition's current migration
   * baseline (currently {@link P35_MIGRATION_BASELINE}). */
  readonly migrationBaseline: boolean;
  /** The T1 startup recovery pass (SD §10.6; P9 `03` §2) has completed. */
  readonly t1RecoveryComplete: boolean;
}

/**
 * Narrow read-only capability: reports the current readiness dimensions.
 * `E = never` — a health probe reports `false` dimensions, it does not fail.
 * Never a telemetry service; never mutates canonical state.
 */
export interface PersistenceHealthProbeService {
  readonly probe: () => Effect.Effect<ReadinessState, never>;
}

export class PersistenceHealthProbe extends Context.Service<
  PersistenceHealthProbe,
  PersistenceHealthProbeService
>()("arbor/PersistenceHealthProbe") {}

export interface HealthPortService {
  readonly liveness: () => Effect.Effect<
    { readonly processAlive: true },
    never
  >;
  /**
   * `ready ⇔ dbOpen ∧ migrationBaseline ∧ t1RecoveryComplete`.
   * `PersistenceHealthProbe` is the only capability in its `R` channel.
   */
  readonly readiness: () => Effect.Effect<
    ReadinessState,
    never,
    PersistenceHealthProbe
  >;
}

export class HealthPort extends Context.Service<
  HealthPort,
  HealthPortService
>()("arbor/HealthPort") {}
