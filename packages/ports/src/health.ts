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

export interface ReadinessState {
  /** Canonical DB connection is open (reopen / integrity_check path available). */
  readonly dbOpen: boolean;
  /** `PRAGMA user_version` equals {@link P12_MIGRATION_BASELINE}. */
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
