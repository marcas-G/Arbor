import { ExecutionId, parse } from "@arbor/domain";
import { RuntimeSafetyGate, type RuntimeSafetyGateService } from "@arbor/ports";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import {
  RuntimeSafetyGateLive,
  type RuntimeSafetyPolicy,
} from "../src/runtime-safety.js";

const executionId = parse(ExecutionId)(
  "exe_00000000-0000-7000-8000-0000000000d1",
);
const turn = (fingerprint: string) => ({
  _tag: "ProviderTurn" as const,
  fingerprint,
});
const action = (fingerprint: string) => ({
  _tag: "ToolInvocation" as const,
  fingerprint,
});
const policy: RuntimeSafetyPolicy = {
  maxRetries: 3,
  maxRepeatedFingerprints: 1,
  maxRecursionDepth: 8,
  maxNoProgressTurns: 1,
  concurrencyCeiling: 16,
  rateLimit: 100,
  rateWindowMs: 60_000,
};

const runGate = (
  body: (
    gate: RuntimeSafetyGateService,
  ) => Effect.Effect<ReadonlyArray<string>>,
) =>
  Effect.gen(function* () {
    const gate = yield* RuntimeSafetyGate;
    return yield* body(gate);
  }).pipe(Effect.provide(RuntimeSafetyGateLive(policy)));

describe("-DG-01 shared D2/D4 durable progress observation", () => {
  it.effect("one true observation clears D2 and resets D4 together", () =>
    Effect.gen(function* () {
      const decisions = yield* runGate((gate) =>
        Effect.gen(function* () {
          return [
            yield* gate.admitActivity(executionId, action("same")),
            yield* gate.admitActivity(executionId, turn("t1"), {
              durableProgress: false,
            }),
            yield* gate.admitActivity(executionId, turn("t2"), {
              durableProgress: true,
            }),
            yield* gate.admitActivity(executionId, action("same")),
            yield* gate.admitActivity(executionId, turn("t3"), {
              durableProgress: false,
            }),
            yield* gate.admitActivity(executionId, turn("t4"), {
              durableProgress: false,
            }),
          ];
        }),
      );
      expect(decisions).toEqual([
        "Continue",
        "Continue",
        "Continue",
        "Continue",
        "Continue",
        "Stop",
      ]);
    }),
  );

  it.effect(
    "false and absent preserve D2 and count as D4 no-progress boundaries",
    () =>
      Effect.gen(function* () {
        const decisions = yield* runGate((gate) =>
          Effect.gen(function* () {
            return [
              yield* gate.admitActivity(executionId, action("same")),
              yield* gate.admitActivity(executionId, turn("t1"), {
                durableProgress: false,
              }),
              yield* gate.admitActivity(executionId, action("same")),
              yield* gate.admitActivity(executionId, turn("t2")),
            ];
          }),
        );
        expect(decisions).toEqual(["Continue", "Continue", "Stop", "Stop"]);
      }),
  );
});
