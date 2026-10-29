import { ExecutionId, parse } from "@arbor/domain";
import { RuntimeSafetyGate, type RuntimeSafetyGateService } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
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
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const gate = yield* RuntimeSafetyGate;
        return yield* body(gate);
      }),
      RuntimeSafetyGateLive(policy),
    ),
  );

describe("P12-DG-01 shared D2/D4 durable progress observation", () => {
  it("one true observation clears D2 and resets D4 together", async () => {
    const decisions = await runGate((gate) =>
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
  });

  it("false and absent preserve D2 and count as D4 no-progress boundaries", async () => {
    const decisions = await runGate((gate) =>
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
  });
});
