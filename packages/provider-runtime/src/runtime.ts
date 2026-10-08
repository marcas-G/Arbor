import {
  type CanonicalProviderEvent,
  Clock,
  cacheUsageGateViolation,
  canonicalUsageOfEvent,
  IdGenerator,
  PROVIDER_FAILURE_KINDS,
  type ProviderAttemptObservation,
  type ProviderCancellationSignal,
  type ProviderContinuationCheckpoint,
  type ProviderExecutionContext,
  type ProviderExecutionTimeout,
  type ProviderFailure,
  type ProviderFailureKind,
  ProviderPort,
  type ProviderRunInput,
  type ProviderRunResult,
  ProviderRuntime,
  type ProviderRuntimeExecutionPolicy,
  type ProviderRuntimeService,
  ProviderTurnStore,
  providerRetryCauseFromAttempt,
  RuntimeClock,
  type RuntimeClockService,
  SecretStorePort,
  type TransactionOperationalFailure,
  TransactionPort,
  UNKNOWN_USAGE,
  type UnsettledProviderTurn,
} from "@arbor/ports";
import { Cause, Effect, Layer, Option, Result, Stream } from "effect";
import {
  DEFAULT_PROVIDER_EXECUTION_POLICY,
  decideProviderRetry,
  mergeAttemptObservation,
  noAttemptObservation,
  resolveProviderExecutionPolicy,
  unknownAttemptObservation,
} from "./policy.js";

export interface ProviderRuntimeConfig {
  readonly systemDefault?: ProviderRuntimeExecutionPolicy;
  readonly providerDefault?: Partial<ProviderRuntimeExecutionPolicy>;
  /**
   * Gate C `03` §1.2/§1.3 (INV-C1-2): the adapter's declared usage
   * capabilities, supplied by the Composition Root from the resolved
   * binding's ProviderProfile. An adapter that declares
   * `reportsCacheTokens: false` must never emit cache token values —
   * violations fail the attempt closed.
   */
  readonly adapterUsageConstraints?: {
    readonly reportsCacheTokens: boolean;
  };
  /**
   * Gate C `03` §2.1 (C2): the binding identity a continuation checkpoint
   * must carry to be resumable; absent = legacy checkpoints are rejected
   * (stale continuation, never silently replayed).
   */
  readonly continuationBinding?: {
    readonly adapterId: string;
    readonly bindingFingerprint: string;
  };
  /** Explicit process-local crash qualification seam. Production Composition
   * leaves it absent; it is never sourced from a request or env var. */
  readonly qualificationProbe?: (
    event:
      | {
          readonly boundary:
            | "AH12BeforeSuccessCommit"
            | "AH12AfterSuccessCommit";
          readonly providerTurnId: string;
          readonly attemptNo: number;
        }
      | {
          readonly boundary:
            | "AH18BeforeSummaryTurnCommit"
            | "AH18AfterSummaryTurnCommit";
          readonly providerTurnId: string;
          readonly executionId: string;
        },
  ) => Promise<void>;
}

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

const timeoutFailure = (
  phase: ProviderExecutionTimeout["phase"],
): ProviderExecutionTimeout => ({ _tag: "ProviderExecutionTimeout", phase });

const unknownFailure = (safeDiagnostic: string): ProviderFailure => ({
  _tag: "ProviderFailure",
  kind: "UnknownProviderFailure",
  taxonomyVersion: "phase1-v2",
  safeDiagnostic,
});

const protocolFailure = (safeDiagnostic: string): ProviderFailure => ({
  _tag: "ProviderFailure",
  kind: "ProtocolViolation",
  taxonomyVersion: "phase1-v2",
  safeDiagnostic,
});

const cancelledFailure = (): ProviderFailure => ({
  _tag: "ProviderFailure",
  kind: "Cancelled",
  taxonomyVersion: "phase1-v2",
  safeDiagnostic: "provider-call-cancelled",
});

const stoppedRecoveryDecision = (reason: string) =>
  ({
    safety: "UnsafeReplay",
    decision: "Stop",
    strategy: null,
    reason,
  }) as const;

const initialAttemptObservation = (): ProviderAttemptObservation => ({
  responseStarted: false,
  canonicalEventEmitted: false,
  consumerVisibleOutput: false,
  toolCallProposed: false,
  continuationAvailable: false,
  externalEffectPossible: null,
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isCanonicalProviderEvent = (
  value: unknown,
): value is CanonicalProviderEvent => {
  if (!isRecord(value) || typeof value._tag !== "string") return false;
  switch (value._tag) {
    case "TurnStarted":
      return (
        typeof value.providerTurnId === "string" &&
        Number.isInteger(value.attemptNo) &&
        typeof value.modelRef === "string"
      );
    case "TextDelta":
    case "ReasoningDelta":
      return typeof value.text === "string";
    case "ToolCallProposed":
      return (
        typeof value.callRef === "string" &&
        typeof value.toolName === "string" &&
        typeof value.argumentsJson === "string"
      );
    case "UsageReported":
      return (
        typeof value.inputTokens === "number" &&
        Number.isFinite(value.inputTokens) &&
        typeof value.outputTokens === "number" &&
        Number.isFinite(value.outputTokens) &&
        (value.cacheReadTokens === undefined ||
          (typeof value.cacheReadTokens === "number" &&
            Number.isFinite(value.cacheReadTokens))) &&
        (value.cacheWriteTokens === undefined ||
          (typeof value.cacheWriteTokens === "number" &&
            Number.isFinite(value.cacheWriteTokens)))
      );
    case "ContinuationState":
      return typeof value.stateRef === "string";
    case "TurnCompleted":
      return (
        value.finishReason === "Stop" ||
        value.finishReason === "MaxOutputTokens" ||
        value.finishReason === "ToolCall" ||
        value.finishReason === "ContentFilter"
      );
    case "TurnFailed":
      return (
        typeof value.failureKind === "string" &&
        (PROVIDER_FAILURE_KINDS as ReadonlyArray<string>).includes(
          value.failureKind,
        )
      );
    default:
      return false;
  }
};

/** Exported for Gate C L2 qualification tests (continuation binding). */
export const decodeContinuationPrefix = (
  checkpoint: ProviderContinuationCheckpoint,
  providerTurnId: ProviderExecutionContext["providerTurnId"],
  attemptNo: number,
  continuationBinding?: ProviderRuntimeConfig["continuationBinding"],
): ReadonlyArray<CanonicalProviderEvent> | null => {
  // Gate C C2: a checkpoint must be bound to the producing adapter and
  // deployment. Missing or mismatched binding = stale continuation → reject.
  if (continuationBinding !== undefined) {
    if (
      checkpoint.adapterId !== continuationBinding.adapterId ||
      checkpoint.bindingFingerprint !== continuationBinding.bindingFingerprint
    ) {
      return null;
    }
  } else if (
    checkpoint.adapterId !== undefined ||
    checkpoint.bindingFingerprint !== undefined
  ) {
    return null;
  }
  try {
    const events: unknown = JSON.parse(checkpoint.canonicalEventPrefixJson);
    if (
      !Array.isArray(events) ||
      events.length === 0 ||
      !events.every(isCanonicalProviderEvent) ||
      events[0]?._tag !== "TurnStarted" ||
      events[0].providerTurnId !== providerTurnId ||
      events[0].attemptNo >= attemptNo ||
      events.some(
        (event) =>
          event._tag === "TurnCompleted" || event._tag === "TurnFailed",
      )
    ) {
      return null;
    }
    return events;
  } catch {
    return null;
  }
};

const observationForContinuation = (
  checkpoint: ProviderContinuationCheckpoint,
): ProviderAttemptObservation => ({
  // The new Attempt has not received a response or emitted a new canonical
  // event yet. The durable checkpoint separately carries the prior segment's
  // cursor/prefix proof, so another interruption can still resume safely.
  responseStarted: false,
  canonicalEventEmitted: false,
  consumerVisibleOutput:
    checkpoint.deliveredPosition !== null && checkpoint.deliveredPosition > 0,
  toolCallProposed: false,
  continuationAvailable: true,
  externalEffectPossible: false,
});

const semanticOutputVisible = (
  events: ReadonlyArray<CanonicalProviderEvent>,
): boolean =>
  events.some(
    (event) =>
      event._tag === "TextDelta" ||
      event._tag === "ReasoningDelta" ||
      event._tag === "ToolCallProposed",
  );

const parseManifestIdentity = (
  input: ProviderRunInput,
): Effect.Effect<
  {
    readonly compiledRequestHash: string;
  },
  ProviderFailure
> =>
  Effect.try({
    try: () => {
      const manifest = JSON.parse(input.manifestJson) as Record<
        string,
        unknown
      >;
      if (
        manifest.providerTurnId !== input.providerTurnId ||
        manifest.executionId !== input.executionId ||
        manifest.sessionId !== input.sessionId ||
        manifest.contextEpoch !== input.contextEpoch ||
        manifest.modelRef !== input.modelRef ||
        manifest.outputContractRef !== input.outputContractRef ||
        typeof manifest.compiledRequestHash !== "string"
      ) {
        throw new Error("manifest identity mismatch");
      }
      return { compiledRequestHash: manifest.compiledRequestHash };
    },
    catch: () => unknownFailure("model-context-manifest-invalid"),
  });

const awaitAbort = (
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

const consumeAttempt = (
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
            let recovery = input.recovery;
            let recoveryTurn: UnsettledProviderTurn | null = null;
            if (recovery === undefined) {
              if (externalSignal?.aborted === true) {
                return yield* Effect.interrupt;
              }
              recoveryTurn = yield* tx.transact(
                store.findUnsettledByTurn(input.providerTurnId),
              );
              if (recoveryTurn !== null) {
                if (
                  recoveryTurn.manifestJson !== input.manifestJson ||
                  recoveryTurn.portableRequestJson !==
                    JSON.stringify(input.request) ||
                  recoveryTurn.turn.executionId !== input.executionId ||
                  recoveryTurn.turn.sessionId !== input.sessionId ||
                  recoveryTurn.turn.contextEpoch !== input.contextEpoch ||
                  recoveryTurn.turn.modelRef !== input.modelRef ||
                  recoveryTurn.turn.outputContractRef !==
                    input.outputContractRef
                ) {
                  // A persisted turn is permanently pinned to its original
                  // manifest and portable request. A later model/provider
                  // configuration must never resume it under a new binding;
                  // close this stale Turn so it cannot remain an invisible
                  // recovery candidate after its owning execution fails.
                  yield* tx.transact(
                    store.failTurn(input.providerTurnId, yield* clock.now()),
                  );
                  return yield* Effect.fail(
                    unknownFailure("provider-turn-resume-binding-invalid"),
                  );
                }
                const last = recoveryTurn.attempts.at(-1) ?? null;
                const cause = providerRetryCauseFromAttempt(last);
                const observation =
                  last === null
                    ? noAttemptObservation()
                    : (last.observation ?? unknownAttemptObservation());
                const persistedPolicy = recoveryTurn.turn.executionPolicy;
                const persistedDeadline =
                  recoveryTurn.turn.turnDeadlineAt ?? null;
                const deadlineAtMs =
                  persistedDeadline === null
                    ? Number.NaN
                    : Date.parse(persistedDeadline);
                const retryDecision =
                  persistedPolicy === undefined ||
                  !Number.isFinite(deadlineAtMs)
                    ? stoppedRecoveryDecision(
                        "persisted attempt evidence or execution limits are incomplete",
                      )
                    : decideProviderRetry({
                        cause,
                        observation,
                        continuationCheckpoint:
                          last?.continuationCheckpoint ?? null,
                        attemptNo: last?.attemptNo ?? -1,
                        maxAttempts: persistedPolicy.maxAttempts,
                        cancelled: last?.outcome === "Cancelled",
                        deadlineExpired:
                          deadlineAtMs <= runtimeClock.epochMillis(),
                      });
                const decidedAt = yield* clock.now();
                const recordDecision = () =>
                  store.recordRecoveryDecision(input.providerTurnId, {
                    attemptNo: last?.attemptNo ?? -1,
                    cause,
                    retryDecision,
                    decidedAt,
                  });
                const settleLostAttempt = (
                  outcome: "RetryableFailure" | "TerminalFailure",
                ) =>
                  last?.outcome !== "InProgress"
                    ? Effect.void
                    : store.settleAttempt(
                        input.providerTurnId,
                        last.attemptNo,
                        {
                          outcome,
                          taxonomyVersion: "phase1-v2",
                          observation:
                            last.observation ?? unknownAttemptObservation(),
                          canonicalEventPrefixJson:
                            last.canonicalEventPrefixJson ?? "[]",
                          deliveredPosition: last.deliveredPosition ?? 0,
                          ...(last.continuationCheckpoint === null ||
                          last.continuationCheckpoint === undefined
                            ? {}
                            : {
                                continuationCheckpoint:
                                  last.continuationCheckpoint,
                              }),
                          retryDecision,
                        },
                        decidedAt,
                      );

                if (retryDecision.decision === "Stop") {
                  yield* tx.transact(
                    Effect.gen(function* () {
                      yield* recordDecision();
                      yield* settleLostAttempt("TerminalFailure");
                      yield* store.failTurn(input.providerTurnId, decidedAt);
                    }),
                  );
                  const kind = last?.providerErrorKind;
                  return yield* Effect.fail<ProviderFailure>(
                    kind === null || kind === undefined
                      ? unknownFailure("provider-turn-recovery-stopped")
                      : {
                          _tag: "ProviderFailure",
                          kind: kind as ProviderFailureKind,
                          ...(last?.taxonomyVersion === undefined
                            ? {}
                            : { taxonomyVersion: last.taxonomyVersion }),
                          safeDiagnostic: "provider-turn-recovery-stopped",
                        },
                  );
                }

                yield* tx.transact(
                  Effect.gen(function* () {
                    yield* recordDecision();
                    yield* settleLostAttempt("RetryableFailure");
                  }),
                );
                recovery = {
                  manifestId: recoveryTurn.turn.manifestId,
                  nextAttemptNo: last === null ? 0 : last.attemptNo + 1,
                  retryDecision,
                  ...(retryDecision.strategy === "Resume" &&
                  last?.continuationCheckpoint !== null &&
                  last?.continuationCheckpoint !== undefined
                    ? { continuationCheckpoint: last.continuationCheckpoint }
                    : {}),
                };
              }
            }
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
              const isSummaryCompaction =
                input.request.requestVersion === 2 &&
                input.request.operationKind === "CompactionSummary";
              const summaryProbeIdentity = {
                providerTurnId: String(input.providerTurnId),
                executionId: String(input.executionId),
              };
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
              yield* tx.transact(
                store.settleAttempt(
                  input.providerTurnId,
                  attemptNo,
                  {
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
                  },
                  settledAt,
                ),
              );
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
