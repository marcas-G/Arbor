import type {
  AgentBinding,
  ContextEpochNumber,
  ExecutionId,
  ProjectId,
  ProviderTurnId,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";

export type {
  ContextEpochNumber,
  ExecutionId,
  ProjectId,
  ProviderTurnId,
  SessionId,
};

import { Context, type Effect, type Stream } from "effect";
import type {
  ModelCapabilityError,
  ProviderExecutionTimeout,
  ProviderFailure,
  ProviderFailureKind,
  ProviderFailureTaxonomyVersion,
  SkillRegistryError,
} from "./errors.js";
import type {
  TransactionOperationalFailure,
  TransactionScope,
} from "./session.js";
import type { SideEffectSemantics } from "./tool.js";

export interface PortableInstruction {
  readonly slotId: string;
  readonly authorityRole: string;
  readonly text: string;
}

export interface PortableMessage {
  readonly _tag: "Message";
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly text: string;
}

/** Pre-SCRC request compatibility. New compilers must emit the tagged Message
 * variant; persisted v1 requests remain readable and are normalized at the
 * provider boundary. */
export interface PortableLegacyMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly text: string;
}

export interface PortableToolCall {
  readonly _tag: "ToolCall";
  readonly callRef: string;
  readonly toolName: string;
  readonly argumentsJson: string;
}

export type PortableToolResultStatus =
  | "Succeeded"
  | "Failed"
  | "Denied"
  | "Interrupted"
  | "OutcomeUnknown";

export interface PortableToolResult {
  readonly _tag: "ToolResult";
  readonly callRef: string;
  readonly toolName: string;
  readonly status: PortableToolResultStatus;
  readonly outputText: string;
  readonly observationRef: string;
  readonly artifactRefs: ReadonlyArray<string>;
  readonly truncated: boolean;
}

export interface PortableControlResult {
  readonly _tag: "ControlResult";
  readonly callRef: string;
  readonly actionKind: string;
  readonly status: PortableToolResultStatus;
  readonly outputText: string;
  readonly observationRef: string;
  readonly canonicalRefs: ReadonlyArray<string>;
}

export interface PortableContextUpdate {
  readonly _tag: "ContextUpdate";
  readonly sourceRef: string;
  readonly revision: number;
  readonly updateKind: "Full" | "Replace" | "Revoke";
  readonly text: string;
}

export interface PortableCompactionCheckpoint {
  readonly _tag: "CompactionCheckpoint";
  readonly implementation: "Summary" | "ProviderNative";
  readonly fromEpoch: ContextEpochNumber;
  readonly toEpoch: ContextEpochNumber;
  readonly retainedFrontierRef: string;
  readonly summaryText?: string;
  readonly opaqueItemRef?: string;
  readonly bindingFingerprint?: string;
}

export interface PortableAttachmentRef {
  readonly _tag: "AttachmentRef";
  readonly ref: string;
  readonly mediaType: string;
  readonly filename?: string;
  readonly trust: "CanonicalInstruction" | "InstructionCandidate" | "DataOnly";
}

export type PortableInputItem =
  | PortableMessage
  | PortableToolCall
  | PortableToolResult
  | PortableControlResult
  | PortableContextUpdate
  | PortableCompactionCheckpoint
  | PortableAttachmentRef;

export type PortableInputItemKind = PortableInputItem["_tag"];
export type PortableOperationKind =
  | "Inference"
  | "CompactionSummary"
  | "CompactionNative";

export interface PortableToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly schemaJson: string;
}

export interface CacheHint {
  readonly cacheClass: "Stable" | "SemiStable" | "TurnDynamic";
}

interface PortableModelRequestShared {
  readonly modelRef: string;
  readonly instructions: ReadonlyArray<PortableInstruction>;
  readonly toolDefinitions: ReadonlyArray<PortableToolDefinition>;
  readonly outputContractRef: string;
  readonly budget: { readonly maxOutputTokens: number };
  readonly cacheHints: ReadonlyArray<CacheHint>;
}

/** Persisted/request compatibility for pre-SCRC turns. Never emitted by the
 * v2 Model Context compiler after SCRC-001. */
export interface PortableModelRequestV1 extends PortableModelRequestShared {
  readonly requestVersion?: 1;
  readonly messages: ReadonlyArray<PortableLegacyMessage>;
}

export interface PortableModelRequestV2 extends PortableModelRequestShared {
  readonly requestVersion: 2;
  readonly operationKind: PortableOperationKind;
  readonly inputItems: ReadonlyArray<PortableInputItem>;
}

export type PortableModelRequest =
  | PortableModelRequestV1
  | PortableModelRequestV2;

export const isPortableModelRequestV2 = (
  request: PortableModelRequest,
): request is PortableModelRequestV2 => request.requestVersion === 2;

export const portableRequestOperationKind = (
  request: PortableModelRequest,
): PortableOperationKind =>
  isPortableModelRequestV2(request) ? request.operationKind : "Inference";

export const portableInputItems = (
  request: PortableModelRequest,
): ReadonlyArray<PortableInputItem> =>
  isPortableModelRequestV2(request)
    ? request.inputItems
    : request.messages.map((message) => ({
        _tag: "Message" as const,
        role: message.role,
        text: message.text,
      }));

export interface PortableRequestCompatibility {
  readonly operationKinds: ReadonlyArray<PortableOperationKind>;
  readonly inputItemKinds: ReadonlyArray<PortableInputItemKind>;
}

export interface PortableRequestIncompatible {
  readonly _tag: "PortableRequestIncompatible";
  readonly operationKind: PortableOperationKind;
  readonly unsupportedOperation: boolean;
  readonly unsupportedInputItemKinds: ReadonlyArray<PortableInputItemKind>;
}

export type PortableRequestCompatibilityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: PortableRequestIncompatible };

export const validatePortableRequestCompatibility = (
  request: PortableModelRequest,
  compatibility: PortableRequestCompatibility,
): PortableRequestCompatibilityResult => {
  const operationKind = portableRequestOperationKind(request);
  const unsupportedInputItemKinds = [
    ...new Set(
      portableInputItems(request)
        .map((item) => item._tag)
        .filter((kind) => !compatibility.inputItemKinds.includes(kind)),
    ),
  ];
  const unsupportedOperation =
    !compatibility.operationKinds.includes(operationKind);
  return unsupportedOperation || unsupportedInputItemKinds.length > 0
    ? {
        ok: false,
        error: {
          _tag: "PortableRequestIncompatible",
          operationKind,
          unsupportedOperation,
          unsupportedInputItemKinds,
        },
      }
    : { ok: true };
};

export interface PortableToolPairingError {
  readonly _tag: "PortableToolPairingError";
  readonly kind:
    | "DuplicateToolCall"
    | "MissingToolCall"
    | "DuplicateToolResult"
    | "DanglingToolCall";
  readonly callRef: string;
}

export type PortableToolPairingValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: PortableToolPairingError };

export const validatePortableToolPairing = (
  items: ReadonlyArray<PortableInputItem>,
): PortableToolPairingValidation => {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const item of items) {
    if (item._tag === "ToolCall") {
      if (calls.has(item.callRef)) {
        return {
          ok: false,
          error: {
            _tag: "PortableToolPairingError",
            kind: "DuplicateToolCall",
            callRef: item.callRef,
          },
        };
      }
      calls.add(item.callRef);
      continue;
    }
    if (item._tag !== "ToolResult" && item._tag !== "ControlResult") continue;
    if (!calls.has(item.callRef)) {
      return {
        ok: false,
        error: {
          _tag: "PortableToolPairingError",
          kind: "MissingToolCall",
          callRef: item.callRef,
        },
      };
    }
    if (results.has(item.callRef)) {
      return {
        ok: false,
        error: {
          _tag: "PortableToolPairingError",
          kind: "DuplicateToolResult",
          callRef: item.callRef,
        },
      };
    }
    results.add(item.callRef);
  }
  for (const callRef of calls) {
    if (!results.has(callRef)) {
      return {
        ok: false,
        error: {
          _tag: "PortableToolPairingError",
          kind: "DanglingToolCall",
          callRef,
        },
      };
    }
  }
  return { ok: true };
};

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

export interface ProviderTurnRecord {
  readonly providerTurnId: ProviderTurnId;
  readonly executionId: ExecutionId;
  readonly sessionId: SessionId;
  readonly contextEpoch: ContextEpochNumber;
  readonly modelRef: string;
  readonly outputContractRef: string;
  readonly manifestId: string;
  readonly executionPolicy?: ProviderRuntimeExecutionPolicy;
  readonly turnDeadlineAt?: string;
}

export interface ProviderAttemptOutcome {
  readonly _tag:
    | "InProgress"
    | "Success"
    | "RetryableFailure"
    | "TerminalFailure"
    | "Cancelled"
    | "TimedOut";
  readonly providerErrorKind?: ProviderFailureKind;
  readonly taxonomyVersion?: ProviderFailureTaxonomyVersion;
}

/** P9 `04` §2.2 read face: a dangling ProviderTurn (`settled_at IS NULL`)
 * plus its append-only attempt history, for the unsettled-Turn recovery
 * decision table. */
export interface ProviderAttemptSummary {
  readonly attemptNo: number;
  readonly outcome: ProviderAttemptOutcome["_tag"];
  readonly providerErrorKind: string | null;
  readonly taxonomyVersion?: ProviderFailureTaxonomyVersion;
  readonly observation?: ProviderAttemptObservation | null;
  readonly continuationCheckpoint?: ProviderContinuationCheckpoint | null;
  readonly retryDecision?: ProviderRetryDecisionRecord | null;
  readonly canonicalEventPrefixJson?: string;
  readonly deliveredPosition?: number | null;
}

export interface ProviderTurnManifestReceipt {
  readonly providerTurnId: ProviderTurnId;
  readonly manifestId: string;
}

export interface ProviderAttemptSettlement {
  readonly outcome: Exclude<ProviderAttemptOutcome["_tag"], "InProgress">;
  readonly providerErrorKind?: ProviderFailureKind;
  readonly taxonomyVersion: ProviderFailureTaxonomyVersion;
  readonly observation: ProviderAttemptObservation;
  readonly continuationCheckpoint?: ProviderContinuationCheckpoint;
  readonly canonicalEventPrefixJson: string;
  readonly deliveredPosition: number;
  readonly retryDecision?: ProviderRetryDecisionRecord;
}

export type SettledProviderTurnResult =
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Unsettled"; readonly turn: ProviderTurnRecord }
  | {
      readonly _tag: "SettledSuccess";
      readonly turn: ProviderTurnRecord;
      readonly manifestId: string;
      readonly manifestJson: string;
      readonly canonicalEvents: ReadonlyArray<CanonicalProviderEvent>;
      readonly attemptNo: number;
      readonly finishReason: string;
      readonly usageJson: string;
      readonly evidenceVersion: string;
    }
  | {
      readonly _tag: "SettledFailure";
      readonly turn: ProviderTurnRecord;
      readonly finishReason: string;
      readonly failureKind?: ProviderFailureKind;
      readonly failureAttemptNo?: number;
      readonly failureTaxonomyVersion?: ProviderFailureTaxonomyVersion;
    }
  | {
      readonly _tag: "SettledEvidenceInvalid";
      readonly turn: ProviderTurnRecord;
      readonly reason: string;
    };

export interface UnsettledProviderTurn {
  readonly turn: ProviderTurnRecord;
  readonly attempts: ReadonlyArray<ProviderAttemptSummary>;
  readonly manifestJson: string | null;
  readonly portableRequestJson: string | null;
}

export interface ProviderTurnStoreService {
  readonly startTurnWithManifest: (
    record: ProviderTurnRecord,
    manifestJson: string,
    portableRequestJson: string,
    startedAt: string,
  ) => Effect.Effect<
    ProviderTurnManifestReceipt,
    ProviderFailure,
    TransactionScope
  >;
  readonly findManifestByTurn: (
    providerTurnId: ProviderTurnId,
  ) => Effect.Effect<
    {
      readonly manifestId: string;
      readonly manifestJson: string;
      readonly portableRequestJson: string;
    } | null,
    ProviderFailure,
    TransactionScope
  >;
  readonly startAttempt: (
    providerTurnId: ProviderTurnId,
    attemptNo: number,
    observation: ProviderAttemptObservation,
    startedAt: string,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  readonly updateAttemptObservation: (
    providerTurnId: ProviderTurnId,
    attemptNo: number,
    observation: ProviderAttemptObservation,
    canonicalEventPrefixJson: string,
    deliveredPosition: number,
    continuationCheckpoint: ProviderContinuationCheckpoint | null,
    updatedAt: string,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  readonly settleAttempt: (
    providerTurnId: ProviderTurnId,
    attemptNo: number,
    settlement: ProviderAttemptSettlement,
    settledAt: string,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  readonly settleSuccessAtomically: (
    providerTurnId: ProviderTurnId,
    attemptNo: number,
    settlement: ProviderAttemptSettlement & { readonly outcome: "Success" },
    finishReason: string,
    usageJson: string,
    settledAt: string,
    evidenceVersion: "provider-success-v1",
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  readonly findSettledResult: (
    providerTurnId: ProviderTurnId,
  ) => Effect.Effect<
    SettledProviderTurnResult,
    ProviderFailure,
    TransactionScope
  >;
  readonly adoptSettledSuccessEvidence: (
    providerTurnId: ProviderTurnId,
    attemptNo: number,
    fromVersion: "legacy-success-v1",
    toVersion: "provider-success-v1",
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  readonly startTurn: (
    record: ProviderTurnRecord,
    startedAt: string,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  readonly recordAttempt: (
    providerTurnId: ProviderTurnId,
    attemptNo: number,
    outcome: ProviderAttemptOutcome,
    startedAt: string,
    settledAt: string,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  readonly settleTurn: (
    providerTurnId: ProviderTurnId,
    finishReason: string,
    usageJson: string,
    settledAt: string,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  /** P9 `04` §2.2: enumerate dangling turns of a project (Turn intent +
   * Manifest persisted before the request, so every dangling Turn is
   * visible) together with their recorded attempts. */
  readonly findUnsettledByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<UnsettledProviderTurn>,
    ProviderFailure,
    TransactionScope
  >;
  readonly findUnsettledByTurn: (
    providerTurnId: ProviderTurnId,
  ) => Effect.Effect<
    UnsettledProviderTurn | null,
    ProviderFailure,
    TransactionScope
  >;
  /** Append the shared retry-policy result before Recovery returns a retry
   * plan or marks the ProviderTurn failed. */
  readonly recordRecoveryDecision: (
    providerTurnId: ProviderTurnId,
    evidence: ProviderRecoveryDecisionEvidence,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  /** P9 `04` §2.2 case 2: mark a dangling Turn settled failed (driver
   * Turn-failure semantics, P3 `06` §2) when the retry bound is exhausted
   * or the failure class is terminal. No-op if already settled. */
  readonly failTurn: (
    providerTurnId: ProviderTurnId,
    settledAt: string,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  /** P10-007 read-only extension (observe-only, invariant 45): settled
   * provider turns with their usage_json and executing workspace — the
   * Usage aggregation source. Never feeds budget or any mutation. */
  readonly listUsageByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<ProviderTurnUsageRow>,
    ProviderFailure,
    TransactionScope
  >;
}

/** P10-007: one settled-or-unsettled provider_turns usage fact, workspace
 * attributed (usage_json raw; parsing belongs to the projection). */
export interface ProviderTurnUsageRow {
  readonly workspaceId: import("@arbor/domain").WorkspaceId;
  readonly usageJson: string | null;
  readonly settledAt: string | null;
}

export class ProviderTurnStore extends Context.Service<
  ProviderTurnStore,
  ProviderTurnStoreService
>()("arbor/ProviderTurnStore") {}

export interface ModelCapability {
  readonly modelRef: string;
  readonly family: string;
  /** Composition-selected provider adapter identity for audit manifests. */
  readonly providerRef?: string;
  readonly contextWindow: number;
  readonly outputCeiling: number;
  readonly toolProtocol: string;
  /** SCRC-001: provider/model request surface. Absent means legacy
   * Message-only Inference compatibility. */
  readonly portableRequestCompatibility?: PortableRequestCompatibility;
  /** Full deployment/model/protocol identity used by provider-native opaque
   * continuation/compaction. Introduced as metadata here; SCRC-007 enforces
   * native checkpoint reuse. */
  readonly bindingFingerprint?: string;
  /** P12 `12` §5 (TR-4, additive/MINOR): optional capability tags used by the
   * deterministic model-catalog selection. Absent = no declared tags. */
  readonly capabilities?: ReadonlyArray<string>;
  /** P12 `12` §3/§5: usage cost provenance only, never authority. */
  readonly priceSheetVersion?: string;
}

export interface ModelCapabilityPortService {
  readonly resolve: (input: {
    readonly binding: AgentBinding;
    readonly cognitiveMode: string;
    readonly requiredCapabilities: ReadonlyArray<string>;
  }) => Effect.Effect<ModelCapability, ModelCapabilityError>;
}

export class ModelCapabilityPort extends Context.Service<
  ModelCapabilityPort,
  ModelCapabilityPortService
>()("arbor/ModelCapabilityPort") {}

export interface InformationTrustMetadata {
  readonly provenanceKind:
    | "CanonicalInternal"
    | "AuthenticatedHuman"
    | "AuthenticatedAgent"
    | "ToolObservation"
    | "ExternalRetrieved"
    | "ImportedArtifact"
    | "ModelDerived";
  readonly instructionCapability:
    | "CanonicalInstruction"
    | "InstructionCandidate"
    | "DataOnly";
  readonly epistemicStatus:
    | "Established"
    | "Supported"
    | "Unverified"
    | "Conflicting"
    | "Derived";
}

export interface SkillRef {
  readonly skillId: string;
  readonly revision: number;
  readonly hash: string;
  readonly provenance: InformationTrustMetadata;
  readonly disclosureTier: "Summary" | "Body";
}

export interface LoadedSkill {
  readonly skillRef: SkillRef;
  readonly content: string;
}

export interface SkillRegistryService {
  readonly available: (
    binding: AgentBinding,
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<SkillRef>, SkillRegistryError>;
  readonly load: (
    skillId: string,
    tier: "Summary" | "Body",
  ) => Effect.Effect<LoadedSkill, SkillRegistryError>;
}

export class SkillRegistry extends Context.Service<
  SkillRegistry,
  SkillRegistryService
>()("arbor/SkillRegistry") {}

/** DID §7.7 port catalog (ModelContext package, §10.4.1): the declared
 * session-entry source surface. Frozen catalog surface — reserved for the
 * ModelContext context-assembly boundary; no production Layer provisions it
 * yet, so it is retained as a declared (not silently deleted) port. */
export interface AgentContextSourcePortService {
  readonly sessionEntryRefs: (
    sessionId: SessionId,
    epoch: ContextEpochNumber,
  ) => Effect.Effect<ReadonlyArray<string>>;
}

export class AgentContextSourcePort extends Context.Service<
  AgentContextSourcePort,
  AgentContextSourcePortService
>()("arbor/AgentContextSourcePort") {}

/** DID §7.7 port catalog (ModelContext package, §10.4.1): the declared
 * knowledge-retrieval surface. Frozen catalog surface — reserved for the
 * ModelContext context-assembly boundary; no production Layer provisions it
 * yet, so it is retained as a declared (not silently deleted) port. */
export interface KnowledgeQueryPortService {
  readonly retrieve: (input: {
    readonly query: string;
    readonly workspaceId: WorkspaceId;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<{ readonly ref: string; readonly text: string }>
  >;
}

export class KnowledgeQueryPort extends Context.Service<
  KnowledgeQueryPort,
  KnowledgeQueryPortService
>()("arbor/KnowledgeQueryPort") {}

export interface ToolDefinitionRef {
  readonly name: string;
  readonly version: string;
  readonly hash: string;
}

/** P12 `07` §2 (DID v1.14 G3, §7.6): the model-facing projection of a
 * `ToolDefinition` resolved by Model Context through `ToolCatalogPort`.
 * `schemaJson := ToolDefinition.inputSchemaJson`; `capabilityMetadata` and
 * `sideEffectSemantics` are model-facing metadata (DID §7.6) and are
 * projected. Only `resultSchemaJson` and `source` are not model-facing. */
export interface ModelFacingToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly schemaJson: string;
  readonly version: string;
  readonly hash: string;
  readonly capabilityMetadata: ReadonlyArray<string>;
  readonly sideEffectSemantics: SideEffectSemantics;
}

/** Data-only, model-facing schema projected from Agent Runtime's control
 * registry. Model Context may compile it but never interprets the action. */
export interface ModelFacingControlToolDefinition {
  /** Stable Runtime identity. It is used for registration, authorization,
   * manifests and replay; it is never sent to the model as a function name. */
  readonly stableId: string;
  /** Model-facing function name for newly compiled turns. */
  readonly name: string;
  readonly description: string;
  readonly schemaJson: string;
  readonly version: string;
  readonly hash: string;
  readonly requiredCapability: string;
  /** Historical model names retained solely to replay a manifest created
   * before a model-facing rename. They are never advertised to a new turn. */
  readonly legacyNames?: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
    readonly hash: string;
  }>;
}

/** Data-only control-tool catalog projected into Model Context by the app
 * composition root. Its definitions are model-facing data, not handlers. */
export interface ControlToolCatalogPortService {
  readonly visibleDefinitions: () => Effect.Effect<
    ReadonlyArray<ModelFacingControlToolDefinition>
  >;
}

export class ControlToolCatalogPort extends Context.Service<
  ControlToolCatalogPort,
  ControlToolCatalogPortService
>()("arbor/ControlToolCatalogPort") {}

/** P12 `07` §2: `resolveForModel` never fabricates a placeholder; an
 * unregistered ref fails with this typed error and is absent from
 * `visibleRefs`. */
export type ToolCatalogError = {
  readonly _tag: "ToolNotRegistered";
  readonly ref: ToolDefinitionRef;
};

export interface ToolCatalogPortService {
  /** Refs eligible for model-facing exposure (catalogued, not turn-filtered).
   * Renamed inherited `definitions()` surface; retains the inherited `Effect`
   * channel (P12 `07` §2, TR-11). */
  readonly visibleRefs: () => Effect.Effect<ReadonlyArray<ToolDefinitionRef>>;
  /** Model-facing projection for exactly one visible ref; an unregistered ref
   * fails with typed `ToolNotRegistered` (never a placeholder). */
  readonly resolveForModel: (
    ref: ToolDefinitionRef,
  ) => Effect.Effect<ModelFacingToolDefinition, ToolCatalogError>;
}

export class ToolCatalogPort extends Context.Service<
  ToolCatalogPort,
  ToolCatalogPortService
>()("arbor/ToolCatalogPort") {}

declare const SecretRefBrand: unique symbol;

/** Opaque secret reference (P12 `03` §1; P3 `01` §9 / P3 `00` F1): the only
 * secret-related value allowed in Project Policy, Agent bindings, or
 * EnvironmentRef. It is a reference, never material. */
export type SecretRef = string & { readonly [SecretRefBrand]: "SecretRef" };

export const secretRef = (value: string): SecretRef => value as SecretRef;

/** Opaque resolved credential (P12 `03` §1): produced only at the execution
 * boundary and consumed immediately. It is not a string; the raw value is
 * reachable only through `reveal()` and is redacted by default under
 * `JSON.stringify` / `String()` so it can never leak through serialization. */
export class SecretMaterial {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static of(value: string): SecretMaterial {
    return new SecretMaterial(value);
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "[REDACTED]";
  }
}

/** Typed secret failures (P12 `03` §2): missing / inaccessible / expired must
 * never be silently substituted. */
export type SecretStoreError =
  | { readonly _tag: "SecretNotFound"; readonly secretRef: SecretRef }
  | {
      readonly _tag: "SecretInaccessible";
      readonly secretRef: SecretRef;
      readonly reason: string;
    }
  | { readonly _tag: "SecretExpired"; readonly secretRef: SecretRef };

export interface SecretStorePortService {
  readonly resolve: (
    secretRef: SecretRef,
  ) => Effect.Effect<SecretMaterial, SecretStoreError>;
}

export class SecretStorePort extends Context.Service<
  SecretStorePort,
  SecretStorePortService
>()("arbor/SecretStorePort") {}
