import { Context, type Effect } from "effect";

export interface ClockService {
  readonly now: () => Effect.Effect<string, never>;
}

export class Clock extends Context.Service<Clock, ClockService>()(
  "arbor/Clock",
) {}

export interface RuntimeClockService {
  /** Epoch milliseconds for persisted absolute deadlines and recovery. */
  readonly epochMillis: () => number;
  /** Monotonic milliseconds for in-process elapsed timeout phases. */
  readonly monotonicMillis: () => number;
}

export class RuntimeClock extends Context.Service<
  RuntimeClock,
  RuntimeClockService
>()("arbor/RuntimeClock") {}

export interface IdGeneratorService {
  readonly generate: <T>(kind: string) => Effect.Effect<T, never>;
}

export class IdGenerator extends Context.Service<
  IdGenerator,
  IdGeneratorService
>()("arbor/IdGenerator") {}
