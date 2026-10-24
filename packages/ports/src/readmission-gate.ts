import type {
  ExecutionId,
  ProjectId,
  ProviderTurnId,
  Sha256,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { RepositoryFailure } from "./errors.js";
import type { TransactionScope } from "./session.js";

export type ReadmissionSourceKind =
  | "RuntimeSafetyStopSettlement"
  | "OutcomeUnknownSettlement"
  | "DeliverReplayFact"
  | "AssignWorkBindingFact"
  | "ReconciliationEscalationEvent"
  | "TerminalProviderFailureSettlement";

export type TerminalProviderFailureKind =
  | "AuthenticationFailed"
  | "RequestRejected"
  | "ProtocolViolation";

export interface TerminalProviderFailureSource {
  readonly sourceKind: "TerminalProviderFailureSettlement";
  readonly executionId: ExecutionId;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly providerTurnId: ProviderTurnId;
  readonly attemptNo: number;
  readonly failureKind: TerminalProviderFailureKind;
  readonly failureFingerprint: Sha256;
}

export type ReadmissionBlockingSource =
  | {
      readonly sourceKind: Exclude<
        ReadmissionSourceKind,
        "TerminalProviderFailureSettlement"
      >;
      readonly executionId: ExecutionId;
    }
  | TerminalProviderFailureSource;

export interface ReadmissionTargetMismatch {
  readonly _tag: "ReadmissionTargetMismatch";
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly workId: WorkId;
  readonly requestedWorkRevision: WorkRevision;
  readonly reasonCode:
    | "ReadmissionTargetMissing"
    | "ReadmissionTargetScopeMismatch"
    | "ReadmissionTargetRevisionMismatch";
}

export interface ReadmissionGateIntegrityFailure {
  readonly _tag: "ReadmissionGateIntegrityFailure";
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly workId: WorkId;
  readonly requestedWorkRevision: WorkRevision;
  readonly executionId?: ExecutionId;
  readonly sourceKind?: ReadmissionSourceKind;
  readonly reasonCode:
    | "ReadmissionTargetMissing"
    | "ReadmissionTargetScopeMismatch"
    | "ReadmissionTargetRevisionMismatch"
    | "SourceExecutionMissing"
    | "SourceExecutionNonUnique"
    | "SourceEpisodeStateMissing"
    | "SourceEpisodeStateNonUnique"
    | "EpisodeMalformed"
    | "EpisodeVersionUnsupported"
    | "SourceFactEventMismatch"
    | "SourceEventExecutionMismatch"
    | "SourceProjectMismatch"
    | "SourceWorkspaceMismatch"
    | "WorkMissing"
    | "WorkScopeMismatch"
    | "FutureWorkRevision"
    | "SettlementMalformed"
    | "SourceSettlementStepMissing"
    | "SourceSettlementStepNonUnique"
    | "SourceSettlementMismatch"
    | "SourceProviderTurnMissing"
    | "SourceProviderTurnNonUnique"
    | "SourceProviderTurnMismatch"
    | "SourceProviderAttemptMissing"
    | "SourceProviderAttemptNonUnique"
    | "SourceProviderAttemptMismatch"
    | "SourceManifestMissing"
    | "SourceManifestMismatch"
    | "FailureTaxonomyUnsupported"
    | "FailureOccurrenceTimeInvalid";
}

export type ReadmissionGateStoreError =
  RepositoryFailure<"WorkReadmissionGateStore">;

export interface WorkReadmissionHeld {
  readonly _tag: "WorkReadmissionHeld";
  readonly source: ReadmissionBlockingSource;
}

export type WorkAdmissionBlock =
  | WorkReadmissionHeld
  | ReadmissionTargetMismatch
  | ReadmissionGateIntegrityFailure;

export interface WorkReadmissionGateStoreService {
  readonly hasBlockingSource: (input: {
    readonly projectId: ProjectId;
    readonly workspaceId: WorkspaceId;
    readonly workId: WorkId;
    readonly workRevision: WorkRevision;
  }) => Effect.Effect<
    Option.Option<ReadmissionBlockingSource>,
    | ReadmissionTargetMismatch
    | ReadmissionGateIntegrityFailure
    | ReadmissionGateStoreError,
    TransactionScope
  >;
}

export class WorkReadmissionGateStore extends Context.Service<
  WorkReadmissionGateStore,
  WorkReadmissionGateStoreService
>()("arbor/WorkReadmissionGateStore") {}
