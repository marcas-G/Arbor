import type {
  CommandId,
  ExecutionId,
  PermissionGrantId,
  ProjectId,
  ProviderTurnId,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { DomainEventJournalError, RepositoryFailure } from "./errors.js";
import type { TransactionScope } from "./session.js";

export type AssignWorkControlAuthorizationEvidence =
  | {
      readonly _tag: "PermissionGrant";
      readonly permissionGrantId: PermissionGrantId;
      readonly permissionGrantRevision: number;
      readonly projectId: ProjectId;
      readonly subjectKind: "WorkspaceAgent" | "Execution";
      readonly subjectRef: string;
      readonly capability: "core.control.assign-work";
      readonly targetRef: string;
      readonly validFrom: string;
      readonly expiresAt: string | null;
      readonly actionDigest: string;
      readonly controlBasisDigest: string;
    }
  | {
      readonly _tag: "ActionApproval";
      readonly approvalId: string;
      readonly approvalRevision: number;
      readonly projectId: ProjectId;
      readonly workspaceId: WorkspaceId;
      readonly executionId: ExecutionId;
      readonly stableActionId: "core.control.assign-work";
      readonly actionDigest: string;
      readonly targetRef: string;
      readonly controlBasisDigest: string;
      readonly expiresAt: string;
    };

export interface AssignWorkActionEvidence {
  readonly _tag: "AssignWork";
  readonly targetWorkspaceRef?: string;
  readonly targetWorkspaceId?: WorkspaceId;
  readonly objective: string;
  readonly why: string;
  readonly constraints: ReadonlyArray<string>;
  readonly completionExpectation: string;
  readonly verificationMission: {
    readonly goal: string;
    readonly criteria: ReadonlyArray<{
      readonly criterionId: string;
      readonly requirement: string;
      readonly required: boolean;
    }>;
    readonly riskRequirements: ReadonlyArray<string>;
  };
  readonly reason: string;
}

/** Process-local evidence for an ActionApproval-backed AssignWork to the
 * current Workspace. The Command Gateway consumes this exact approval in the
 * same transaction as Work/event/receipt; it is not a direct-child placement
 * binding and is never constructed from the external command codec. */
export interface AssignWorkApprovalCommandEvidence {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly executionId: ExecutionId;
  readonly providerTurnId: ProviderTurnId;
  readonly logicalActionId: string;
  readonly callRef: string;
  readonly workspaceId: WorkspaceId;
  readonly authority: Extract<
    AssignWorkControlAuthorizationEvidence,
    { readonly _tag: "ActionApproval" }
  >;
  readonly action: AssignWorkActionEvidence;
}

export interface ResolvedChildPlacementRef {
  readonly _tag: "ResolvedChildPlacementRef";
  readonly projectId: ProjectId;
  readonly targetWorkspaceId: WorkspaceId;
  readonly targetWorkspaceRevision: number;
  readonly refEncodingVersion: 1;
}

export interface AssignWorkCommandEvidence {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly executionId: ExecutionId;
  readonly providerTurnId: ProviderTurnId;
  readonly logicalActionId: string;
  readonly callRef: string;
  readonly parentWorkspaceId: WorkspaceId;
  readonly parentWorkId: WorkId;
  readonly targetWorkspaceRef: string;
  readonly target: ResolvedChildPlacementRef;
  readonly authority: AssignWorkControlAuthorizationEvidence;
  readonly action: AssignWorkActionEvidence & {
    readonly targetWorkspaceRef: string;
  };
}

export interface AssignWorkTargetBinding {
  readonly schemaVersion: 1;
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly executionId: ExecutionId;
  readonly providerTurnId: ProviderTurnId;
  readonly logicalActionId: string;
  readonly callRef: string;
  readonly parentWorkspaceId: WorkspaceId;
  readonly parentWorkId: WorkId;
  readonly parentWorkRevisionAtCommand: number;
  readonly targetWorkspaceRef: string;
  readonly targetRefEncodingVersion: 1;
  readonly parentWorkspaceRevisionAtCommand: number;
  readonly targetWorkspaceRevisionAtResolution: number;
  readonly targetWorkspaceId: WorkspaceId;
  readonly targetLifecycleAtCommit: "Active";
  readonly workId: WorkId;
  readonly predecessorWorkId: WorkId;
  readonly workProvenanceJson: string;
  readonly authority: AssignWorkControlAuthorizationEvidence;
  readonly authorityCheckedAt: string;
}

export type AssignWorkTargetBindingStoreError =
  | RepositoryFailure<"AssignWorkTargetBindingRepository">
  | {
      readonly _tag: "AssignWorkTargetBindingInvariantConflict";
      readonly reason: string;
    };

export interface AssignWorkTargetBindingRepositoryService {
  readonly findByCommandId: (
    commandId: CommandId,
  ) => Effect.Effect<
    Option.Option<AssignWorkTargetBinding>,
    AssignWorkTargetBindingStoreError,
    TransactionScope
  >;
  readonly findByExecutionAndAction: (
    executionId: ExecutionId,
    logicalActionId: string,
  ) => Effect.Effect<
    ReadonlyArray<AssignWorkTargetBinding>,
    AssignWorkTargetBindingStoreError,
    TransactionScope
  >;
  readonly insert: (
    binding: AssignWorkTargetBinding,
  ) => Effect.Effect<void, AssignWorkTargetBindingStoreError, TransactionScope>;
}

export class AssignWorkTargetBindingRepository extends Context.Service<
  AssignWorkTargetBindingRepository,
  AssignWorkTargetBindingRepositoryService
>()("arbor/AssignWorkTargetBindingRepository") {}

export type AssignWorkBindingFailureCode =
  | "LegacyUnbound"
  | "MissingBinding"
  | "DuplicateBinding"
  | "MalformedBinding"
  | "RefMismatch"
  | "AuthorityMismatch"
  | "ForeignTarget"
  | "PlacementMismatch"
  | "SourceActionMismatch"
  | "ReceiptMismatch"
  | "WorkMismatch"
  | "ProvenanceMismatch"
  | "EventMismatch"
  | "CommitLifecycleMismatch";

export interface AssignWorkBindingAttentionFact {
  readonly attentionFactId: string;
  readonly projectId: ProjectId;
  readonly executionId: ExecutionId;
  readonly targetWorkspaceId: WorkspaceId;
  readonly logicalActionId: string;
  readonly committedCommandId: CommandId;
  readonly failureCode: AssignWorkBindingFailureCode;
  readonly firstDetectedAt: string;
  readonly eventId: string;
}

export type DeliverReplayFailureCode =
  | "LegacyMessageMissingEvent"
  | "LegacyEventMissingMessage"
  | "LegacyMessageBindingMismatch"
  | "LegacyInboxConflict"
  | "PriorReceiptDecodeMismatch"
  | "PriorReceiptResultMismatch"
  | "RejectedReceiptEffectConflict"
  | "PriorReceiptEffectConflict";

export interface DeliverReplayAttentionFact {
  readonly attentionFactId: string;
  readonly eventId: string;
  readonly projectId: ProjectId;
  readonly executionId: ExecutionId;
  readonly targetWorkspaceId: WorkspaceId;
  readonly logicalActionId: string;
  readonly messageId: string;
  readonly failureCode: DeliverReplayFailureCode;
  readonly firstDetectedAt: string;
}

export type RecordDeliverReplayFailureInput = Omit<
  DeliverReplayAttentionFact,
  "attentionFactId" | "eventId"
> & { readonly causedByCommandId?: CommandId };

export type RecordAssignWorkBindingFailureInput = Omit<
  AssignWorkBindingAttentionFact,
  "attentionFactId" | "eventId"
>;

export type SubmittedDecisionBindingFailureCode =
  | "DecisionRequestWorkspaceMismatch"
  | "StepManifestMismatch"
  | "SettledExecutionWithPendingDecisionAction";

export interface SubmittedDecisionBindingAttentionFact {
  readonly attentionFactId: string;
  readonly eventId: string;
  readonly projectId: ProjectId;
  readonly executionId: ExecutionId;
  readonly workspaceId: WorkspaceId;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly providerTurnId: ProviderTurnId;
  readonly logicalActionId: string;
  readonly failureCode: SubmittedDecisionBindingFailureCode;
  readonly firstDetectedAt: string;
}

/** Fully identified, already event-bound immutable fact to persist. This
 * storage port does not create the business event or derive the fact identity. */
export type RecordSubmittedDecisionBindingFailureInput =
  SubmittedDecisionBindingAttentionFact;

export type RecoveryAttentionFactStoreError =
  | RepositoryFailure<"RecoveryAttentionFactStore">
  | DomainEventJournalError
  | {
      readonly _tag: "RecoveryAttentionFactInvariantConflict";
      readonly reason: string;
    };

export interface RecoveryAttentionFactStoreService {
  readonly isSubmittedDecisionBindingAvailable?: () => Effect.Effect<
    boolean,
    RecoveryAttentionFactStoreError,
    TransactionScope
  >;
  readonly recordAssignWorkBindingFailure: (
    fact: RecordAssignWorkBindingFailureInput,
  ) => Effect.Effect<
    AssignWorkBindingAttentionFact,
    RecoveryAttentionFactStoreError,
    TransactionScope
  >;
  readonly findAssignWorkBindingFailure: (
    attentionFactId: string,
  ) => Effect.Effect<
    Option.Option<AssignWorkBindingAttentionFact>,
    RecoveryAttentionFactStoreError,
    TransactionScope
  >;
  readonly recordDeliverReplayFailure: (
    fact: RecordDeliverReplayFailureInput,
  ) => Effect.Effect<
    DeliverReplayAttentionFact,
    RecoveryAttentionFactStoreError,
    TransactionScope
  >;
  readonly findDeliverReplayFailure: (
    attentionFactId: string,
  ) => Effect.Effect<
    Option.Option<DeliverReplayAttentionFact>,
    RecoveryAttentionFactStoreError,
    TransactionScope
  >;
  readonly findDeliverReplayFailureByEventId: (
    eventId: string,
  ) => Effect.Effect<
    Option.Option<DeliverReplayAttentionFact>,
    RecoveryAttentionFactStoreError,
    TransactionScope
  >;
  readonly listDeliverReplayFailures: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<DeliverReplayAttentionFact>,
    RecoveryAttentionFactStoreError,
    TransactionScope
  >;
  readonly listPendingDeliverReplayAttention: (
    projectId: ProjectId,
    limit: number,
  ) => Effect.Effect<
    ReadonlyArray<DeliverReplayAttentionFact>,
    RecoveryAttentionFactStoreError,
    TransactionScope
  >;
  readonly acknowledgePendingDeliverReplayAttention: (
    attentionFactId: string,
  ) => Effect.Effect<void, RecoveryAttentionFactStoreError, TransactionScope>;
  readonly recordSubmittedDecisionBindingFailure?: (
    fact: RecordSubmittedDecisionBindingFailureInput,
  ) => Effect.Effect<
    SubmittedDecisionBindingAttentionFact,
    RecoveryAttentionFactStoreError,
    TransactionScope
  >;
  readonly findSubmittedDecisionBindingFailure?: (
    attentionFactId: string,
  ) => Effect.Effect<
    Option.Option<SubmittedDecisionBindingAttentionFact>,
    RecoveryAttentionFactStoreError,
    TransactionScope
  >;
  readonly listSubmittedDecisionBindingFailures?: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<SubmittedDecisionBindingAttentionFact>,
    RecoveryAttentionFactStoreError,
    TransactionScope
  >;
}

export type SubmittedDecisionBindingFailureCode =
  | "DecisionRequestWorkspaceMismatch"
  | "StepManifestMismatch"
  | "SettledExecutionWithPendingDecisionAction";

export interface SubmittedDecisionBindingAttentionFact {
  readonly attentionFactId: string;
  readonly eventId: string;
  readonly projectId: ProjectId;
  readonly executionId: ExecutionId;
  readonly workspaceId: WorkspaceId;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly providerTurnId: ProviderTurnId;
  readonly logicalActionId: string;
  readonly failureCode: SubmittedDecisionBindingFailureCode;
  readonly firstDetectedAt: string;
}

/** Fully identified immutable fact; the Runtime owns event creation and binds
 * its exact journal id before asking persistence to store the witness. */
export type RecordSubmittedDecisionBindingFailureInput =
  SubmittedDecisionBindingAttentionFact;

export class RecoveryAttentionFactStore extends Context.Service<
  RecoveryAttentionFactStore,
  RecoveryAttentionFactStoreService
>()("arbor/RecoveryAttentionFactStore") {}
