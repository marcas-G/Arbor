import {
  HealthPort,
  PersistenceHealthProbe,
  type ReadinessState,
} from "@arbor/ports";
import { Effect, Layer } from "effect";

/**
 * P12 `04` §4 (E-17, E-16): the HealthPort implementation.
 *
 * Health is read-only derived state; it never mutates canonical state and is
 * never an authority input (CI-3). `readiness()` reads exclusively the
 * injected `PersistenceHealthProbe.probe()` — `PersistenceHealthProbe` is the
 * only capability in its `R` channel; no telemetry / observability service is
 * reachable from it.
 */

/** `ready ⇔ dbOpen ∧ migrationBaseline ∧ t1RecoveryComplete`. */
export const isReady = (state: ReadinessState): boolean =>
  state.dbOpen && state.migrationBaseline && state.t1RecoveryComplete;

export const HealthPortLive: Layer.Layer<
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
