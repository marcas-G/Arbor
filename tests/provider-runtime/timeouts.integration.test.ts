// Provider Runtime staged timeouts — moved verbatim from
// provider-runtime-phase1.integration.test.ts (B5 split).

import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import {
  P16_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import type { ProviderRuntimeExecutionPolicy } from "../../packages/ports/src/index.js";
import {
  client,
  deferred,
  initialize,
  makeHarness,
  providerTurnId,
  readAttempt,
  readTurn,
  runtimeEffect,
  SEMANTIC_TEST_POLICY,
  seed,
  waitForSignal,
  withWatchdog,
} from "./support.js";

describe("Provider Runtime Phase 1 — real Runtime + controlled OpenAI Adapter", () => {
  it.each([
    ["connect", "connect", "ConnectTimeout"],
    ["first event", "first-event", "FirstEventTimeout"],
    ["stream idle", "stream-idle", "StreamIdleTimeout"],
    ["whole turn deadline", "turn-deadline", "TurnDeadline"],
  ] as const)(
    "%s timeout aborts the Adapter and has a distinct durable terminal outcome",
    async (_label, mode, phase) => {
      const sdkDispatched = deferred<{
        readonly signal: AbortSignal;
        readonly order: number;
      }>();
      const phaseStarted = deferred<{
        readonly signal: AbortSignal;
        readonly stage: string;
        readonly order: number;
      }>();
      const timeoutRegistered = deferred<{
        readonly durationMs: number;
        readonly sequence: number;
        readonly stage: string;
        readonly order: number;
      }>();
      const sleepRegistrations: Array<{
        readonly durationMs: number;
        readonly sequence: number;
        readonly stage: string;
        readonly order: number;
      }> = [];
      let order = 0;
      let stage = "pre-dispatch";
      let controlledTime = 0;
      let adapterCalls = 0;
      const policy: ProviderRuntimeExecutionPolicy = {
        connectTimeoutMs: mode === "connect" ? 35 : 400,
        firstEventTimeoutMs: mode === "first-event" ? 35 : 400,
        streamIdleTimeoutMs: mode === "stream-idle" ? 35 : 400,
        turnTimeoutMs: mode === "turn-deadline" ? 180 : 800,
        maxAttempts: 2,
        retryBackoffMs: 0,
      };
      const timerExpectation =
        phase === "ConnectTimeout"
          ? {
              durationMs: policy.connectTimeoutMs,
              sequence: 1,
              stage: "connect-wait",
            }
          : phase === "FirstEventTimeout"
            ? {
                durationMs: policy.firstEventTimeoutMs,
                sequence: 2,
                stage: "response-started",
              }
            : phase === "StreamIdleTimeout"
              ? {
                  durationMs: policy.streamIdleTimeoutMs,
                  sequence: 3,
                  stage: "text-delta",
                }
              : {
                  durationMs: policy.turnTimeoutMs,
                  sequence: 1,
                  stage: "sdk-dispatched",
                };
      const harness = makeHarness(
        client({
          onCall: ({ context }) => {
            adapterCalls += 1;
            stage = "sdk-dispatched";
            sdkDispatched.resolve({
              signal: context.cancellationSignal as AbortSignal,
              order: ++order,
            });
          },
          stream: async function* ({ context }) {
            if (mode !== "connect") yield { type: "response_started" };
            if (mode !== "connect") stage = "response-started";
            if (mode === "stream-idle") {
              yield { type: "text", text: "first data" };
              stage = "text-delta";
            }
            if (mode === "connect") stage = "connect-wait";
            phaseStarted.resolve({
              signal: context.cancellationSignal as AbortSignal,
              stage,
              order: ++order,
            });
            await waitForSignal(context.cancellationSignal as AbortSignal);
          },
        }),
        policy,
        {
          controlledClock: true,
          onClockSleep: (durationMs, sequence) => {
            const registration = {
              durationMs,
              sequence,
              stage,
              order: ++order,
            };
            sleepRegistrations.push(registration);
            if (
              registration.durationMs === timerExpectation.durationMs &&
              registration.stage === timerExpectation.stage
            ) {
              timeoutRegistered.resolve(registration);
            }
          },
        },
      );
      try {
        const timeout = (await harness.run(
          Effect.gen(function* () {
            yield* runMigrations(P16_MIGRATIONS);
            yield* seed;
            controlledTime = Date.now();
            yield* TestClock.setTime(controlledTime);
            const fiber = yield* Effect.forkChild(Effect.flip(runtimeEffect()));
            try {
              const dispatch = yield* Effect.promise(() =>
                withWatchdog(sdkDispatched.promise, "provider SDK dispatch"),
              );
              const phaseHandshake = yield* Effect.promise(() =>
                withWatchdog(phaseStarted.promise, "provider timeout phase"),
              );
              expect(phaseHandshake.signal).toBe(dispatch.signal);
              expect(dispatch.order).toBeLessThan(phaseHandshake.order);
              const timer = yield* Effect.promise(() =>
                withWatchdog(timeoutRegistered.promise, "timeout registration"),
              );
              if (phase === "TurnDeadline") {
                expect(dispatch.order).toBeLessThan(timer.order);
                const turnDeadlineAt = readTurn(
                  harness.databaseFile,
                )?.turn_deadline_at;
                expect(turnDeadlineAt).toBeDefined();
                expect(Date.parse(turnDeadlineAt as string)).toBe(
                  controlledTime + policy.turnTimeoutMs,
                );
              } else {
                expect(phaseHandshake.order).toBeLessThan(timer.order);
              }
              expect(readAttempt(harness.databaseFile)).toMatchObject({
                outcome: "InProgress",
              });
              expect(readTurn(harness.databaseFile)?.finish_reason).toBeNull();
              expect(dispatch.signal.aborted).toBe(false);
              expect(
                sleepRegistrations.filter(
                  (registration) =>
                    registration.sequence === timerExpectation.sequence &&
                    registration.durationMs === timerExpectation.durationMs &&
                    registration.stage === timerExpectation.stage,
                ),
              ).toHaveLength(1);
              yield* TestClock.adjust(timerExpectation.durationMs + 1);
              const joined = yield* Effect.raceFirst(
                Fiber.join(fiber),
                Effect.callback<never, Error>((resume) => {
                  const timer = setTimeout(
                    () =>
                      resume(
                        Effect.fail(
                          new Error(
                            "Timed out waiting for provider runtime join after timeout",
                          ),
                        ),
                      ),
                    5_000,
                  );
                  return Effect.sync(() => clearTimeout(timer));
                }),
              );
              expect(timer).toMatchObject(timerExpectation);
              return {
                result: joined,
                adapterSignal: dispatch.signal,
              };
            } finally {
              yield* Fiber.interrupt(fiber);
            }
          }),
        )) as {
          readonly result: { readonly _tag: string; readonly phase?: string };
          readonly adapterSignal: AbortSignal;
        };
        expect(timeout.result).toMatchObject({
          _tag: "ProviderExecutionTimeout",
          phase,
        });
        expect(timeout.adapterSignal.aborted).toBe(true);
        expect(adapterCalls).toBe(1);
        const attempt = readAttempt(harness.databaseFile);
        expect(attempt?.outcome).toBe("TimedOut");
        expect(attempt?.retry_decision).toBe("Stop");
        expect(attempt?.retry_reason).toContain(`Timeout(${phase})`);
        expect(readAttempt(harness.databaseFile, 1)).toBeUndefined();
        expect(readTurn(harness.databaseFile)?.finish_reason).toBe(phase);
      } finally {
        rmSync(harness.root, { recursive: true, force: true });
      }
    },
  );

  it("cancellation during retry backoff prevents Attempt 1", async () => {
    const firstCall = deferred();
    const controller = new AbortController();
    let calls = 0;
    const harness = makeHarness(
      client({
        stream: async function* ({ context }) {
          calls += 1;
          firstCall.resolve();
          if (calls === 1) {
            throw Object.assign(new Error("connect reset"), {
              code: "ECONNRESET",
            });
          }
          yield { type: "response_started" };
          yield { type: "completed", finishReason: "stop" };
          void context;
        },
      }),
      { ...SEMANTIC_TEST_POLICY, retryBackoffMs: 500 },
    );
    try {
      await initialize(harness);
      const fiber = Effect.runFork(
        Effect.provide(runtimeEffect(controller.signal), harness.app) as never,
      );
      await firstCall.promise;
      const reader = new DatabaseSync(harness.databaseFile);
      try {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const row = reader
            .prepare(
              "SELECT outcome FROM provider_attempts WHERE provider_turn_id = ? AND attempt_no = 0",
            )
            .get(providerTurnId) as { outcome?: string } | undefined;
          if (row?.outcome === "RetryableFailure") break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      } finally {
        reader.close();
      }
      controller.abort();
      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(calls).toBe(1);
      expect(readAttempt(harness.databaseFile, 0)?.outcome).toBe(
        "RetryableFailure",
      );
      expect(readTurn(harness.databaseFile)?.finish_reason).toBe("Cancelled");
      expect(readAttempt(harness.databaseFile, 1)).toBeUndefined();
    } finally {
      controller.abort();
      rmSync(harness.root, { recursive: true, force: true });
    }
  });
});
