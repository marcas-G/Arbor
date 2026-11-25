import {
  type CanonicalProviderEvent,
  cacheUsageGateViolation,
  canonicalUsageOfEvent,
  type ProviderAttemptObservation,
  type ProviderCancellationSignal,
  type ProviderContinuationCheckpoint,
  type ProviderExecutionContext,
  type ProviderExecutionTimeout,
  type ProviderFailure,
  type ProviderRunInput,
  type ProviderRuntimeExecutionPolicy,
  type RuntimeClockService,
  type TransactionOperationalFailure,
  UNKNOWN_USAGE,
} from "@arbor/ports";
import { Cause, Effect, Result, Stream } from "effect";
import { mergeAttemptObservation } from "../policy.js";
import type { ProviderRuntimeConfig } from "./config.js";
import {
  decodeContinuationPrefix,
  observationForContinuation,
  semanticOutputVisible,
} from "./continuation-evidence.js";
import {
  cancelledFailure,
  protocolFailure,
  unknownFailure,
} from "./failures.js";

type AttemptResult =
  | {
      readonly _tag: "Success";
      readonly events: ReadonlyArray<CanonicalProviderEvent>;
      readonly finishReason: string;
      readonly usageJson: string;
    }
  | { readonly _tag: "Failure"; readonly failure: ProviderFailure }
  | {
      readonly _tag: "Timeout";
      readonly phase: ProviderExecutionTimeout["phase"];
    };

export const initialAttemptObservation = (): ProviderAttemptObservation => ({
  responseStarted: false,
  canonicalEventEmitted: false,
  consumerVisibleOutput: false,
  toolCallProposed: false,
  continuationAvailable: false,
  externalEffectPossible: null,
});

export const awaitAbort = (
  signal: ProviderCancellationSignal,
): Effect.Effect<"Cancelled"> =>
  Effect.callback<"Cancelled">((resume) => {
    const onAbort = () => resume(Effect.succeed("Cancelled" as const));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

const timeoutPhase = (
  responseStarted: boolean,
  firstDataEventSeen: boolean,
): ProviderExecutionTimeout["phase"] =>
  !responseStarted
    ? "ConnectTimeout"
    : firstDataEventSeen
      ? "StreamIdleTimeout"
      : "FirstEventTimeout";

const phaseTimeoutMs = (
  policy: ProviderRuntimeExecutionPolicy,
  phase: ProviderExecutionTimeout["phase"],
): number => {
  switch (phase) {
    case "ConnectTimeout":
      return policy.connectTimeoutMs;
    case "FirstEventTimeout":
      return policy.firstEventTimeoutMs;
    case "StreamIdleTimeout":
      return policy.streamIdleTimeoutMs;
    case "TurnDeadline":
      return policy.turnTimeoutMs;
  }
};

export const consumeAttempt = (
  provider: import("@arbor/ports").ProviderPortService,
  input: ProviderRunInput,
  context: ProviderExecutionContext,
  callerCancellationSignal: ProviderCancellationSignal | undefined,
  policy: ProviderRuntimeExecutionPolicy,
  deadlineAtMs: number,
  runtimeConfig: ProviderRuntimeConfig,
  deps: {
    readonly store: import("@arbor/ports").ProviderTurnStoreService;
    readonly tx: import("@arbor/ports").TransactionPortService;
    readonly clock: import("@arbor/ports").ClockService;
    readonly runtimeClock: RuntimeClockService;
  },
  abortTransport: () => void,
  updateState: (input: {
    readonly observation: ProviderAttemptObservation;
    readonly events: ReadonlyArray<CanonicalProviderEvent>;
    readonly checkpoint: ProviderContinuationCheckpoint | null;
  }) => void,
): Effect.Effect<
  AttemptResult,
  ProviderFailure | TransactionOperationalFailure
> =>
  Effect.scoped(
    Effect.gen(function* () {
      let checkpoint = context.continuationCheckpoint ?? null;
      const prefix =
        checkpoint === null
          ? []
          : decodeContinuationPrefix(
              checkpoint,
              context.providerTurnId,
              context.attemptNo,
              runtimeConfig.continuationBinding,
            );
      if (prefix === null) {
        return {
          _tag: "Failure",
          failure: unknownFailure("provider-continuation-checkpoint-invalid"),
        } as const;
      }
      const source = provider.runTurn({ request: input.request, context });
      const pull = yield* Stream.toPull(source);
      const events: Array<CanonicalProviderEvent> = [...prefix];
      let observation =
        checkpoint === null
          ? initialAttemptObservation()
          : observationForContinuation(checkpoint);
      const attemptStartedAtMs = deps.runtimeClock.monotonicMillis();
      let responseStartedAtMs: number | null = null;
      let firstDataAtMs: number | null = null;
      let timeoutTriggeredPhase: ProviderExecutionTimeout["phase"] | null =
        null;
      let finishReason = "Stop";
      let completionSeen = false;
      let usage:
        | Extract<CanonicalProviderEvent, { readonly _tag: "UsageReported" }>
        | undefined;

      const persist = (nextObservation: ProviderAttemptObservation) =>
        Effect.gen(function* () {
          yield* deps.tx.transact(
            deps.store.updateAttemptObservation(
              input.providerTurnId,
              context.attemptNo,
              nextObservation,
              JSON.stringify(events),
              0,
              checkpoint,
              yield* deps.clock.now(),
            ),
          );
          observation = nextObservation;
          updateState({ observation, events, checkpoint });
        });

      const callerIsCancelled = () =>
        callerCancellationSignal?.aborted === true;

      if (checkpoint !== null) {
        yield* persist(observation);
      }

      while (true) {
        if (callerIsCancelled()) {
          return yield* Effect.interrupt;
        }
        const epochNow = deps.runtimeClock.epochMillis();
        const monotonicNow = deps.runtimeClock.monotonicMillis();
        const remainingTurnMs = deadlineAtMs - epochNow;
        if (remainingTurnMs <= 0) {
          return { _tag: "Timeout", phase: "TurnDeadline" };
        }

        const phase = timeoutPhase(
          responseStartedAtMs !== null,
          firstDataAtMs !== null,
        );
        const phaseStart =
          phase === "ConnectTimeout"
            ? attemptStartedAtMs
            : phase === "FirstEventTimeout"
              ? (responseStartedAtMs as number)
              : (firstDataAtMs as number);
        const remainingPhaseMs =
          phaseTimeoutMs(policy, phase) - (monotonicNow - phaseStart);
        if (remainingPhaseMs <= 0) {
          return { _tag: "Timeout", phase };
        }
        const timeoutMs = Math.max(
          1,
          Math.min(remainingPhaseMs, remainingTurnMs),
        );
        const deadlineWins = remainingTurnMs <= remainingPhaseMs;
        const pullEffect = Effect.map(Effect.result(pull), (result) => ({
          _tag: "Pulled" as const,
          result,
        }));
        const timeoutEffect = Effect.sleep(timeoutMs).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              timeoutTriggeredPhase = deadlineWins ? "TurnDeadline" : phase;
              abortTransport();
            }),
          ),
          Effect.as({ _tag: "Timeout" as const }),
        );
        const cancelEffect =
          callerCancellationSignal === undefined
            ? Effect.never.pipe(Effect.as({ _tag: "Cancelled" as const }))
            : awaitAbort(callerCancellationSignal).pipe(
                Effect.as({ _tag: "Cancelled" as const }),
              );
        const pulled = yield* Effect.raceFirst(
          pullEffect,
          Effect.raceFirst(timeoutEffect, cancelEffect),
        );
        if (pulled._tag === "Timeout") {
          return {
            _tag: "Timeout",
            phase: deadlineWins ? "TurnDeadline" : phase,
          };
        }
        if (pulled._tag === "Cancelled") {
          return yield* Effect.interrupt;
        }
        if (Result.isFailure(pulled.result)) {
          const error = pulled.result.failure;
          if (Cause.isDone(error)) break;
          if (timeoutTriggeredPhase !== null) {
            return { _tag: "Timeout", phase: timeoutTriggeredPhase };
          }
          if (callerIsCancelled()) {
            return { _tag: "Failure", failure: cancelledFailure() };
          }
          return { _tag: "Failure", failure: error as ProviderFailure };
        }

        for (const event of pulled.result.success) {
          if (event._tag === "Observation") {
            let nextObservation: ProviderAttemptObservation;
            try {
              nextObservation = mergeAttemptObservation(
                observation,
                event.delta,
              );
            } catch {
              return {
                _tag: "Failure",
                failure: unknownFailure("adapter-observation-invalid"),
              };
            }
            if (event.continuationCheckpoint !== undefined) {
              checkpoint = {
                ...event.continuationCheckpoint,
                canonicalEventPrefixJson: JSON.stringify(events),
                deliveredPosition: 0,
              };
            }
            yield* persist(nextObservation);
            if (event.delta.responseStarted === true) {
              responseStartedAtMs ??= deps.runtimeClock.monotonicMillis();
            }
            continue;
          }

          const canonical = event.event;
          if (canonical._tag === "TurnStarted" && checkpoint !== null) {
            // TurnStarted is attempt-local transport metadata. The logical
            // output already contains the original start from the durable
            // prefix, so do not return a duplicate start for the resumed call.
            if (canonical.providerTurnId !== context.providerTurnId) {
              return {
                _tag: "Failure",
                failure: protocolFailure(
                  "resumed-turn-start-identity-mismatch",
                ),
              };
            }
            continue;
          }
          if (canonical._tag === "TurnCompleted") {
            if (completionSeen) {
              return {
                _tag: "Failure",
                failure: protocolFailure("duplicate-turn-completion"),
              };
            }
            completionSeen = true;
          }
          const nextEvents = [...events, canonical];
          try {
            // Process-local presentation observer: isolated from provider
            // success semantics (same guarantee as runTurn-level taps).
            input.onProgress?.({
              _tag: "ProviderEvent",
              providerTurnId: context.providerTurnId,
              attemptNo: context.attemptNo,
              event: canonical,
            });
          } catch {
            // A transient UI observer must never change provider semantics.
          }
          let nextObservation = observation;
          if (canonical._tag !== "TurnStarted") {
            try {
              nextObservation = mergeAttemptObservation(observation, {
                canonicalEventEmitted: true,
                ...(canonical._tag === "ToolCallProposed"
                  ? { toolCallProposed: true }
                  : {}),
                ...(canonical._tag === "ContinuationState"
                  ? { continuationAvailable: true }
                  : {}),
              });
            } catch {
              return {
                _tag: "Failure",
                failure: unknownFailure("canonical-event-observation-invalid"),
              };
            }
          }
          if (canonical._tag === "UsageReported") {
            const violation = cacheUsageGateViolation(
              runtimeConfig.adapterUsageConstraints?.reportsCacheTokens ?? true,
              canonical,
            );
            if (violation !== undefined) {
              return {
                _tag: "Failure",
                failure: unknownFailure("usage-cache-capability-violation"),
              };
            }
            usage = canonical;
          }
          if (canonical._tag === "TurnCompleted") {
            finishReason = canonical.finishReason;
          }
          if (canonical._tag === "ContinuationState" && checkpoint !== null) {
            checkpoint = {
              ...checkpoint,
              canonicalEventPrefixJson: JSON.stringify(nextEvents),
            };
          }
          // Persist the observation and event prefix before accepting the
          // event into the successful result visible to the Agent Runtime.
          const priorEvents = events.splice(0, events.length, ...nextEvents);
          try {
            yield* persist(nextObservation);
          } catch (error) {
            events.splice(0, events.length, ...priorEvents);
            return yield* Effect.fail(error as ProviderFailure);
          }
          // A buffered SSE response can supply thousands of immediately
          // resolved chunks. Durably recording each delta is required, but
          // the consuming fiber must periodically yield so the execution's
          // concurrent lease-renewal timer can run during a long turn.
          if (events.length % 16 === 0) {
            yield* Effect.yieldNow;
          }
          if (canonical._tag !== "TurnStarted") {
            firstDataAtMs ??= deps.runtimeClock.monotonicMillis();
          }
        }
      }

      if (!completionSeen) {
        return {
          _tag: "Failure",
          failure: protocolFailure("provider-stream-missing-turn-completion"),
        };
      }

      const visibleObservation = mergeAttemptObservation(observation, {
        consumerVisibleOutput: semanticOutputVisible(events),
      });
      yield* persist(visibleObservation);
      return {
        _tag: "Success",
        events,
        finishReason,
        usageJson: JSON.stringify(
          usage === undefined ? UNKNOWN_USAGE : canonicalUsageOfEvent(usage),
        ),
      };
    }),
  );
