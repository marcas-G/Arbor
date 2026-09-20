import type { ExecutionId, LeaseGeneration } from "@arbor/domain";

export type RepositoryFailure<Tag extends string> =
  | { readonly _tag: `${Tag}RevisionConflict` }
  | { readonly _tag: `${Tag}Failure`; readonly cause: unknown };

export type ProjectRepositoryError = RepositoryFailure<"ProjectRepository">;
export type WorkspaceRepositoryError = RepositoryFailure<"WorkspaceRepository">;
export type WorkRepositoryError = RepositoryFailure<"WorkRepository">;
export type SessionRepositoryError = RepositoryFailure<"SessionRepository">;
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

export interface ExecutionDriverError {
  readonly _tag: "ExecutionDriverError";
  readonly cause: unknown;
}

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

export interface ProviderFailure {
  readonly _tag: "ProviderFailure";
  readonly kind:
    | "RateLimited"
    | "ProviderUnavailable"
    | "AuthenticationFailed"
    | "RequestRejected"
    | "StreamInterrupted"
    | "ProtocolViolation";
  readonly cause?: unknown;
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

export interface ToolRuntimeError {
  readonly _tag: "ToolRuntimeError";
  readonly cause: unknown;
}
export interface SandboxError {
  readonly _tag: "SandboxError";
  readonly cause: unknown;
}
export interface ResourceAdmissionError {
  readonly _tag: "ResourceAdmissionError";
  readonly cause: unknown;
}
export interface ToolInvocationStoreError {
  readonly _tag: "ToolInvocationStoreError";
  readonly cause: unknown;
}
export interface ArtifactError {
  readonly _tag: "ArtifactError";
  readonly cause: unknown;
}
export interface BlobStoreError {
  readonly _tag: "BlobStoreError";
  readonly cause: unknown;
}
export interface ArtifactMetadataError {
  readonly _tag: "ArtifactMetadataError";
  readonly cause: unknown;
}
