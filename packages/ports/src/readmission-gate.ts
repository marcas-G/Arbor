import type {
  ExecutionId,
  ProjectId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { TransactionScope } from "./session.js";

export type ReadmissionSourceKind =
  | "RuntimeSafetyStopSettlement"
  | "OutcomeUnknownSettlement"
  | "DeliverReplayFact"
  | "AssignWorkBindingFact"
  | "ReconciliationEscalationEvent";

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
    | "SettlementMalformed";
}

export interface ReadmissionGateStoreFailure {
  readonly _tag: "ReadmissionGateStoreFailure";
  readonly operation: "Query";
}

export interface WorkReadmissionHeld {
  readonly _tag: "WorkReadmissionHeld";
  readonly sourceKind: ReadmissionSourceKind;
  readonly executionId: ExecutionId;
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
    Option.Option<{
      readonly sourceKind: ReadmissionSourceKind;
      readonly executionId: ExecutionId;
    }>,
    | ReadmissionTargetMismatch
    | ReadmissionGateIntegrityFailure
    | ReadmissionGateStoreFailure,
    TransactionScope
  >;
}

export class WorkReadmissionGateStore extends Context.Service<
  WorkReadmissionGateStore,
  WorkReadmissionGateStoreService
>()("arbor/WorkReadmissionGateStore") {}
