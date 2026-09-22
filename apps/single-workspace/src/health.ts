import {
  HealthPort,
  P12_MIGRATION_BASELINE,
  PersistenceHealthProbe,
  type PersistenceHealthProbeService,
  type ReadinessState,
} from "@arbor/ports";
import { Context, Effect, Layer, Ref } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

/**
 * B-8 — the production `HealthPort` adapter.
 *
 * P12 `04` §4 (E-17): health is a read-only derived operational surface. The
 * adapter lives at the composition-root contract boundary (it is NOT placed in
 * `projection-runtime`, so `apps/*` needs no projection dependency to reach
 * it). Readiness is derived exclusively from the injected
 * `PersistenceHealthProbe`, which reads the canonical DB `PRAGMA user_version`
 * and the T1 startup-recovery state — never a telemetry service.
 */

/**
 * The T1 startup-recovery completion state (P12 `04` §4; P9 `03` §2 T1). The
 * production daemon marks it complete exactly once after the startup recovery
 * pass, before any new dispatch or admission. It is a read-only flag for the
 * health probe; it is never an authority input (CI-3).
 */
export class T1RecoveryState extends Context.Service<
  T1RecoveryState,
  {
    readonly complete: Effect.Effect<boolean>;
    readonly markComplete: Effect.Effect<void>;
  }
>()("arbor/T1RecoveryState") {}

export const T1RecoveryStateLive: Layer.Layer<T1RecoveryState> = Layer.effect(
  T1RecoveryState,
  Effect.gen(function* () {
    const ref = yield* Ref.make(false);
    return {
      complete: Ref.get(ref),
      markComplete: Ref.set(ref, true),
    };
  }),
);

/**
 * `ready ⇔ dbOpen ∧ migrationBaseline ∧ t1RecoveryComplete` (P12 `04` §4).
 * `E = never`: a health probe reports `false` dimensions, it does not fail.
 */
export const PersistenceHealthProbeSqliteLive: Layer.Layer<
  PersistenceHealthProbe,
  never,
  SqlClient | T1RecoveryState
> = Layer.effect(
  PersistenceHealthProbe,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const recovery = yield* T1RecoveryState;
    return PersistenceHealthProbe.of({
      probe: () =>
        Effect.gen(function* () {
          const userVersion = yield* Effect.match(
            sql.unsafe<{ user_version: number }>("PRAGMA user_version"),
            {
              onFailure: () => null,
              onSuccess: (rows) => Number(rows[0]?.user_version ?? -1),
            },
          );
          const dbOpen = userVersion !== null;
          const migrationBaseline = userVersion === P12_MIGRATION_BASELINE;
          const t1RecoveryComplete = yield* recovery.complete;
          return {
            dbOpen,
            migrationBaseline,
            t1RecoveryComplete,
          } satisfies ReadinessState;
        }),
    } satisfies PersistenceHealthProbeService);
  }),
);

/** The production `HealthPort`: liveness + readiness over the probe only. */
export const ProductionHealthPortLive: Layer.Layer<
  HealthPort,
  never,
  PersistenceHealthProbe
> = Layer.effect(
  HealthPort,
  Effect.gen(function* () {
    const probe = yield* PersistenceHealthProbe;
    return {
      liveness: () => Effect.succeed({ processAlive: true } as const),
      readiness: () => probe.probe(),
    };
  }),
);
