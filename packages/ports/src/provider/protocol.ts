import type { ContextEpochNumber, ExecutionId, ProviderTurnId, SessionId } from "@arbor/domain";
import { Context, type Effect, type Stream } from "effect";
import type { ProviderExecutionTimeout, ProviderFailure, ProviderFailureKind, ProviderFailureTaxonomyVersion } from "../errors.js";
import type { TransactionOperationalFailure } from "../session.js";
import type { PortableModelRequest } from "./portable-request.js";
import type { SecretMaterial, SecretRef, SecretStoreError } from "./secrets.js";

/** Structural form of the standard Web AbortSignal contract. Keeping the
 * provider port independent of DOM/Node types still lets adapters pass the
 * signal unchanged to fetch and stream readers. */
export interface ProviderCancellationSignal {
  readonly aborted: boolean;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export interface ProviderExecutionContext {
  readonly providerTurnId: ProviderTurnId;
  readonly attemptNo: number;
  readonly secretRef?: SecretRef;
  /** Resolved credential (P12 `03` §1/§3): produced by ProviderRuntime at the
   * execution boundary and consumed by the transport adapter. Never persisted,
   * never logged, redacted by default under serialization. */
  readonly secretMaterial?: SecretMaterial;
  readonly cancellationSignal: ProviderCancellationSignal;
  /** ProviderRuntime-resolved terminal upper bound. Adapters may enforce this
   * at the transport edge, but never choose or reinterpret timeout policy. */
  readonly turnDeadlineAt: string;
  readonly continuationCheckpoint?: ProviderContinuationCheckpoint;
}

export type ProviderFinishReason =
  | "Stop"
  | "MaxOutputTokens"
  | "ToolCall"
  | "ContentFilter";

export const PROVIDER_FAILURE_KINDS = [
  "AuthenticationFailed",
  "AuthorizationFailed",
  "RateLimited",
  "QuotaExceeded",
  "ProviderUnavailable",
  "TransportFailed",
  "RequestRejected",
  "StreamInterrupted",
  "ContextLimitExceeded",
  "ProtocolViolation",
  "Cancelled",
  "UnknownProviderFailure",
] as const;

export type { ProviderFailureKind, ProviderFailureTaxonomyVersion };

export const PROVIDER_RETRY_ELIGIBLE_FAILURES = [
  "RateLimited",
  "ProviderUnavailable",
  "TransportFailed",
  "StreamInterrupted",
] as const satisfies ReadonlyArray<ProviderFailureKind>;

/** Compatibility classifier only; automatic retry uses durable observation
 * evidence through the shared RetryDecision policy. */
export const providerFailureDisposition = (
  kind: ProviderFailureKind,
): "retryable" | "terminal" =>
  (
    PROVIDER_RETRY_ELIGIBLE_FAILURES as ReadonlyArray<ProviderFailureKind>
  ).includes(kind)
    ? "retryable"
    : "terminal";

export type ObservationFact = boolean | null;

/** `null` means unknown and must fail closed during retry classification. */
export interface ProviderAttemptObservation {
  readonly responseStarted: ObservationFact;
  readonly canonicalEventEmitted: ObservationFact;
  readonly consumerVisibleOutput: ObservationFact;
  readonly toolCallProposed: ObservationFact;
  readonly continuationAvailable: ObservationFact;
  readonly externalEffectPossible: ObservationFact;
}

export type ProviderObservationDelta = Partial<
  Readonly<Record<keyof ProviderAttemptObservation, boolean>>
>;

export interface ProviderContinuationCheckpoint {
  readonly cursor: string;
  readonly canonicalEventPrefixJson: string;
  readonly deliveredPosition: number | null;
  /**
   * Gate C `03` §2.1 binding (C2): a continuation cursor is valid ONLY for
   * the protocol adapter and deployment that produced it. Absent on legacy
   * rows; resume with an absent or mismatched binding is rejected (stale
   * continuation — never replayed against a different adapter/binding).
   */
  readonly adapterId?: string;
  readonly bindingFingerprint?: string;
  /** Provider-side resume guarantee (SafeResume prerequisite, P15 policy). */
  readonly resumeGuaranteed?: boolean;
}

export type ProviderRetrySafety = "SafeReplay" | "SafeResume" | "UnsafeReplay";
export type ProviderRetryDecisionKind = "Retry" | "Stop";
export type ProviderRetryStrategy = "Replay" | "Resume" | null;

export interface ProviderRetryDecisionRecord {
  readonly safety: ProviderRetrySafety;
  readonly decision: ProviderRetryDecisionKind;
  readonly strategy: ProviderRetryStrategy;
  readonly reason: string;
}

export type ProviderRetryCause =
  | { readonly _tag: "ProviderFailure"; readonly kind: ProviderFailureKind }
  | { readonly _tag: "ProcessLost" }
  | { readonly _tag: "Timeout"; readonly phase: string }
  | { readonly _tag: "Cancelled" };

/** Durable P9 recovery decision evidence. attemptNo is -1 only when Recovery
 * found no ProviderAttempt row and evaluated the first replay. */
export interface ProviderRecoveryDecisionEvidence {
  readonly attemptNo: number;
  readonly cause: ProviderRetryCause;
  readonly retryDecision: ProviderRetryDecisionRecord;
  readonly decidedAt: string;
}

export interface ProviderRuntimeExecutionPolicy {
  readonly connectTimeoutMs: number;
  readonly firstEventTimeoutMs: number;
  readonly streamIdleTimeoutMs: number;
  readonly turnTimeoutMs: number;
  readonly maxAttempts: number;
  readonly retryBackoffMs: number;
}

export type ProviderExecutionPolicyOverrides =
  Partial<ProviderRuntimeExecutionPolicy>;

export interface ProviderPolicySources {
  readonly systemDefault: ProviderRuntimeExecutionPolicy;
  readonly providerDefault?: ProviderExecutionPolicyOverrides;
  readonly modelDeploymentOverride?: ProviderExecutionPolicyOverrides;
}

/** Internal adapter/runtime event. Runtime persists observations before it
 * accepts later events or crosses the corresponding transport boundary. */
export type ProviderPortEvent =
  | { readonly _tag: "Canonical"; readonly event: CanonicalProviderEvent }
  | {
      readonly _tag: "Observation";
      readonly delta: ProviderObservationDelta;
      readonly continuationCheckpoint?: ProviderContinuationCheckpoint;
    };

export type CanonicalProviderEvent =
  | {
      readonly _tag: "TurnStarted";
      readonly providerTurnId: ProviderTurnId;
      readonly attemptNo: number;
      readonly modelRef: string;
    }
  | { readonly _tag: "TextDelta"; readonly text: string }
  | { readonly _tag: "ReasoningDelta"; readonly text: string }
  | {
      readonly _tag: "ToolCallProposed";
      readonly callRef: string;
      readonly toolName: string;
      readonly argumentsJson: string;
    }
  | {
      readonly _tag: "UsageReported";
      readonly inputTokens: number;
      readonly outputTokens: number;
      /** Gate C `03` §1.7 (authorized minimal change): provider-reported
       * reasoning token count. Absent = not reported (null semantics). */
      readonly reasoningTokens?: number;
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
    }
  | { readonly _tag: "ContinuationState"; readonly stateRef: string }
  | {
      readonly _tag: "TurnCompleted";
      readonly finishReason: ProviderFinishReason;
    }
  | { readonly _tag: "TurnFailed"; readonly failureKind: ProviderFailureKind };

export interface ProviderPortService {
  readonly runTurn: (input: {
    readonly request: PortableModelRequest;
    readonly context: ProviderExecutionContext;
  }) => Stream.Stream<ProviderPortEvent, ProviderFailure>;
}

export class ProviderPort extends Context.Service<
  ProviderPort,
  ProviderPortService
>()("arbor/ProviderPort") {}

export interface ProviderRunInput {
  readonly providerTurnId: ProviderTurnId;
  readonly executionId: ExecutionId;
  readonly sessionId: SessionId;
  readonly contextEpoch: ContextEpochNumber;
  readonly modelRef: string;
  readonly outputContractRef: string;
  /** Full ModelContextManifest JSON; Runtime allocates a separate durable
   * ManifestId and stores this value verbatim before Provider Attempt 0. */
  readonly manifestJson: string;
  readonly request: PortableModelRequest;
  readonly secretRef?: SecretRef;
  readonly cancellationSignal?: ProviderCancellationSignal;
  readonly executionPolicyOverrides?: ProviderExecutionPolicyOverrides;
  readonly recovery?: ProviderTurnResumeInput;
  /** Process-local observation of provider events while an attempt is live.
   * Observers are presentation-only and cannot affect provider success. */
  readonly onProgress?: ((event: ProviderRuntimeProgress) => void) | undefined;
}

/** The application Recovery decision needed to continue an existing logical
 * ProviderTurn. Provider Runtime revalidates it against persisted evidence. */
export interface ProviderTurnResumeInput {
  readonly manifestId: string;
  readonly nextAttemptNo: number;
  readonly retryDecision: ProviderRetryDecisionRecord;
  readonly continuationCheckpoint?: ProviderContinuationCheckpoint;
}

/** Durable row payload for DID §8.19 / P3 `04` §3.3. */
export interface ModelContextManifestRecord {
  readonly manifestId: string;
  readonly providerTurnId: ProviderTurnId;
  readonly executionId: ExecutionId;
  readonly sessionId: SessionId;
  readonly contextEpoch: ContextEpochNumber;
  readonly modelRef: string;
  readonly compiledRequestHash: string;
  readonly manifestJson: string;
}

export type ProviderRuntimeProgress =
  | {
      readonly _tag: "AttemptStarted";
      readonly providerTurnId: ProviderTurnId;
      readonly attemptNo: number;
    }
  | {
      readonly _tag: "ProviderEvent";
      readonly providerTurnId: ProviderTurnId;
      readonly attemptNo: number;
      readonly event: CanonicalProviderEvent;
    }
  | {
      readonly _tag: "AttemptFailed";
      readonly providerTurnId: ProviderTurnId;
      readonly attemptNo: number;
      readonly failureKind: ProviderFailureKind;
      readonly retrying: boolean;
    };

/** P12 `08` §7 D1 (B-4): the successful result of one logical `ProviderTurn`.
 * `attemptNo` is the Turn-local ordinal of the transport attempt that produced
 * `events` (0 = first attempt). Provider retry never creates a new
 * `ProviderTurn` (DID §6A.9), so this ordinal is the only channel through
 * which the caller observes real provider retries. */
export interface ProviderRunResult {
  readonly events: ReadonlyArray<CanonicalProviderEvent>;
  readonly attemptNo: number;
  readonly retryDecisions: ReadonlyArray<ProviderRetryDecisionRecord>;
}

export interface ProviderRuntimeService {
  readonly runTurn: (
    input: ProviderRunInput,
  ) => Effect.Effect<
    ProviderRunResult,
    | ProviderFailure
    | ProviderExecutionTimeout
    | TransactionOperationalFailure
    | SecretStoreError
  >;
}

export class ProviderRuntime extends Context.Service<
  ProviderRuntime,
  ProviderRuntimeService
>()("arbor/ProviderRuntime") {}
