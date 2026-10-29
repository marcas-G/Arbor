import type {
  Actor,
  CanonicalResourceRegion,
  CommandId,
  ProjectId,
  ResourceAddress,
  ResourceBoundaryRevision,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type {
  DomainEventJournalError,
  EnvironmentError,
  EnvironmentRevisionStoreError,
  ResourceOwnershipRepositoryError,
  ResourceResolutionStale,
  WorkspaceRepositoryError,
} from "./errors.js";
import type { ResourceOwnershipClaimRecord } from "./repositories.js";
import type {
  TransactionOperationalFailure,
  TransactionScope,
} from "./session.js";
import type { WorkspaceResourceActivationStoreError } from "./workspace-resource-activation.js";

/**
 * P11 `01` §3 store mapping: the stored string IS the counter. The typed
 * surface makes the two lazy/legal writes distinguishable (P1-DG-08):
 *
 *  - lazyInitAnchor(projectId)  — the FIRST successful ownership write records
 *    the initial anchor "1" (initialization, not an environment change).
 *  - record(projectId, revision) — the ownership-write face.
 *
 * P12 `05` §5.1 (TR-1): the CAS successor advancement face is **not** on
 * this public surface. It is an internal, non-exported capability reached
 * only through the governed `RecordEnvironmentChange` command path (CI-1), so
 * no observation-side code can import or invoke it. There is no other
 * advancement path on this port.
 */
export interface EnvironmentRevisionStoreService {
  readonly current: (
    projectId: ProjectId,
  ) => Effect.Effect<
    Option.Option<string>,
    EnvironmentRevisionStoreError,
    TransactionScope
  >;
  /** Read-only raw view (persistence boundary; validated by callers). */
  readonly record: (
    projectId: ProjectId,
    revision: string,
  ) => Effect.Effect<void, EnvironmentRevisionStoreError, TransactionScope>;
  /** P1-DG-08 lazy-init: no-op if an anchor already exists. */
  readonly lazyInitAnchor: (
    projectId: ProjectId,
  ) => Effect.Effect<void, EnvironmentRevisionStoreError, TransactionScope>;
}

export class EnvironmentRevisionStore extends Context.Service<
  EnvironmentRevisionStore,
  EnvironmentRevisionStoreService
>()("arbor/EnvironmentRevisionStore") {}

export interface ResolvedEnvironment {
  readonly regions: ReadonlyArray<CanonicalResourceRegion>;
  readonly observedEnvironmentRevision: string;
}

export interface ProjectEnvironmentPortService {
  readonly resolve: (
    projectId: ProjectId,
    addresses: ReadonlyArray<ResourceAddress>,
  ) => Effect.Effect<ResolvedEnvironment, EnvironmentError>;
}

export class ProjectEnvironmentPort extends Context.Service<
  ProjectEnvironmentPort,
  ProjectEnvironmentPortService
>()("arbor/ProjectEnvironmentPort") {}

export interface OwnershipWriteResult {
  readonly regions: ReadonlyArray<CanonicalResourceRegion>;
  readonly claims: ReadonlyArray<ResourceOwnershipClaimRecord>;
}

export interface OwnershipWriteServiceService {
  readonly resolveAndWrite: (
    projectId: ProjectId,
    addresses: ReadonlyArray<ResourceAddress>,
    claims: ReadonlyArray<ResourceOwnershipClaimRecord>,
  ) => Effect.Effect<
    OwnershipWriteResult,
    | EnvironmentError
    | ResourceOwnershipRepositoryError
    | ResourceResolutionStale
    | TransactionOperationalFailure
    | EnvironmentRevisionStoreError
  >;
  readonly activatePendingWorkspaceResource: (
    projectId: ProjectId,
    workspaceId: WorkspaceId,
    resourceBoundaryRevision: ResourceBoundaryRevision,
    addresses: ReadonlyArray<ResourceAddress>,
  ) => Effect.Effect<
    { readonly _tag: "Activated" } | { readonly _tag: "AlreadyActive" },
    | EnvironmentError
    | ResourceOwnershipRepositoryError
    | ResourceResolutionStale
    | TransactionOperationalFailure
    | EnvironmentRevisionStoreError
    | WorkspaceResourceActivationStoreError
    | WorkspaceRepositoryError
    | DomainEventJournalError
  >;
  /** S3 activation consumes the exact durable Parent-approved delegation
   * identity. Canonical resolution happens before BEGIN IMMEDIATE; all
   * revision checks, claims, intent settlement, and event append are atomic. */
  readonly activateDelegatedOwnership: (input: {
    readonly projectId: ProjectId;
    readonly childWorkspaceId: WorkspaceId;
    readonly childResourceBoundaryRevision: ResourceBoundaryRevision;
    readonly delegationSourceId: string;
  }) => Effect.Effect<
    | {
        readonly _tag: "Activated";
        readonly parentClaim: ResourceOwnershipClaimRecord;
        readonly childClaim: ResourceOwnershipClaimRecord;
      }
    | {
        readonly _tag: "AlreadyActive";
        readonly parentClaim: ResourceOwnershipClaimRecord;
        readonly childClaim: ResourceOwnershipClaimRecord;
      },
    | EnvironmentError
    | ResourceOwnershipRepositoryError
    | ResourceResolutionStale
    | TransactionOperationalFailure
    | EnvironmentRevisionStoreError
    | WorkspaceResourceActivationStoreError
    | WorkspaceRepositoryError
    | DomainEventJournalError
  >;
  /** Reclaim the exact delegated Child claim. `retireChild` folds the
   * Workspace lifecycle CAS into the same ownership/event transaction. The
   * caller must supply its checked, exact quiescence preconditions. */
  readonly reclaimDelegatedOwnership: (input: {
    readonly projectId: ProjectId;
    readonly childWorkspaceId: WorkspaceId;
    readonly delegationSourceId: string;
    readonly expectedParentWorkspaceRevision: number;
    readonly expectedChildWorkspaceRevision: number;
    readonly expectedParentBoundaryRevision: ResourceBoundaryRevision;
    readonly expectedChildBoundaryRevision: ResourceBoundaryRevision;
    readonly expectedParentClaimRevision: number;
    readonly expectedChildClaimRevision: number;
    readonly actor: Actor;
    readonly causedByCommandId: CommandId;
    readonly retireChild: boolean;
    readonly quiescence: {
      readonly noUnresolvedEffects: boolean;
      readonly noActiveExecution: boolean;
      readonly noOpenWork: boolean;
      readonly noActiveChildren: boolean;
      readonly noUnresolvedIncomingDependencies: boolean;
    };
  }) => Effect.Effect<
    {
      readonly _tag: "Reclaimed" | "AlreadyReclaimed";
      readonly parentClaim: ResourceOwnershipClaimRecord;
      readonly childClaim: ResourceOwnershipClaimRecord;
      readonly childRetired: boolean;
    },
    | EnvironmentError
    | ResourceOwnershipRepositoryError
    | ResourceResolutionStale
    | TransactionOperationalFailure
    | EnvironmentRevisionStoreError
    | WorkspaceRepositoryError
    | DomainEventJournalError
  >;
}

export class OwnershipWriteService extends Context.Service<
  OwnershipWriteService,
  OwnershipWriteServiceService
>()("arbor/OwnershipWriteService") {}
