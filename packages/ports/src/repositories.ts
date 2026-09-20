import type {
  Project,
  ProjectId,
  ProjectPolicy,
  ResourceAddress,
  ResourceOwnershipClaim,
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
}

export class SessionRepository extends Context.Service<
  SessionRepository,
  SessionRepositoryService
>()("arbor/SessionRepository") {}

export interface ResourceOwnershipRepositoryService {
  readonly loadActiveConflicts: (
    resourceSpaceId: string,
  ) => Effect.Effect<
    ReadonlyArray<ResourceOwnershipClaim>,
    ResourceOwnershipRepositoryError,
    TransactionScope
  >;
  readonly insertClaim: (
    claim: ResourceOwnershipClaim,
  ) => Effect.Effect<void, ResourceOwnershipRepositoryError, TransactionScope>;
  readonly releaseClaim: (
    claimId: string,
    releasedAt: string,
  ) => Effect.Effect<void, ResourceOwnershipRepositoryError, TransactionScope>;
  readonly listActiveByWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<
    ReadonlyArray<ResourceOwnershipClaim>,
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
