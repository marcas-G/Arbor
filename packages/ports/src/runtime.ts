import { Context, type Effect } from "effect";

export interface ClockService {
  readonly now: () => Effect.Effect<string, never>;
}

export class Clock extends Context.Service<Clock, ClockService>()(
  "arbor/Clock",
) {}

export interface IdGeneratorService {
  readonly generate: <T>(kind: string) => Effect.Effect<T, never>;
}

export class IdGenerator extends Context.Service<
  IdGenerator,
  IdGeneratorService
>()("arbor/IdGenerator") {}
