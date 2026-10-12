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
  DeliverReplayAttentionFact,
  DeliverReplayFailureCode,
} from "./assign-work-target-binding.js";
import type { RepositoryFailure } from "./errors.js";
import type { TransactionScope } from "./session.js";
import type { ToolObservationReplayFailureCode } from "./tool-observation-evidence.js";
import type { ToolObservationReplayAttentionFact } from "./tool-observation-replay-attention.js";
import type { WorkspaceResourceActivationIntent } from "./workspace-resource-activation.js";

export interface ToolObservationReplayAttentionProjectionRow {
  readonly projectId: ProjectId;
  readonly dedupKey: string;
  readonly source: "ToolObservationReplayEvidenceFailure";
  readonly severity: "ActionRequired";
  readonly targetWorkspaceId: WorkspaceId;
  readonly summary: "A terminal tool outcome could not be replayed from durable observation evidence; recovery is paused.";
  readonly failureCode: ToolObservationReplayFailureCode;
  readonly occurredAt: string;
  readonly sourceEventId: EventId;
  readonly sourceFactId: string;
}

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
  /** Internal P10 read binding; omitted from Attention response rows. */
  readonly sourceExecutionId: string;
}

export interface WorkspaceResourceActivationAttentionProjectionRow {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly resourceBoundaryRevision: ResourceBoundaryRevision;
  readonly occurredAt: string;
}

export interface DeliverReplayAttentionProjectionRow {
  readonly projectId: ProjectId;
  readonly dedupKey: string;
  readonly source: "DeliverReplayFailure";
  readonly severity: "ActionRequired";
  readonly targetWorkspaceId: WorkspaceId;
  readonly summary: string;
  readonly failureCode: DeliverReplayFailureCode;
  readonly occurredAt: string;
  readonly sourceEventId: EventId;
  readonly sourceFactId: string;
  /** Internal P10 read binding; omitted from Attention response rows. */
  readonly sourceExecutionId: string;
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
  readonly putDeliverReplayFailure: (
    fact: DeliverReplayAttentionFact,
  ) => Effect.Effect<void, AttentionProjectionStoreError, TransactionScope>;
  readonly listDeliverReplayFailures: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<DeliverReplayAttentionProjectionRow>,
    AttentionProjectionStoreError,
    TransactionScope
  >;
  readonly putToolObservationReplayFailure?: (
    fact: ToolObservationReplayAttentionFact,
    occurredAt: string,
  ) => Effect.Effect<void, AttentionProjectionStoreError, TransactionScope>;
  readonly listToolObservationReplayFailures?: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<ToolObservationReplayAttentionProjectionRow>,
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
  /** Remove valid, superseded Work-revision rows from the P10 active set;
   * immutable P9 facts/events remain untouched. */
  readonly reconcileStaleWorkRevisionRows: (
    projectId: ProjectId,
  ) => Effect.Effect<void, AttentionProjectionStoreError, TransactionScope>;
  readonly resetProject: (
    projectId: ProjectId,
  ) => Effect.Effect<void, AttentionProjectionStoreError, TransactionScope>;
}

export class AttentionProjectionStore extends Context.Service<
  AttentionProjectionStore,
  AttentionProjectionStoreService
>()("arbor/AttentionProjectionStore") {}
