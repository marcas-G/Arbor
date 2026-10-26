import type {
  Actor,
  CommandId,
  ProjectId,
  ResourceAddress,
  ResourceBoundaryRevision,
  Revision,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { RepositoryFailure } from "./errors.js";
import type { TransactionScope } from "./session.js";

export interface WorkspaceResourceActivationIntent {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly resourceBoundaryRevision: ResourceBoundaryRevision;
  readonly status: "Pending" | "Active";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activatedAt: string | null;
  /** Present only for an exact Parent-approved S3 ownership delegation. */
  readonly delegation?: WorkspaceResourceDelegationIntent | null;
}

/** Durable approval and revision binding for one Child ownership carve-out.
 * Addresses are the approved subset; canonical meaning is resolved by P11
 * immediately before the atomic activation transaction. */
export interface WorkspaceResourceDelegationIntent {
  readonly delegationSourceId: string;
  readonly formationProposalId: string;
  readonly formationProposalRevision: number;
  readonly addresses: ReadonlyArray<ResourceAddress>;
  readonly approvedBy: Actor;
  readonly causedByCommandId: CommandId;
  readonly parentWorkspaceId: WorkspaceId;
  readonly expectedParentWorkspaceRevision: Revision;
  readonly expectedChildWorkspaceRevision: Revision;
  readonly expectedParentBoundaryRevision: ResourceBoundaryRevision;
  readonly expectedParentOwnershipRevision: number;
  readonly expectedChildOwnershipRevision: number;
}

export type NewWorkspaceResourceActivationIntent = Omit<
  WorkspaceResourceActivationIntent,
  "status" | "activatedAt"
> & { readonly status: "Pending"; readonly activatedAt: null };

export type WorkspaceResourceActivationStoreError =
  RepositoryFailure<"WorkspaceResourceActivationStore">;

export interface WorkspaceResourceActivationStoreService {
  readonly insertPending: (
    intent: NewWorkspaceResourceActivationIntent,
  ) => Effect.Effect<
    void,
    WorkspaceResourceActivationStoreError,
    TransactionScope
  >;
  readonly find: (
    projectId: ProjectId,
    workspaceId: WorkspaceId,
    resourceBoundaryRevision: ResourceBoundaryRevision,
  ) => Effect.Effect<
    Option.Option<WorkspaceResourceActivationIntent>,
    WorkspaceResourceActivationStoreError,
    TransactionScope
  >;
  readonly compareAndSetActive: (
    projectId: ProjectId,
    workspaceId: WorkspaceId,
    resourceBoundaryRevision: ResourceBoundaryRevision,
    activatedAt: string,
    updatedAt: string,
    delegationSourceId?: string,
  ) => Effect.Effect<
    boolean,
    WorkspaceResourceActivationStoreError,
    TransactionScope
  >;
  readonly listPending: (
    projectId?: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<WorkspaceResourceActivationIntent>,
    WorkspaceResourceActivationStoreError,
    TransactionScope
  >;
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<WorkspaceResourceActivationIntent>,
    WorkspaceResourceActivationStoreError,
    TransactionScope
  >;
}

export class WorkspaceResourceActivationStore extends Context.Service<
  WorkspaceResourceActivationStore,
  WorkspaceResourceActivationStoreService
>()("arbor/WorkspaceResourceActivationStore") {}
