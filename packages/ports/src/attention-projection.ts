import type {
  EventId,
  ProjectId,
  ResourceBoundaryRevision,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect } from "effect";
import type {
  AssignWorkBindingAttentionFact,
  AssignWorkBindingFailureCode,
} from "./assign-work-target-binding.js";
import type { RepositoryFailure } from "./errors.js";
import type { TransactionScope } from "./session.js";
import type { WorkspaceResourceActivationIntent } from "./workspace-resource-activation.js";

export interface AssignWorkBindingAttentionProjectionRow {
  readonly projectId: ProjectId;
  readonly dedupKey: string;
  readonly source: "AssignWorkTargetBindingFailure";
  readonly severity: "ActionRequired";
  readonly targetWorkspaceId: WorkspaceId;
  readonly summary: string;
  readonly failureCode: AssignWorkBindingFailureCode;
  readonly occurredAt: string;
  readonly sourceEventId: EventId;
  readonly sourceFactId: string;
}

export interface WorkspaceResourceActivationAttentionProjectionRow {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly resourceBoundaryRevision: ResourceBoundaryRevision;
  readonly occurredAt: string;
}

export type AttentionProjectionStoreError =
  RepositoryFailure<"AttentionProjectionStore">;

export interface AttentionProjectionStoreService {
  readonly putAssignWorkBindingFailure: (
    fact: AssignWorkBindingAttentionFact,
    occurredAt: string,
  ) => Effect.Effect<void, AttentionProjectionStoreError, TransactionScope>;
  readonly listAssignWorkBindingFailures: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<AssignWorkBindingAttentionProjectionRow>,
    AttentionProjectionStoreError,
    TransactionScope
  >;
  readonly reconcileWorkspaceResourceActivation: (
    projectId: ProjectId,
    intents: ReadonlyArray<WorkspaceResourceActivationIntent>,
  ) => Effect.Effect<void, AttentionProjectionStoreError, TransactionScope>;
  readonly listWorkspaceResourceActivationPending: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<WorkspaceResourceActivationAttentionProjectionRow>,
    AttentionProjectionStoreError,
    TransactionScope
  >;
  readonly resetProject: (
    projectId: ProjectId,
  ) => Effect.Effect<void, AttentionProjectionStoreError, TransactionScope>;
}

export class AttentionProjectionStore extends Context.Service<
  AttentionProjectionStore,
  AttentionProjectionStoreService
>()("arbor/AttentionProjectionStore") {}
