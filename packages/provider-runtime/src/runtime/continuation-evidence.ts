import { canonicalUsageOfEvent, PROVIDER_FAILURE_KINDS, sha256Hex, UNKNOWN_USAGE, type CanonicalProviderEvent, type ProviderAttemptObservation, type ProviderAttemptSummary, type ProviderContinuationCheckpoint, type ProviderExecutionContext, type ProviderRunInput, type UnsettledProviderTurn } from "@arbor/ports";
import { Effect } from "effect";
import type { ProviderFailure } from "@arbor/ports";
import { unknownFailure } from "./failures.js";
import type { ProviderRuntimeConfig } from "./config.js";

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

export interface CompleteNativeSuccessEvidence {
  readonly attemptNo: number;
  readonly observation: ProviderAttemptObservation;
  readonly canonicalEventPrefixJson: string;
  readonly deliveredPosition: number;
  readonly events: ReadonlyArray<CanonicalProviderEvent>;
  readonly finishReason: "Stop";
  readonly usageJson: string;
}

export const completeNativeSuccessEvidence = (
  entry: UnsettledProviderTurn,
  input: ProviderRunInput,
  continuationBinding: ProviderRuntimeConfig["continuationBinding"],
): CompleteNativeSuccessEvidence | null => {
  const attempt: ProviderAttemptSummary | undefined = entry.attempts.at(-1);
  if (
    attempt === undefined ||
    attempt.outcome !== "InProgress" ||
    attempt.observation === undefined ||
    attempt.observation === null ||
    attempt.canonicalEventPrefixJson === undefined ||
    attempt.deliveredPosition !== 0 ||
    (attempt.continuationCheckpoint !== null &&
      attempt.continuationCheckpoint !== undefined) ||
    attempt.observation.responseStarted !== true ||
    attempt.observation.canonicalEventEmitted !== true ||
    attempt.observation.consumerVisibleOutput !== false ||
    attempt.observation.toolCallProposed !== false ||
    attempt.observation.continuationAvailable !== true ||
    attempt.observation.externalEffectPossible !== false ||
    continuationBinding === undefined ||
    entry.manifestJson === null ||
    entry.portableRequestJson === null ||
    input.request.requestVersion !== 2 ||
    input.request.operationKind !== "CompactionNative" ||
    input.outputContractRef !== "provider-native-compaction-v1"
  ) {
    return null;
  }
  try {
    const manifest = JSON.parse(entry.manifestJson) as unknown;
    const request = JSON.parse(entry.portableRequestJson) as unknown;
    const parsedEvents = JSON.parse(
      attempt.canonicalEventPrefixJson,
    ) as unknown;
    if (
      !isRecord(manifest) ||
      !isRecord(request) ||
      !Array.isArray(parsedEvents) ||
      !parsedEvents.every(isCanonicalProviderEvent)
    ) {
      return null;
    }
    const events = parsedEvents as ReadonlyArray<CanonicalProviderEvent>;
    const starts = events.filter((event) => event._tag === "TurnStarted");
    const completed = events.filter((event) => event._tag === "TurnCompleted");
    const continuations = events.filter(
      (event) => event._tag === "ContinuationState",
    );
    const usageEvents = events.filter(
      (event) => event._tag === "UsageReported",
    );
    const usageEvent = usageEvents[0];
    if (
      entry.turn.providerTurnId !== input.providerTurnId ||
      entry.turn.executionId !== input.executionId ||
      entry.turn.sessionId !== input.sessionId ||
      entry.turn.contextEpoch !== input.contextEpoch ||
      entry.turn.modelRef !== input.modelRef ||
      entry.turn.outputContractRef !== "provider-native-compaction-v1" ||
      manifest.providerTurnId !== input.providerTurnId ||
      manifest.executionId !== input.executionId ||
      manifest.sessionId !== input.sessionId ||
      manifest.contextEpoch !== input.contextEpoch ||
      manifest.modelRef !== input.modelRef ||
      manifest.outputContractRef !== "provider-native-compaction-v1" ||
      manifest.operationKind !== "CompactionNative" ||
      manifest.resolvedModelBindingFingerprint !==
        continuationBinding.bindingFingerprint ||
      manifest.compiledRequestHash !== sha256Hex(entry.portableRequestJson) ||
      request.requestVersion !== 2 ||
      request.operationKind !== "CompactionNative" ||
      request.modelRef !== input.modelRef ||
      request.outputContractRef !== "provider-native-compaction-v1" ||
      !Array.isArray(request.inputItems) ||
      !Array.isArray(request.instructions) ||
      !Array.isArray(request.toolDefinitions) ||
      !Array.isArray(request.cacheHints) ||
      starts.length !== 1 ||
      starts[0] !== events[0] ||
      starts[0]?._tag !== "TurnStarted" ||
      starts[0].providerTurnId !== input.providerTurnId ||
      starts[0].attemptNo !== attempt.attemptNo ||
      starts[0].modelRef !== input.modelRef ||
      completed.length !== 1 ||
      completed[0] !== events.at(-1) ||
      completed[0]?._tag !== "TurnCompleted" ||
      completed[0].finishReason !== "Stop" ||
      continuations.length !== 1 ||
      continuations[0]?._tag !== "ContinuationState" ||
      continuations[0].stateRef.length === 0 ||
      usageEvents.length > 1 ||
      events.some(
        (event) =>
          event._tag !== "TurnStarted" &&
          event._tag !== "ContinuationState" &&
          event._tag !== "UsageReported" &&
          event._tag !== "TurnCompleted",
      )
    ) {
      return null;
    }
    return {
      attemptNo: attempt.attemptNo,
      observation: attempt.observation,
      canonicalEventPrefixJson: attempt.canonicalEventPrefixJson,
      deliveredPosition: events.length,
      events,
      finishReason: "Stop",
      usageJson: JSON.stringify(
        usageEvent === undefined
          ? UNKNOWN_USAGE
          : canonicalUsageOfEvent(usageEvent),
      ),
    };
  } catch {
    return null;
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

export const observationForContinuation = (
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

export const semanticOutputVisible = (
  events: ReadonlyArray<CanonicalProviderEvent>,
): boolean =>
  events.some(
    (event) =>
      event._tag === "TextDelta" ||
      event._tag === "ReasoningDelta" ||
      event._tag === "ToolCallProposed",
  );

export const parseManifestIdentity = (
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

