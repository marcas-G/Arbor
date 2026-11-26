// Provider Runtime retry backoff and turn deadline — moved verbatim from
// provider-runtime-phase1.integration.test.ts (B5 split).

import { rmSync } from "node:fs";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
  P16_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  client,
  deferred,
  makeHarness,
  providerTurnId,
  readAttempt,
  readTurn,
  runtimeEffect,
  SEMANTIC_TEST_POLICY,
  seed,
  withWatchdog,
} from "./support.js";

describe("Provider Runtime Phase 1 — real Runtime + controlled OpenAI Adapter", () => {
  it("turn deadline covers retry backoff and prevents a later attempt", async () => {
    const attemptStarted = deferred();
    const adapterStarted = deferred();
    const attemptFailed = deferred();
    const backoffRegistered = deferred();
    let failureObserved = false;
    let calls = 0;
    let adapterCalls = 0;
    const harness = makeHarness(
      client({
        onCall: () => {
          adapterCalls += 1;
          adapterStarted.resolve();
        },
        stream: async function* () {
          calls += 1;
          if (calls === 1) {
            throw Object.assign(new Error("pre-response reset"), {
              code: "ECONNRESET",
            });
          }
          yield { type: "response_started" };
          yield { type: "completed", finishReason: "stop" };
        },
      }),
      {
        ...SEMANTIC_TEST_POLICY,
        connectTimeoutMs: 500,
        firstEventTimeoutMs: 500,
        streamIdleTimeoutMs: 500,
        turnTimeoutMs: 120,
        maxAttempts: 3,
        retryBackoffMs: 500,
      },
      {
        controlledClock: true,
        onClockSleep: () => {
          if (failureObserved) backoffRegistered.resolve();
        },
      },
    );
    try {
      const failure = (await harness.run(
        Effect.gen(function* () {
          yield* runMigrations(P16_MIGRATIONS);
          yield* seed;
          yield* TestClock.setTime(Date.now());
          const fiber = yield* Effect.forkChild(
            Effect.flip(
              runtimeEffect(undefined, undefined, providerTurnId, (event) => {
                if (event._tag === "AttemptStarted" && event.attemptNo === 0) {
                  attemptStarted.resolve();
                }
                if (event._tag === "AttemptFailed" && event.attemptNo === 0) {
                  failureObserved = true;
                  attemptFailed.resolve();
                }
              }),
            ),
          );
          yield* Effect.promise(() =>
            withWatchdog(attemptStarted.promise, "Attempt 0 start"),
          );
          yield* Effect.promise(() =>
            withWatchdog(adapterStarted.promise, "Adapter call"),
          );
          yield* Effect.promise(() =>
            withWatchdog(attemptFailed.promise, "Attempt 0 durable failure"),
          );
          expect(readAttempt(harness.databaseFile, 0)).toMatchObject({
            outcome: "RetryableFailure",
            retry_decision: "Retry",
          });
          yield* Effect.promise(() =>
            withWatchdog(backoffRegistered.promise, "retry backoff sleep"),
          );
          yield* TestClock.adjust(121);
          return yield* Fiber.join(fiber);
        }),
      )) as { readonly _tag: string; readonly phase?: string };
      expect(failure).toMatchObject({
        _tag: "ProviderExecutionTimeout",
        phase: "TurnDeadline",
      });
      expect(calls).toBe(1);
      expect(adapterCalls).toBe(1);
      expect(readAttempt(harness.databaseFile, 0)).toMatchObject({
        outcome: "RetryableFailure",
        retry_decision: "Retry",
      });
      expect(readAttempt(harness.databaseFile, 1)).toBeUndefined();
      expect(readTurn(harness.databaseFile)?.finish_reason).toBe(
        "TurnDeadline",
      );
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });
});
