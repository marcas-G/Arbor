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
  SubmittedDecisionBindingAttentionFact,
  SubmittedDecisionBindingFailureCode,
} from "./assign-work-target-binding.js";
import type { RepositoryFailure } from "./errors.js";
import type {
  LegacyAdoptionAttentionFact,
  LegacyAdoptionAttentionResolutionFact,
} from "./legacy-adoption-attention.js";
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

export interface SubmittedDecisionBindingAttentionProjectionRow {
  readonly projectId: ProjectId;
  readonly attentionFactId: string;
  readonly workspaceId: WorkspaceId;
  readonly firstDetectedAt: string;
  readonly dedupKey: string;
  readonly source: "SubmittedDecisionBindingFailure";
  readonly severity: "ActionRequired";
  readonly targetWorkspaceId: WorkspaceId;
  readonly summary: string;
  readonly failureCode: SubmittedDecisionBindingFailureCode;
  readonly occurredAt: string;
  readonly sourceEventId: EventId;
  readonly sourceFactId: string;
  readonly sourceExecutionId: string;
}

export interface LegacyAdoptionAttentionProjectionRow {
  readonly projectId: ProjectId;
  readonly attentionFactId: string;
  readonly workspaceId: WorkspaceId;
  readonly failureCode: "LegacyActionDispositionUnproven";
  readonly firstDetectedAt: string;
  readonly sourceEventId: EventId;
  readonly sourceFactId: string;
  readonly sourceExecutionId: string;
}

export interface SandboxProviderUnavailableAttentionProjectionRow {
  readonly projectId: ProjectId;
  readonly attentionFactId: string;
  readonly workspaceId: WorkspaceId;
  readonly executionId: string;
  readonly policyRevision: number;
  readonly firstDetectedAt: string;
}

/** Strict P10 query result derived from the immutable P4 invocation and
 * RecoveryBinding rows. This is never persisted. */
export interface SandboxRecoveryBindingFailureProjectionRow {
  readonly projectId: ProjectId;
  readonly executionId: string;
  readonly invocationId: string;
  readonly workspaceId: WorkspaceId;
  readonly attentionFactId: string;
  readonly intentAt: string;
}

export interface SandboxPolicyDecisionRequiredProjectionRow {
  readonly projectId: ProjectId;
  readonly executionId: string;
  readonly invocationId: string;
  readonly workspaceId: WorkspaceId;
  readonly attentionFactId: string;
  readonly intentAt: string;
}

export type AttentionProjectionStoreError =
  RepositoryFailure<"AttentionProjectionStore">;

export interface AttentionProjectionStoreService {
  readonly isSubmittedDecisionBindingAvailable?: () => Effect.Effect<
    boolean,
    AttentionProjectionStoreError,
    TransactionScope
  >;
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
  readonly putSubmittedDecisionBindingFailure?: (
    fact: SubmittedDecisionBindingAttentionFact,
  ) => Effect.Effect<void, AttentionProjectionStoreError, TransactionScope>;
  readonly putLegacyAdoptionFailure?: (
    fact: LegacyAdoptionAttentionFact,
  ) => Effect.Effect<void, AttentionProjectionStoreError, TransactionScope>;
  readonly removeLegacyAdoptionFailure?: (
    failure: LegacyAdoptionAttentionFact,
    resolution: LegacyAdoptionAttentionResolutionFact,
  ) => Effect.Effect<void, AttentionProjectionStoreError, TransactionScope>;
  readonly listSubmittedDecisionBindingFailures?: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<SubmittedDecisionBindingAttentionProjectionRow>,
    AttentionProjectionStoreError,
    TransactionScope
  >;
  readonly listLegacyAdoptionFailures?: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<LegacyAdoptionAttentionProjectionRow>,
    AttentionProjectionStoreError,
    TransactionScope
  >;
  readonly listProjectedSandboxProviderUnavailableFailures?: (
    projectId: ProjectId,
    now: string,
  ) => Effect.Effect<
    ReadonlyArray<SandboxProviderUnavailableAttentionProjectionRow>,
    AttentionProjectionStoreError,
    TransactionScope
  >;
  readonly listSandboxRecoveryBindingFailures?: (
    projectId: ProjectId,
    now: string,
  ) => Effect.Effect<
    ReadonlyArray<SandboxRecoveryBindingFailureProjectionRow>,
    AttentionProjectionStoreError,
    TransactionScope
  >;
  readonly listSandboxPolicyDecisionRequired?: (
    projectId: ProjectId,
    now: string,
  ) => Effect.Effect<
    ReadonlyArray<SandboxPolicyDecisionRequiredProjectionRow>,
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
