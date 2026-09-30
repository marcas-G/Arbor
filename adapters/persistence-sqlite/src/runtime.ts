import { Clock, IdGenerator, RuntimeClock } from "@arbor/ports";
import { Effect, Layer } from "effect";

const cryptoGlobal = globalThis as unknown as {
  readonly crypto: { randomUUID(): string };
  readonly performance: { now(): number };
};

export const ClockLive = Layer.succeed(Clock, {
  now: () => Effect.sync(() => new Date().toISOString()),
});

export const RuntimeClockLive = Layer.succeed(RuntimeClock, {
  epochMillis: () => Date.now(),
  monotonicMillis: () => cryptoGlobal.performance.now(),
});

export const RuntimeClockTest = (
  epochMillis: () => number,
  monotonicMillis: () => number = epochMillis,
): Layer.Layer<RuntimeClock> =>
  Layer.succeed(RuntimeClock, { epochMillis, monotonicMillis });

export const IdGeneratorLive = Layer.succeed(IdGenerator, {
  generate: <T>(_kind: string) =>
    Effect.sync(() => cryptoGlobal.crypto.randomUUID() as unknown as T),
});

export const ClockTest = (iso: string): Layer.Layer<Clock> =>
  Layer.succeed(Clock, { now: () => Effect.succeed(iso) });

export const IdGeneratorTest = (value: string): Layer.Layer<IdGenerator> =>
  Layer.succeed(IdGenerator, {
    generate: <T>(_kind: string) => Effect.succeed(value as unknown as T),
  });
