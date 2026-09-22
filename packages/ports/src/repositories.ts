import type {
  CanonicalResourceRegion,
  ExecutionId,
  LeaseGeneration,
  Project,
  ProjectId,
  ProjectPolicy,
  ResourceAddress,
  ResourceBoundaryRevision,
  Revision,
  Session,
  SessionId,
  Work,
  WorkId,
  Workspace,
  WorkspaceId,
  WorkspacePolicy,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type {
  LeaseFencingRejected,
  ProjectRepositoryError,
  ResourceOwnershipRepositoryError,
  SessionRepositoryError,
  WorkRepositoryError,
  WorkspaceRepositoryError,
} from "./errors.js";
import type { TransactionScope } from "./session.js";

export interface ProjectRepositoryService {
  readonly findById: (
    projectId: ProjectId,
  ) => Effect.Effect<
    Option.Option<Project>,
    ProjectRepositoryError,
    TransactionScope
  >;
  readonly create: (
    project: Project,
  ) => Effect.Effect<void, ProjectRepositoryError, TransactionScope>;
  readonly updatePolicyIfRevision: (
    projectId: ProjectId,
    expectedRevision: Revision,
    policy: ProjectPolicy,
    newPolicyRevision: Revision,
    newRevision: Revision,
  ) => Effect.Effect<void, ProjectRepositoryError, TransactionScope>;
  readonly closeIfRevision: (
    projectId: ProjectId,
    expectedRevision: Revision,
    newRevision: Revision,
  ) => Effect.Effect<void, ProjectRepositoryError, TransactionScope>;
}

export class ProjectRepository extends Context.Service<
  ProjectRepository,
  ProjectRepositoryService
>()("arbor/ProjectRepository") {}

export interface WorkspaceRepositoryService {
  readonly findById: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<
    Option.Option<Workspace>,
    WorkspaceRepositoryError,
    TransactionScope
  >;
  readonly create: (
    workspace: Workspace,
  ) => Effect.Effect<void, WorkspaceRepositoryError, TransactionScope>;
  readonly changeResponsibilityIfRevision: (
    workspaceId: WorkspaceId,
    expectedRevision: Revision,
    definition: Workspace["responsibilityDefinition"],
    newResponsibilityRevision: Workspace["responsibilityRevision"],
    newRevision: Revision,
  ) => Effect.Effect<void, WorkspaceRepositoryError, TransactionScope>;
  readonly updateResourceBoundaryIfRevision: (
    workspaceId: WorkspaceId,
    expectedRevision: Revision,
    boundary: Workspace["resourceBoundary"],
    newBoundaryRevision: Workspace["resourceBoundaryRevision"],
    newRevision: Revision,
  ) => Effect.Effect<void, WorkspaceRepositoryError, TransactionScope>;
  readonly updatePolicyIfRevision: (
    workspaceId: WorkspaceId,
    expectedRevision: Revision,
    policy: WorkspacePolicy,
    newPolicyRevision: Revision,
    newRevision: Revision,
  ) => Effect.Effect<void, WorkspaceRepositoryError, TransactionScope>;
  readonly selectCurrentWorkIfRevision: (
    workspaceId: WorkspaceId,
    expectedRevision: Revision,
    workId: WorkId,
    newRevision: Revision,
  ) => Effect.Effect<void, WorkspaceRepositoryError, TransactionScope>;
  /** P8 `01` §5: atomic currentWorkId clearing inside the CompleteWork
   * transaction (DID §12.11 Work row). CAS on the Workspace revision; the
   * clear bumps the revision like every Workspace mutation. */
  readonly clearCurrentWorkIfRevision: (
    workspaceId: WorkspaceId,
    expectedRevision: Revision,
    newRevision: Revision,
  ) => Effect.Effect<void, WorkspaceRepositoryError, TransactionScope>;
  readonly replacePrimarySessionIfRevision: (
    workspaceId: WorkspaceId,
    expectedRevision: Revision,
    sessionId: SessionId,
    newRevision: Revision,
  ) => Effect.Effect<void, WorkspaceRepositoryError, TransactionScope>;
  readonly retireIfRevision: (
    workspaceId: WorkspaceId,
    expectedRevision: Revision,
    newRevision: Revision,
  ) => Effect.Effect<void, WorkspaceRepositoryError, TransactionScope>;
  readonly countActiveChildren: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<number, WorkspaceRepositoryError, TransactionScope>;
  readonly hasOpenWork: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<boolean, WorkspaceRepositoryError, TransactionScope>;
}

export class WorkspaceRepository extends Context.Service<
  WorkspaceRepository,
  WorkspaceRepositoryService
>()("arbor/WorkspaceRepository") {}

export interface WorkRepositoryService {
  readonly findById: (
    workId: WorkId,
  ) => Effect.Effect<
    Option.Option<Work>,
    WorkRepositoryError,
    TransactionScope
  >;
  readonly create: (
    work: Work,
  ) => Effect.Effect<void, WorkRepositoryError, TransactionScope>;
  readonly refineIfRevision: (
    workId: WorkId,
    expectedRevision: Work["revision"],
    fields: Pick<
      Work,
      "objective" | "completionExpectation" | "verificationMission"
    >,
    newRevision: Work["revision"],
  ) => Effect.Effect<void, WorkRepositoryError, TransactionScope>;
  readonly completeIfRevision: (
    workId: WorkId,
    expectedRevision: Work["revision"],
  ) => Effect.Effect<void, WorkRepositoryError, TransactionScope>;
  readonly cancelIfRevision: (
    workId: WorkId,
    expectedRevision: Work["revision"],
  ) => Effect.Effect<void, WorkRepositoryError, TransactionScope>;
  readonly listByWorkspace: (
    workspaceId: WorkspaceId,
    lifecycle?: Work["lifecycle"],
  ) => Effect.Effect<
    ReadonlyArray<Work>,
    WorkRepositoryError,
    TransactionScope
  >;
}

export class WorkRepository extends Context.Service<
  WorkRepository,
  WorkRepositoryService
>()("arbor/WorkRepository") {}

export interface SessionRepositoryService {
  readonly findById: (
    sessionId: SessionId,
  ) => Effect.Effect<
    Option.Option<Session>,
    SessionRepositoryError,
    TransactionScope
  >;
  readonly create: (
    session: Session,
  ) => Effect.Effect<void, SessionRepositoryError, TransactionScope>;
  readonly appendEntry: (
    sessionId: SessionId,
    entry: { readonly entryKind: SessionEntryKind; readonly payload: unknown },
    fence?: {
      readonly executionId: ExecutionId;
      /** P12 `06` §3 (TR-9): the full lease-holder triple. The authoritative
       * predicate includes `worker_id`; incarnation-only matching is
       * insufficient, so both the worker and its incarnation are carried.
       * Present on the fenced worker path; absent only on legacy in-process
       * paths that pre-date incarnation fencing. */
      readonly workerId?: string;
      readonly workerIncarnationId?: string;
      readonly fencingGeneration: LeaseGeneration;
    },
  ) => Effect.Effect<
    { readonly sequence: number },
    SessionRepositoryError | LeaseFencingRejected,
    TransactionScope
  >;
  /** P10-007 deps 申报: minimal read-only production read path over
   * session_entries for the Transcript view (on-demand debug projection,
   * never truth — SD §12.4 note). Deterministic (sequence-ascending)
   * cursor paging face. */
  readonly listEntries: (
    sessionId: SessionId,
    afterSequence: number,
    limit: number,
  ) => Effect.Effect<
    ReadonlyArray<SessionEntryRecord>,
    SessionRepositoryError,
    TransactionScope
  >;
  /** P10-007 deps 申报: every session visible for a workspace — the
   * WorkspacePrimary binding plus ExecutionScoped sessions of the
   * workspace's executions. Read-only Transcript scoping face. */
  readonly listSessionsByWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<
    ReadonlyArray<SessionId>,
    SessionRepositoryError,
    TransactionScope
  >;
}

/** P10-007: one session_entries row, read face (payload parsed). */
export interface SessionEntryRecord {
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly entryKind: SessionEntryKind;
  readonly payload: unknown;
  readonly createdAt: string;
}

export type SessionEntryKind =
  | "Input"
  | "ModelOutput"
  | "Observation"
  | "CheckpointReference"
  | "ContextUpdate";

export class SessionRepository extends Context.Service<
  SessionRepository,
  SessionRepositoryService
>()("arbor/SessionRepository") {}

export interface ResourceOwnershipClaimRecord {
  readonly claimId: string;
  readonly workspaceId: WorkspaceId;
  readonly region: CanonicalResourceRegion;
  readonly sourceAddressSnapshot: ResourceAddress;
  readonly resourceBoundaryRevision: ResourceBoundaryRevision;
  readonly resolvedAtEnvironmentRevision: string;
  readonly createdAt: string;
  readonly releasedAt: string | null;
}

export interface ResourceOwnershipRepositoryService {
  readonly loadActiveConflicts: (
    resourceSpaceId: string,
  ) => Effect.Effect<
    ReadonlyArray<ResourceOwnershipClaimRecord>,
    ResourceOwnershipRepositoryError,
    TransactionScope
  >;
  readonly insertClaim: (
    claim: ResourceOwnershipClaimRecord,
  ) => Effect.Effect<void, ResourceOwnershipRepositoryError, TransactionScope>;
  readonly releaseClaim: (
    claimId: string,
    releasedAt: string,
  ) => Effect.Effect<void, ResourceOwnershipRepositoryError, TransactionScope>;
  readonly listActiveByWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<
    ReadonlyArray<ResourceOwnershipClaimRecord>,
    ResourceOwnershipRepositoryError,
    TransactionScope
  >;
}

export class ResourceOwnershipRepository extends Context.Service<
  ResourceOwnershipRepository,
  ResourceOwnershipRepositoryService
>()("arbor/ResourceOwnershipRepository") {}

export type ResolvedResourceAddress = {
  readonly address: ResourceAddress;
  readonly region: import("@arbor/domain").CanonicalResourceRegion;
};
