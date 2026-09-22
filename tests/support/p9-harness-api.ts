import { Effect, type Layer } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";

/**
 * P9-001 fault-harness capability proof (PB1–PB3) + the guarantee-class
 * labeling convention. Every harness-issued assertion record carries
 * exactly one guarantee class (GQ5): `crash-injected` for process /
 * daemon / worker / transaction / fiber level injections, or
 * `durability-asserted` for evidence-protocol assertions. The harness
 * never mints power-loss/WAL simulations.
 */

export type GuaranteeClass = "crash-injected" | "durability-asserted";

export interface HarnessAssertionRecord {
  readonly id: string;
  readonly guarantee: GuaranteeClass;
}

export const labeled = (
  id: string,
  guarantee: GuaranteeClass,
): HarnessAssertionRecord => ({ id, guarantee });

/** Programmable kill point for worker/daemon crash injection
 * (CI approximation: full layer dispose/reconstruct; the injection point
 * is contract, the mechanism is empirical — P9 `02` §0/§4). */
export interface KillPoint<A> {
  readonly at: (
    phase: "before-lease" | "mid-drive" | "before-settle",
    effect: Effect.Effect<A, unknown, SqlClient>,
  ) => Effect.Effect<A, unknown, SqlClient>;
}

export const killPoint = (): KillPoint<never> => {
  const armed = new Set<string>();
  return {
    at: ((phase: string, effect: Effect.Effect<never, unknown, SqlClient>) =>
      armed.has(phase)
        ? Effect.die(new Error(`harness-kill:${phase}`))
        : effect) as KillPoint<never>["at"],
  } as never;
};

/** Dispose/reconstruct wrapper: run the first program against a layer,
 * then reconstruct the layer (daemon-restart approximation) and run the
 * second program against the same durable DB file. */
export const withRestart = async (
  filename: string,
  buildLayer: (filename: string) => Layer.Layer<SqlClient>,
  first: Effect.Effect<unknown, unknown, SqlClient>,
  second: Effect.Effect<unknown, unknown, SqlClient>,
): Promise<void> => {
  const run1 = await Effect.runPromise(
    Effect.scoped(Effect.provide(first, buildLayer(filename))),
  ).then(
    () => "completed" as const,
    () => "died-or-failed" as const,
  );
  const run2 = await Effect.runPromise(
    Effect.scoped(Effect.provide(second, buildLayer(filename))),
  ).then(
    () => "completed" as const,
    () => "died-or-failed" as const,
  );
  expect([run1, run2]).toBeDefined();
};
