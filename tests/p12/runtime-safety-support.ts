import { Effect } from "effect";
import { it } from "vitest";
import {
  ExecutionId,
  LeaseGeneration,
  parse,
} from "../../packages/domain/dist/index.js";
import {
  RuntimeSafetyGateLive,
  type RuntimeSafetyPolicy,
} from "../../packages/execution-runtime/src/index.js";
import {
  type ExecutionActivity,
  RuntimeSafetyGate,
  type RuntimeSafetyGateService,
} from "../../packages/ports/src/index.js";

export const itWithCurrentAppTimeout = (
  name: string,
  body: () => Promise<unknown>,
) => it(name, body, 120_000);

export const exe = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
export const g1 = parse(LeaseGeneration)(1);
export const g2 = parse(LeaseGeneration)(2);

/** All dimensions finite; a test narrows exactly the dimension under test. */
export const policy = (
  overrides: Partial<RuntimeSafetyPolicy> = {},
): RuntimeSafetyPolicy => ({
  maxRetries: 100,
  maxRepeatedFingerprints: 100,
  maxRecursionDepth: 100,
  maxNoProgressTurns: 100,
  concurrencyCeiling: 100,
  rateLimit: 100,
  rateWindowMs: 1000,
  ...overrides,
});

export const runGate = <A>(
  p: RuntimeSafetyPolicy,
  body: (gate: RuntimeSafetyGateService) => Generator<unknown, A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* RuntimeSafetyGate;
      return yield* Effect.gen(
        () =>
          body(gate) as unknown as Generator<Effect.Effect<unknown>, A, never>,
      );
    }).pipe(Effect.provide(RuntimeSafetyGateLive(p))),
  ) as Promise<A>;

export const turn = (fingerprint: string): ExecutionActivity => ({
  _tag: "ProviderTurn",
  fingerprint,
});
export const tool = (fingerprint: string): ExecutionActivity => ({
  _tag: "ToolInvocation",
  fingerprint,
});
export const specialist = (fingerprint: string): ExecutionActivity => ({
  _tag: "SpecialistAction",
  fingerprint,
});
