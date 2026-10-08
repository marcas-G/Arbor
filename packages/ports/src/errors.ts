import type { ExecutionId, LeaseGeneration } from "@arbor/domain";

export interface PersistenceUnavailable<Tag extends string = string> {
  readonly _tag: "PersistenceUnavailable";
  readonly repository: Tag;
  readonly operation: string;
  readonly retryDisposition: "retryable" | "non-retryable";
  readonly sourceTag: string;
  readonly cause: unknown;
}

export interface PersistenceConstraintViolation<Tag extends string = string> {
  readonly _tag: "PersistenceConstraintViolation";
  readonly repository: Tag;
  readonly operation: string;
  readonly constraintKind: "Unique" | "Constraint";
  readonly constraint: string;
}

export interface PersistenceCorruption<Tag extends string = string> {
  readonly _tag: "PersistenceCorruption";
  readonly repository: Tag;
  readonly operation: string;
  readonly reason: string;
}

export type RepositoryFailure<Tag extends string> =
  | { readonly _tag: `${Tag}RevisionConflict` }
  | PersistenceUnavailable<Tag>
  | PersistenceConstraintViolation<Tag>
  | PersistenceCorruption<Tag>;

export type ProjectRepositoryError = RepositoryFailure<"ProjectRepository">;
export type WorkspaceRepositoryError = RepositoryFailure<"WorkspaceRepository">;
export type WorkRepositoryError = RepositoryFailure<"WorkRepository">;
export type SessionRepositoryError = RepositoryFailure<"SessionRepository">;
export interface SessionSourceConflict {
  readonly _tag: "SessionSourceConflict";
  readonly sessionId: string;
  readonly entryKind: string;
  readonly sourceKind: string;
  readonly sourceRef: string;
}
export interface SessionEpochConflict {
  readonly _tag: "SessionEpochConflict";
  readonly sessionId: string;
  readonly expectedEpoch: number;
  readonly currentEpoch: number;
}
export type ResourceOwnershipRepositoryError =
  RepositoryFailure<"ResourceOwnershipRepository">;
export type CommandStoreError = RepositoryFailure<"CommandStore">;
export type DomainEventJournalError = RepositoryFailure<"DomainEventJournal">;
export type ConsumerOffsetStoreError = RepositoryFailure<"ConsumerOffsetStore">;
export type ConsumerDeadLetterStoreError =
  RepositoryFailure<"ConsumerDeadLetterStore">;
export type EnvironmentRevisionStoreError =
  RepositoryFailure<"EnvironmentRevisionStore">;

export interface EnvironmentError {
  readonly _tag: "EnvironmentError";
  readonly cause: unknown;
}

export interface ResourceResolutionStale {
  readonly _tag: "ResourceResolutionStale";
  readonly observed: string;
  readonly current: string;
}

// --- P2 ---

export type ExecutionRepositoryError = RepositoryFailure<"ExecutionRepository">;
export type WorkWaitStoreError = RepositoryFailure<"WorkWaitStore">;
export type LocalPlanStoreError = RepositoryFailure<"LocalPlanStore">;
/** @deprecated MAC compatibility alias; active code uses LocalPlanStoreError. */
export type WorkPlanStoreError = LocalPlanStoreError;
export type DecisionRequestStoreError =
  RepositoryFailure<"DecisionRequestStore">;
export type SchedulerTimerStoreError = RepositoryFailure<"SchedulerTimerStore">;

export interface LeaseFencingRejected {
  readonly _tag: "LeaseFencingRejected";
  readonly executionId: ExecutionId;
  readonly generation: LeaseGeneration;
}

export interface WorkerDispatchError {
  readonly _tag: "WorkerDispatchError";
  readonly cause: unknown;
}

export const EXECUTION_DRIVER_OPERATIONAL_STAGES = [
  "ModelCapability",
  "LoopStepStore",
  "InboxProjection",
  "InputPromotion",
  "ControlBasis",
  "ConversationStore",
  "SessionStore",
  "WorkspaceStore",
  "WorkStore",
  "TurnProfile",
  "ModelContext",
  "Compaction",
  "ProviderTurnStore",
  "ProviderRuntime",
  "ActionLedger",
  "DriverDependency",
] as const;

export type ExecutionDriverOperationalStage =
  (typeof EXECUTION_DRIVER_OPERATIONAL_STAGES)[number];

export interface ExecutionDriverOperationalFailure {
  readonly _tag: "ExecutionDriverOperationalFailure";
  readonly stage: ExecutionDriverOperationalStage;
  readonly sourceTag: string;
  readonly cause: unknown;
}

export interface ExecutionDriverOwnershipLost {
  readonly _tag: "ExecutionDriverOwnershipLost";
  readonly executionId: ExecutionId;
  readonly generation: LeaseGeneration;
}

export interface ExecutionDriverInvariantFailure {
  readonly _tag: "ExecutionDriverInvariantFailure";
  readonly stage:
    | "SessionTimeline"
    | "AgentLoopStep"
    | "ProviderReplay"
    | "ContextAssembly"
    | "DriverContract";
  readonly reason: string;
}

export type ExecutionDriverError =
  | ExecutionDriverOperationalFailure
  | ExecutionDriverOwnershipLost
  | ExecutionDriverInvariantFailure;

export interface ExecutionSchedulerError {
  readonly _tag: "ExecutionSchedulerError";
  readonly cause: unknown;
}

export interface RunnableWorkSourceError {
  readonly _tag: "RunnableWorkSourceError";
  readonly cause: unknown;
}

export interface ReconciliationSourceError {
  readonly _tag: "ReconciliationSourceError";
  readonly cause: unknown;
}

// --- P3 ---

export type ProviderFailureTaxonomyVersion = "legacy-v1" | "phase1-v2";

export type ProviderFailureKind =
  | "AuthenticationFailed"
  | "AuthorizationFailed"
  | "RateLimited"
  | "QuotaExceeded"
  | "ProviderUnavailable"
  | "TransportFailed"
  | "StreamInterrupted"
  | "RequestRejected"
  | "ContextLimitExceeded"
  | "ProtocolViolation"
  | "Cancelled"
  | "UnknownProviderFailure";

export interface ProviderFailure {
  readonly _tag: "ProviderFailure";
  readonly kind: ProviderFailureKind;
  /** Taxonomy used when interpreting persisted historical attempt data. */
  readonly taxonomyVersion?: ProviderFailureTaxonomyVersion;
  /** Redacted, adapter-approved diagnostic only. Never store native errors. */
  readonly safeDiagnostic?: string;
}

export type ProviderTimeoutPhase =
  | "ConnectTimeout"
  | "FirstEventTimeout"
  | "StreamIdleTimeout"
  | "TurnDeadline";

export interface ProviderExecutionTimeout {
  readonly _tag: "ProviderExecutionTimeout";
  readonly phase: ProviderTimeoutPhase;
}

export interface ModelCapabilityError {
  readonly _tag: "ModelCapabilityError";
  readonly cause: unknown;
}

export interface SkillRegistryError {
  readonly _tag: "SkillRegistryError";
  readonly cause: unknown;
}

export interface ModelContextError {
  readonly _tag: "ModelContextError";
  readonly cause: unknown;
}

// --- P4 ---

export const TOOL_RUNTIME_OPERATIONAL_STAGES = [
  "WorkspaceLookup",
  "EnvironmentResolution",
  "AuthorityResolution",
  "ApprovalLookup",
  "IntentJournal",
  "ApprovalConsumption",
  "ResourceAdmission",
  "SandboxOpen",
  "Executor",
  "SettlementJournal",
] as const;

export type ToolRuntimeOperationalStage =
  (typeof TOOL_RUNTIME_OPERATIONAL_STAGES)[number];

/** A stage-owned infrastructure failure. Callers classify on `stage`, never
 * on the adapter-native cause. The cause remains Runtime-private. */
export interface ToolRuntimeOperationalFailure {
  readonly _tag: "ToolRuntimeOperationalFailure";
  readonly stage: ToolRuntimeOperationalStage;
  readonly effectDisposition: "NotStarted" | "OutcomeUncertain";
  readonly invocationRef: string;
  readonly cause: unknown;
}

/** Cleanup failed after the executor was entered. The executor's own typed
 * failure is retained separately when both execution and cleanup fail; raw
 * causes are never flattened or projected to the model. */
export interface ToolRuntimeCleanupFailure {
  readonly _tag: "ToolRuntimeCleanupFailure";
  readonly stage: "SandboxClose";
  readonly effectDisposition: "OutcomeUncertain";
  readonly invocationRef: string;
  readonly cause: unknown;
  readonly priorFailure?: ToolRuntimeOperationalFailure;
}

export type ToolRuntimeError =
  | ToolRuntimeOperationalFailure
  | ToolRuntimeCleanupFailure;
export interface SandboxError {
  readonly _tag: "SandboxError";
  readonly cause: unknown;
}
export interface ResourceAdmissionError {
  readonly _tag: "ResourceAdmissionError";
  readonly cause: unknown;
}
export type ToolInvocationStoreError = RepositoryFailure<"ToolInvocationStore">;
export interface ArtifactError {
  readonly _tag: "ArtifactError";
  readonly cause: unknown;
}
export interface BlobStoreError {
  readonly _tag: "BlobStoreError";
  readonly cause: unknown;
}
export type ArtifactMetadataError =
  RepositoryFailure<"ArtifactMetadataRepository">;

// --- P10 (DID §10.5 Problem DTO vocabulary; P10 `05` §1) ---

/** Stable projection query failure codes — consumers switch on these, never
 * on message text (DID §10.5). */
export const PROJECTION_QUERY_ERROR_CODES = [
  "projection/stale",
  "projection/unavailable",
  "projection/invalid-request",
  "projection/work-not-found",
] as const;

export type ProjectionQueryErrorCode =
  (typeof PROJECTION_QUERY_ERROR_CODES)[number];

/** Freshness barrier refused — typed staleness marker (P10 `03` §2). */
export interface ProjectionStale {
  readonly _tag: "ProjectionStale";
  readonly code: "projection/stale";
  readonly category: "stale";
  readonly correlationId: string | null;
  readonly retryDisposition: "retryable";
  readonly safeDetails: Readonly<Record<string, unknown>>;
}

export interface ProjectionUnavailable {
  readonly _tag: "ProjectionUnavailable";
  readonly code: "projection/unavailable";
  readonly category: "unavailable";
  readonly correlationId: string | null;
  readonly retryDisposition: "retryable";
  readonly safeDetails: Readonly<Record<string, unknown>>;
}

export interface ProjectionInvalidRequest {
  readonly _tag: "ProjectionInvalidRequest";
  readonly code: "projection/invalid-request";
  readonly category: "invalid-request";
  readonly correlationId: string | null;
  readonly retryDisposition: "non-retryable";
  readonly safeDetails: Readonly<Record<string, unknown>>;
}

export interface ProjectionNotFound {
  readonly _tag: "ProjectionNotFound";
  readonly code: "projection/work-not-found";
  readonly category: "not-found";
  readonly correlationId: string | null;
  readonly retryDisposition: "non-retryable";
  readonly safeDetails: Readonly<Record<string, unknown>>;
}

/** Canonical rows contradict an integrity condition required by a read view. */
export interface ProjectionIntegrityFailure {
  readonly _tag: "ProjectionIntegrityFailure";
  readonly code: "projection/unavailable";
  readonly category: "unavailable";
  readonly correlationId: string | null;
  readonly retryDisposition: "non-retryable";
  readonly safeDetails: Readonly<Record<string, unknown>>;
}

export type ProjectionQueryError =
  | ProjectionStale
  | ProjectionUnavailable
  | ProjectionInvalidRequest
  | ProjectionNotFound
  | ProjectionIntegrityFailure;
