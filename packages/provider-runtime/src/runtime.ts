import {
  type CanonicalProviderEvent,
  Clock,
  type ProviderFailure,
  ProviderPort,
  type ProviderRunInput,
  ProviderRuntime,
  type ProviderRuntimeService,
  ProviderTurnStore,
  providerFailureDisposition,
  SecretStorePort,
  TransactionPort,
} from "@arbor/ports";
import { Context, Effect, Layer, Stream } from "effect";

/** P3 `06` §2 / P12 `12` §5 (TR-4): the single frozen retry disposition for
 * the closed `ProviderFailureKind` union. */
export const isRetryable = (failure: ProviderFailure): boolean =>
  providerFailureDisposition(failure.kind) === "retryable";

export const ProviderRuntimeLive = (
  maxAttempts = 3,
): Layer.Layer<
  ProviderRuntime,
  never,
  ProviderPort | ProviderTurnStore | TransactionPort | Clock | SecretStorePort
> =>
  Layer.effect(
    ProviderRuntime,
    Effect.gen(function* () {
      const provider = yield* ProviderPort;
      const store = yield* ProviderTurnStore;
      const tx = yield* TransactionPort;
      const clock = yield* Clock;
      const secretStore = yield* SecretStorePort;

      const runTurn: ProviderRuntimeService["runTurn"] = (
        input: ProviderRunInput,
      ) =>
        Effect.gen(function* () {
          // P12 `03` §2/§3: resolve the referenced credential at the execution
          // boundary. A missing / inaccessible / expired secret is a typed
          // failure — never silently substituted. The resolved material stays
          // inside the transport boundary (the Agent never sees it).
          const secretMaterial =
            input.secretRef === undefined
              ? undefined
              : yield* secretStore.resolve(input.secretRef);
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
                    ...(input.secretRef !== undefined
                      ? { secretRef: input.secretRef }
                      : {}),
                    ...(secretMaterial !== undefined ? { secretMaterial } : {}),
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
              // P12 `08` §7 D1 (B-4): surface the Turn-local attempt ordinal so
              // the caller can report real provider retries to the Runtime
              // Safety gate. No new ProviderTurn is created (DID §6A.9).
              return { events, attemptNo };
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
