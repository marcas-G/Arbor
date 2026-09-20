import {
  type CanonicalProviderEvent,
  Clock,
  type ProviderFailure,
  type ProviderFailureKind,
  ProviderPort,
  type ProviderRunInput,
  ProviderRuntime,
  type ProviderRuntimeService,
  ProviderTurnStore,
  TransactionPort,
} from "@arbor/ports";
import { Context, Effect, Layer, Stream } from "effect";

const RETRYABLE: ReadonlyArray<ProviderFailureKind> = [
  "RateLimited",
  "ProviderUnavailable",
  "StreamInterrupted",
];

export const isRetryable = (failure: ProviderFailure): boolean =>
  RETRYABLE.includes(failure.kind);

export const ProviderRuntimeLive = (
  maxAttempts = 3,
): Layer.Layer<
  ProviderRuntime,
  never,
  ProviderPort | ProviderTurnStore | TransactionPort | Clock
> =>
  Layer.effect(
    ProviderRuntime,
    Effect.gen(function* () {
      const provider = yield* ProviderPort;
      const store = yield* ProviderTurnStore;
      const tx = yield* TransactionPort;
      const clock = yield* Clock;

      const runTurn: ProviderRuntimeService["runTurn"] = (
        input: ProviderRunInput,
      ) =>
        Effect.gen(function* () {
          const startedAt = yield* clock.now();
          yield* tx.transact(
            store.startTurn(
              {
                providerTurnId: input.providerTurnId,
                executionId: input.executionId,
                sessionId: input.sessionId,
                contextEpoch: input.contextEpoch,
                modelRef: input.modelRef,
                outputContractRef: input.outputContractRef,
                manifestId: input.manifestId,
              },
              startedAt,
            ),
          );

          let lastFailure: ProviderFailure = {
            _tag: "ProviderFailure",
            kind: "ProviderUnavailable",
          };
          for (let attemptNo = 0; attemptNo < maxAttempts; attemptNo += 1) {
            const attemptStartedAt = yield* clock.now();
            const result = yield* Effect.result(
              Stream.runCollect(
                provider.runTurn({
                  request: input.request,
                  context: {
                    providerTurnId: input.providerTurnId,
                    attemptNo,
                    secretRef: input.secretRef,
                    timeoutMs: input.timeoutMs,
                    cancellationRef: input.cancellationRef,
                  },
                }),
              ),
            );
            const settledAt = yield* clock.now();
            if (result._tag === "Success") {
              const events = Array.from(result.success);
              yield* tx.transact(
                store.recordAttempt(
                  input.providerTurnId,
                  attemptNo,
                  { _tag: "Success" },
                  attemptStartedAt,
                  settledAt,
                ),
              );
              const usage = events.find(
                (event) => event._tag === "UsageReported",
              );
              const finish = events.find(
                (event) => event._tag === "TurnCompleted",
              );
              yield* tx.transact(
                store.settleTurn(
                  input.providerTurnId,
                  finish !== undefined && finish._tag === "TurnCompleted"
                    ? finish.finishReason
                    : "Stop",
                  JSON.stringify(usage ?? {}),
                  settledAt,
                ),
              );
              return events;
            }

            lastFailure = result.failure;
            const retryable = isRetryable(lastFailure);
            yield* tx.transact(
              store.recordAttempt(
                input.providerTurnId,
                attemptNo,
                {
                  _tag: retryable ? "RetryableFailure" : "TerminalFailure",
                  providerErrorKind: lastFailure.kind,
                },
                attemptStartedAt,
                settledAt,
              ),
            );
            if (!retryable) {
              return yield* Effect.fail(lastFailure);
            }
          }
          return yield* Effect.fail(lastFailure);
        });

      return ProviderRuntime.of({ runTurn });
    }),
  );
