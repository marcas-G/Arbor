import {
  type CanonicalProviderEvent,
  Clock,
  IdGenerator,
  type ProviderCancellationSignal,
  type ProviderContinuationCheckpoint,
  type ProviderExecutionContext,
  type ProviderFailure,
  ProviderPort,
  type ProviderRunInput,
  type ProviderRunResult,
  ProviderRuntime,
  type ProviderRuntimeService,
  ProviderTurnStore,
  providerRetryCauseFromAttempt,
  RuntimeClock,
  SecretStorePort,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer, Option, Result } from "effect";
import {
  DEFAULT_PROVIDER_EXECUTION_POLICY,
  decideProviderRetry,
  mergeAttemptObservation,
  noAttemptObservation,
  resolveProviderExecutionPolicy,
  unknownAttemptObservation,
} from "./policy.js";
import {
  awaitAbort,
  consumeAttempt,
  initialAttemptObservation,
} from "./runtime/attempt-stream.js";
import type { ProviderRuntimeConfig } from "./runtime/config.js";
import {
  parseManifestIdentity,
  semanticOutputVisible,
} from "./runtime/continuation-evidence.js";
import { timeoutFailure, unknownFailure } from "./runtime/failures.js";
import { discoverProviderRecovery } from "./runtime/recovery.js";

export type { ProviderRuntimeConfig } from "./runtime/config.js";
export { decodeContinuationPrefix } from "./runtime/continuation-evidence.js";

export const ProviderRuntimeLive = (
  config: ProviderRuntimeConfig = {},
): Layer.Layer<
  ProviderRuntime,
  never,
  | ProviderPort
  | ProviderTurnStore
  | TransactionPort
  | Clock
  | SecretStorePort
  | IdGenerator
  | RuntimeClock
> =>
  Layer.effect(
    ProviderRuntime,
    Effect.gen(function* () {
      const provider = yield* ProviderPort;
      const store = yield* ProviderTurnStore;
      const tx = yield* TransactionPort;
      const clock = yield* Clock;
      const ids = yield* IdGenerator;
      const runtimeClock = yield* RuntimeClock;
      const secretStore = yield* SecretStorePort;
      const notifyProgress = (
        input: ProviderRunInput,
        event: Parameters<NonNullable<ProviderRunInput["onProgress"]>>[0],
      ): void => {
        try {
          input.onProgress?.(event);
        } catch {
          // A transient UI observer must never change model or execution
          // semantics.
        }
      };

      const runTurn: ProviderRuntimeService["runTurn"] = (
        input: ProviderRunInput,
      ) =>
        Effect.gen(function* () {
          let policy = resolveProviderExecutionPolicy({
            systemDefault:
              config.systemDefault ?? DEFAULT_PROVIDER_EXECUTION_POLICY,
            ...(config.providerDefault === undefined
              ? {}
              : { providerDefault: config.providerDefault }),
            ...(input.executionPolicyOverrides === undefined
              ? {}
              : {
                  modelDeploymentOverride: input.executionPolicyOverrides,
                }),
          });
          let turnDeadlineAtMs =
            runtimeClock.epochMillis() + policy.turnTimeoutMs;
          let turnDeadlineAt = new Date(turnDeadlineAtMs).toISOString();
          let firstAttemptNo = 0;
          let resumeCheckpoint: ProviderContinuationCheckpoint | null =
            input.recovery?.continuationCheckpoint ?? null;
          const controller = new (
            globalThis as unknown as {
              readonly AbortController: new () => {
                readonly signal: ProviderCancellationSignal;
                abort(): void;
              };
            }
          ).AbortController();
          const externalSignal = input.cancellationSignal;
          const relayAbort = () => controller.abort();
          if (externalSignal?.aborted) controller.abort();
          else
            externalSignal?.addEventListener("abort", relayAbort, {
              once: true,
            });
          let turnStarted = false;
          let turnSettled = false;
          const isSummaryCompaction =
            input.request.requestVersion === 2 &&
            input.request.operationKind === "CompactionSummary";
          const summaryProbeIdentity = {
            providerTurnId: String(input.providerTurnId),
            executionId: String(input.executionId),
          };
          let activeAttemptNo: number | null = null;
          let activeObservation = unknownAttemptObservation();
          let activeEvents: ReadonlyArray<CanonicalProviderEvent> = [];
          let activeCheckpoint: ProviderContinuationCheckpoint | null = null;
          let lastKnownFailure: ProviderFailure | null = null;
          const removeExternalAbort = () =>
            externalSignal?.removeEventListener("abort", relayAbort);

          const persistCancelled = () =>
            Effect.gen(function* () {
              controller.abort();
              const settledAt = yield* clock.now();
              if (activeAttemptNo !== null) {
                const decision = decideProviderRetry({
                  cause: { _tag: "Cancelled" },
                  observation: activeObservation,
                  continuationCheckpoint: activeCheckpoint,
                  attemptNo: activeAttemptNo,
                  maxAttempts: policy.maxAttempts,
                  cancelled: true,
                  deadlineExpired: false,
                });
                yield* tx.transact(
                  store.settleAttempt(
                    input.providerTurnId,
                    activeAttemptNo,
                    {
                      outcome: "Cancelled",
                      providerErrorKind: "Cancelled",
                      taxonomyVersion: "phase1-v2",
                      observation: activeObservation,
                      ...(activeCheckpoint === null
                        ? {}
                        : { continuationCheckpoint: activeCheckpoint }),
                      canonicalEventPrefixJson: JSON.stringify(activeEvents),
                      deliveredPosition: 0,
                      retryDecision: decision,
                    },
                    settledAt,
                  ),
                );
                activeAttemptNo = null;
              }
              if (turnStarted && !turnSettled) {
                yield* tx.transact(
                  store.settleTurn(
                    input.providerTurnId,
                    "Cancelled",
                    "{}",
                    settledAt,
                  ),
                );
                turnSettled = true;
              }
              removeExternalAbort();
            });

          const operation = Effect.gen(function* () {
            const manifestIdentity = yield* parseManifestIdentity(input);
            const discovered = yield* discoverProviderRecovery(
              input,
              externalSignal,
              config,
              tx,
              store,
              clock,
              runtimeClock,
              (successEvidence) => {
                activeAttemptNo = successEvidence.attemptNo;
                activeObservation = successEvidence.observation;
                activeEvents = successEvidence.events;
                turnStarted = true;
              },
              () => {
                activeAttemptNo = null;
                turnSettled = true;
                removeExternalAbort();
              },
            );
            if (discovered._tag === "Recovered") return discovered.result;
            const { recovery, recoveryTurn } = discovered;
            if (recovery !== undefined) {
              resumeCheckpoint = recovery.continuationCheckpoint ?? null;
            }
            let manifestId: string;
            if (recovery !== undefined) {
              const existing =
                recoveryTurn ??
                (yield* tx.transact(
                  store.findUnsettledByTurn(input.providerTurnId),
                ));
              if (
                existing === null ||
                existing.manifestJson !== input.manifestJson ||
                existing.portableRequestJson !==
                  JSON.stringify(input.request) ||
                existing.turn.manifestId !== recovery.manifestId ||
                existing.turn.executionId !== input.executionId ||
                existing.turn.sessionId !== input.sessionId ||
                existing.turn.contextEpoch !== input.contextEpoch ||
                existing.turn.modelRef !== input.modelRef ||
                existing.turn.outputContractRef !== input.outputContractRef ||
                existing.turn.executionPolicy === undefined ||
                existing.turn.turnDeadlineAt === undefined
              ) {
                return yield* Effect.fail(
                  unknownFailure("provider-turn-recovery-binding-invalid"),
                );
              }
              const last = existing.attempts.at(-1);
              const expectedNextAttempt =
                last === undefined ? 0 : last.attemptNo + 1;
              if (
                recovery.nextAttemptNo !== expectedNextAttempt ||
                (last !== undefined &&
                  last.outcome !== "InProgress" &&
                  last.outcome !== "RetryableFailure")
              ) {
                return yield* Effect.fail(
                  unknownFailure("provider-turn-recovery-attempt-invalid"),
                );
              }
              policy = existing.turn.executionPolicy;
              turnDeadlineAt = existing.turn.turnDeadlineAt;
              turnDeadlineAtMs = Date.parse(turnDeadlineAt);
              const recoveryObservation =
                last === undefined
                  ? noAttemptObservation()
                  : (last.observation ?? unknownAttemptObservation());
              const recoveryCause = providerRetryCauseFromAttempt(last);
              const recheckedDecision = decideProviderRetry({
                cause: recoveryCause,
                observation: recoveryObservation,
                continuationCheckpoint: last?.continuationCheckpoint ?? null,
                attemptNo: last?.attemptNo ?? -1,
                maxAttempts: policy.maxAttempts,
                cancelled: false,
                deadlineExpired: turnDeadlineAtMs <= runtimeClock.epochMillis(),
              });
              if (
                recheckedDecision.decision !== "Retry" ||
                recheckedDecision.decision !==
                  recovery.retryDecision.decision ||
                recheckedDecision.safety !== recovery.retryDecision.safety ||
                recheckedDecision.strategy !==
                  recovery.retryDecision.strategy ||
                recheckedDecision.reason !== recovery.retryDecision.reason ||
                (recovery.retryDecision.strategy === "Resume" &&
                  JSON.stringify(last?.continuationCheckpoint) !==
                    JSON.stringify(recovery.continuationCheckpoint))
              ) {
                return yield* Effect.fail(
                  unknownFailure("provider-turn-recovery-decision-stale"),
                );
              }
              manifestId = existing.turn.manifestId;
              firstAttemptNo = recovery.nextAttemptNo;
              turnStarted = true;
            } else {
              manifestId = `mft_${yield* ids.generate<string>("provider-manifest")}`;
              const startedAt = yield* clock.now();
              const turnRecord = {
                providerTurnId: input.providerTurnId,
                executionId: input.executionId,
                sessionId: input.sessionId,
                contextEpoch: input.contextEpoch,
                modelRef: input.modelRef,
                outputContractRef: input.outputContractRef,
                manifestId,
                executionPolicy: policy,
                turnDeadlineAt,
              };
              const receipt = yield* tx.transact(
                Effect.gen(function* () {
                  const started = yield* store.startTurnWithManifest(
                    turnRecord,
                    input.manifestJson,
                    JSON.stringify(input.request),
                    startedAt,
                  );
                  if (
                    isSummaryCompaction &&
                    config.qualificationProbe !== undefined
                  ) {
                    yield* Effect.promise(async () => {
                      await config.qualificationProbe?.({
                        boundary: "AH18BeforeSummaryTurnCommit",
                        ...summaryProbeIdentity,
                      });
                    });
                  }
                  return started;
                }),
              );
              if (
                receipt.providerTurnId !== input.providerTurnId ||
                receipt.manifestId !== manifestId
              ) {
                return yield* Effect.fail(
                  unknownFailure("manifest-receipt-mismatch"),
                );
              }
              if (
                isSummaryCompaction &&
                config.qualificationProbe !== undefined
              ) {
                yield* Effect.promise(async () => {
                  await config.qualificationProbe?.({
                    boundary: "AH18AfterSummaryTurnCommit",
                    ...summaryProbeIdentity,
                  });
                });
              }
              turnStarted = true;
            }
            void manifestIdentity;

            const authResult = yield* Effect.timeoutOption(
              Effect.gen(function* () {
                return input.secretRef === undefined
                  ? undefined
                  : yield* secretStore.resolve(input.secretRef);
              }),
              Math.max(1, turnDeadlineAtMs - runtimeClock.epochMillis()),
            );
            if (Option.isNone(authResult)) {
              const settledAt = yield* clock.now();
              yield* tx.transact(
                store.settleTurn(
                  input.providerTurnId,
                  "TurnDeadline",
                  "{}",
                  settledAt,
                ),
              );
              turnSettled = true;
              return yield* Effect.fail(timeoutFailure("TurnDeadline"));
            }
            const secretMaterial = authResult.value;
            const retryDecisions =
              recovery === undefined ? [] : [recovery.retryDecision];

            for (
              let attemptNo = firstAttemptNo;
              attemptNo < policy.maxAttempts;
              attemptNo += 1
            ) {
              if (controller.signal.aborted) return yield* Effect.interrupt;
              if (runtimeClock.epochMillis() >= turnDeadlineAtMs) {
                const settledAt = yield* clock.now();
                yield* tx.transact(
                  store.settleTurn(
                    input.providerTurnId,
                    "TurnDeadline",
                    "{}",
                    settledAt,
                  ),
                );
                turnSettled = true;
                return yield* Effect.fail(timeoutFailure("TurnDeadline"));
              }
              const attemptStartedAt = yield* clock.now();
              const resumeFrom = resumeCheckpoint;
              resumeCheckpoint = null;
              activeAttemptNo = attemptNo;
              activeObservation = initialAttemptObservation();
              activeEvents = [];
              activeCheckpoint = null;
              // Durable InProgress is committed before ProviderPort is invoked.
              yield* tx.transact(
                store.startAttempt(
                  input.providerTurnId,
                  attemptNo,
                  activeObservation,
                  attemptStartedAt,
                ),
              );
              notifyProgress(input, {
                _tag: "AttemptStarted",
                providerTurnId: input.providerTurnId,
                attemptNo,
              });
              const context: ProviderExecutionContext = {
                providerTurnId: input.providerTurnId,
                attemptNo,
                ...(input.secretRef === undefined
                  ? {}
                  : { secretRef: input.secretRef }),
                ...(secretMaterial === undefined ? {} : { secretMaterial }),
                cancellationSignal: controller.signal,
                turnDeadlineAt,
                ...(resumeFrom === null
                  ? {}
                  : { continuationCheckpoint: resumeFrom }),
              };
              const consumed = yield* Effect.result(
                consumeAttempt(
                  provider,
                  input,
                  context,
                  externalSignal,
                  policy,
                  turnDeadlineAtMs,
                  config,
                  { store, tx, clock, runtimeClock },
                  () => controller.abort(),
                  (state) => {
                    activeObservation = state.observation;
                    activeEvents = [...state.events];
                    activeCheckpoint = state.checkpoint;
                  },
                ),
              );
              const settledAt = yield* clock.now();
              if (Result.isFailure(consumed)) {
                const failure = consumed.failure;
                yield* tx.transact(
                  store.settleAttempt(
                    input.providerTurnId,
                    attemptNo,
                    {
                      outcome: "TerminalFailure",
                      providerErrorKind:
                        failure._tag === "ProviderFailure"
                          ? failure.kind
                          : "UnknownProviderFailure",
                      taxonomyVersion: "phase1-v2",
                      observation: activeObservation,
                      ...(activeCheckpoint === null
                        ? {}
                        : { continuationCheckpoint: activeCheckpoint }),
                      canonicalEventPrefixJson: JSON.stringify(activeEvents),
                      deliveredPosition: 0,
                      retryDecision: {
                        safety: "UnsafeReplay",
                        decision: "Stop",
                        strategy: null,
                        reason:
                          "attempt persistence or stream processing failed; fail closed",
                      },
                    },
                    settledAt,
                  ),
                );
                activeAttemptNo = null;
                return yield* Effect.fail(failure);
              }
              const attempt = consumed.success;
              if (attempt._tag === "Success") {
                const visible = semanticOutputVisible(attempt.events);
                const finalObservation = mergeAttemptObservation(
                  activeObservation,
                  { consumerVisibleOutput: visible },
                );
                activeObservation = finalObservation;
                activeEvents = [...attempt.events];
                const finishedAt = yield* clock.now();
                if (config.qualificationProbe !== undefined) {
                  yield* Effect.promise(
                    () =>
                      config.qualificationProbe?.({
                        boundary: "AH12BeforeSuccessCommit",
                        providerTurnId: input.providerTurnId,
                        attemptNo,
                      }) ?? Promise.resolve(),
                  );
                }
                yield* tx.transact(
                  store.settleSuccessAtomically(
                    input.providerTurnId,
                    attemptNo,
                    {
                      outcome: "Success",
                      taxonomyVersion: "phase1-v2",
                      observation: finalObservation,
                      ...(activeCheckpoint === null
                        ? {}
                        : { continuationCheckpoint: activeCheckpoint }),
                      canonicalEventPrefixJson: JSON.stringify(attempt.events),
                      deliveredPosition: attempt.events.length,
                    },
                    attempt.finishReason,
                    attempt.usageJson,
                    finishedAt,
                    "provider-success-v1",
                  ),
                );
                if (config.qualificationProbe !== undefined) {
                  yield* Effect.promise(
                    () =>
                      config.qualificationProbe?.({
                        boundary: "AH12AfterSuccessCommit",
                        providerTurnId: input.providerTurnId,
                        attemptNo,
                      }) ?? Promise.resolve(),
                  );
                }
                activeAttemptNo = null;
                turnSettled = true;
                removeExternalAbort();
                return {
                  events: attempt.events,
                  attemptNo,
                  retryDecisions,
                } satisfies ProviderRunResult;
              }

              if (attempt._tag === "Timeout") {
                controller.abort();
                const decision = decideProviderRetry({
                  cause: { _tag: "Timeout", phase: attempt.phase },
                  observation: activeObservation,
                  continuationCheckpoint: activeCheckpoint,
                  attemptNo,
                  maxAttempts: policy.maxAttempts,
                  cancelled: false,
                  deadlineExpired: attempt.phase === "TurnDeadline",
                });
                retryDecisions.push(decision);
                yield* tx.transact(
                  store.settleAttempt(
                    input.providerTurnId,
                    attemptNo,
                    {
                      outcome: "TimedOut",
                      taxonomyVersion: "phase1-v2",
                      observation: activeObservation,
                      ...(activeCheckpoint === null
                        ? {}
                        : { continuationCheckpoint: activeCheckpoint }),
                      canonicalEventPrefixJson: JSON.stringify(activeEvents),
                      deliveredPosition: 0,
                      retryDecision: decision,
                    },
                    settledAt,
                  ),
                );
                activeAttemptNo = null;
                yield* tx.transact(
                  store.settleTurn(
                    input.providerTurnId,
                    attempt.phase,
                    "{}",
                    settledAt,
                  ),
                );
                turnSettled = true;
                removeExternalAbort();
                return yield* Effect.fail(timeoutFailure(attempt.phase));
              }

              lastKnownFailure = attempt.failure;
              const cancelled = attempt.failure.kind === "Cancelled";
              const decision = decideProviderRetry({
                cause: {
                  _tag: "ProviderFailure",
                  kind: attempt.failure.kind,
                },
                observation: activeObservation,
                continuationCheckpoint: activeCheckpoint,
                attemptNo,
                maxAttempts: policy.maxAttempts,
                cancelled,
                deadlineExpired: runtimeClock.epochMillis() >= turnDeadlineAtMs,
              });
              retryDecisions.push(decision);
              const outcome = cancelled
                ? "Cancelled"
                : decision.decision === "Retry"
                  ? "RetryableFailure"
                  : "TerminalFailure";
              const terminalAttemptSettlement = {
                outcome,
                providerErrorKind: attempt.failure.kind,
                taxonomyVersion: "phase1-v2",
                observation: activeObservation,
                ...(activeCheckpoint === null
                  ? {}
                  : { continuationCheckpoint: activeCheckpoint }),
                canonicalEventPrefixJson: JSON.stringify(activeEvents),
                deliveredPosition: 0,
                retryDecision: decision,
              } as const;
              if (
                outcome === "TerminalFailure" &&
                config.qualificationProbe !== undefined
              ) {
                yield* Effect.promise(async () => {
                  await config.qualificationProbe?.({
                    boundary: "RAI-DG02BeforeFinalAttemptSettlementCommit",
                    providerTurnId: input.providerTurnId,
                    attemptNo,
                    failureKind: attempt.failure.kind,
                  });
                });
              }
              yield* tx.transact(
                store.settleAttempt(
                  input.providerTurnId,
                  attemptNo,
                  terminalAttemptSettlement,
                  settledAt,
                ),
              );
              if (
                outcome === "TerminalFailure" &&
                config.qualificationProbe !== undefined
              ) {
                yield* Effect.promise(async () => {
                  await config.qualificationProbe?.({
                    boundary: "RAI-DG02AfterFinalAttemptSettlementCommit",
                    providerTurnId: input.providerTurnId,
                    attemptNo,
                    failureKind: attempt.failure.kind,
                  });
                });
              }
              if (
                outcome === "RetryableFailure" &&
                isSummaryCompaction &&
                config.qualificationProbe !== undefined
              ) {
                yield* Effect.promise(async () => {
                  await config.qualificationProbe?.({
                    boundary: "AH18AfterSummaryRetryableFailureCommit",
                    ...summaryProbeIdentity,
                    attemptNo,
                    failureKind: attempt.failure.kind,
                  });
                });
              }
              activeAttemptNo = null;
              notifyProgress(input, {
                _tag: "AttemptFailed",
                providerTurnId: input.providerTurnId,
                attemptNo,
                failureKind: attempt.failure.kind,
                retrying:
                  decision.decision === "Retry" &&
                  attemptNo + 1 < policy.maxAttempts,
              });
              if (cancelled) {
                yield* tx.transact(
                  store.settleTurn(
                    input.providerTurnId,
                    "Cancelled",
                    "{}",
                    settledAt,
                  ),
                );
                turnSettled = true;
                removeExternalAbort();
                return yield* Effect.interrupt;
              }
              if (decision.decision === "Stop") {
                // ProviderAttempt is terminal, but the Driver/recovery owner
                // still decides the ProviderTurn-level failure disposition.
                removeExternalAbort();
                return yield* Effect.fail(attempt.failure);
              }

              resumeCheckpoint =
                decision.strategy === "Resume" ? activeCheckpoint : null;

              if (attemptNo + 1 >= policy.maxAttempts) {
                return yield* Effect.fail(attempt.failure);
              }
              const backoffMs = Math.min(
                policy.retryBackoffMs,
                Math.max(0, turnDeadlineAtMs - runtimeClock.epochMillis()),
              );
              if (backoffMs > 0) {
                const waitResult = yield* Effect.timeoutOption(
                  Effect.sleep(backoffMs),
                  Math.max(1, turnDeadlineAtMs - runtimeClock.epochMillis()),
                );
                if (Option.isNone(waitResult)) {
                  const backoffAt = yield* clock.now();
                  yield* tx.transact(
                    store.settleTurn(
                      input.providerTurnId,
                      "TurnDeadline",
                      "{}",
                      backoffAt,
                    ),
                  );
                  turnSettled = true;
                  removeExternalAbort();
                  return yield* Effect.fail(timeoutFailure("TurnDeadline"));
                }
              }
            }

            const failure =
              lastKnownFailure ??
              unknownFailure("provider-attempt-budget-exhausted");
            return yield* Effect.fail(failure);
          });

          const guarded = Effect.onInterrupt(
            Effect.raceFirst(
              operation,
              externalSignal === undefined
                ? Effect.never
                : awaitAbort(externalSignal).pipe(
                    Effect.flatMap(() => Effect.interrupt),
                  ),
            ),
            () => persistCancelled(),
          );
          return yield* guarded.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                controller.abort();
                removeExternalAbort();
              }),
            ),
          );
        });

      return ProviderRuntime.of({ runTurn });
    }),
  );
