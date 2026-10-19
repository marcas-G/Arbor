import type {
  Actor,
  CommandId,
  CommandReceipt,
  CommandSubmissionContext,
  ProjectId,
} from "@arbor/domain";
import type {
  AcceptanceRepositoryError,
  AgentLoopStepStoreError,
  AssignWorkApprovalCommandEvidence,
  AssignWorkCommandEvidence,
  AssignWorkTargetBindingStoreError,
  BlobStoreError,
  CommandStoreError,
  ControlApprovalStoreError,
  ConversationJobStoreError,
  DeliverableRepositoryError,
  DependencyRepositoryError,
  DomainEventJournalError,
  EnvironmentError,
  EnvironmentRevisionStoreError,
  EvidenceRepositoryError,
  ExecutionRepositoryError,
  FormationFulfillmentStoreError,
  FormationProposalStoreError,
  HumanMessageStoreError,
  InboxProjectionStoreError,
  MessageStoreError,
  PendingDomainEvent,
  PermissionGrantRepositoryError,
  ProjectRepositoryError,
  ProjectToolRegistryError,
  ProviderFailure,
  ReadmissionGateIntegrityFailure,
  ReadmissionGateStoreError,
  ReadmissionTargetMismatch,
  ResourceOwnershipRepositoryError,
  RetryVerificationOriginRepositoryError,
  SandboxPolicyDecisionStoreError,
  SchedulerTimerStoreError,
  SessionRepositoryError,
  ToolInvocationStoreError,
  TransactionOperationalFailure,
  TransactionScope,
  VerificationRepositoryError,
  WorkBlockerStoreError,
  WorkReadmissionHeld,
  WorkRepositoryError,
  WorkspaceRepositoryError,
  WorkspaceResourceActivationStoreError,
  WorktreeStoreError,
  WorkWaitStoreError,
} from "@arbor/ports";
import { Context, type Effect } from "effect";
import type {
  CommandAuthorityFact,
  CommandAuthorityRule,
  StopAdmission,
} from "./authority.js";
import type { CommandResult } from "./command-result.js";
import type { CommandInputIssue } from "./external-command-codec.js";
import type { CommandRejection } from "./rejection.js";

export interface GatewayEnvelope<C> {
  readonly commandType: string;
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly actor: Actor;
  readonly issuedAt: string;
  readonly causationRef?: string;
  readonly correlationRef?: string;
  readonly payload: C;
  /** Process-local Authority Resolver result attached by CommandGateway only
   * after exact submission/fingerprint validation. Never accepted on wire or
   * included in semantic payload fingerprints. */
  readonly resolvedAuthority?: CommandAuthorityFact;
  /** Trusted in-process ControlAction evidence; never part of model output. */
  readonly assignWorkEvidence?: AssignWorkCommandEvidence;
  /** Exact ActionApproval evidence for current-Workspace AssignWork; consumed
   * by the AssignWork handler in this command transaction. */
  readonly assignWorkApprovalEvidence?: AssignWorkApprovalCommandEvidence;
}

export interface CommandOutcome<R> {
  readonly result: R;
  readonly events: ReadonlyArray<PendingDomainEvent>;
  /** Runs after receipt insertion, still within the owning Command transaction. */
  readonly afterReceipt?: Effect.Effect<
    void,
    AssignWorkTargetBindingStoreError,
    TransactionScope
  >;
}

/** Every typed failure that an in-transaction command handler may expose.
 * Adapter-specific failures have already been normalized by their Port. */
export type CommandHandlerError =
  | ProjectRepositoryError
  | WorkspaceRepositoryError
  | WorkRepositoryError
  | WorkBlockerStoreError
  | SessionRepositoryError
  | ExecutionRepositoryError
  | WorkWaitStoreError
  | SchedulerTimerStoreError
  | SandboxPolicyDecisionStoreError
  | CommandStoreError
  | DomainEventJournalError
  | FormationProposalStoreError
  | FormationFulfillmentStoreError
  | MessageStoreError
  | InboxProjectionStoreError
  | EnvironmentError
  | EnvironmentRevisionStoreError
  | WorktreeStoreError
  | WorkspaceResourceActivationStoreError
  | ResourceOwnershipRepositoryError
  | ProjectToolRegistryError
  | PermissionGrantRepositoryError
  | HumanMessageStoreError
  | ConversationJobStoreError
  | ControlApprovalStoreError
  | ToolInvocationStoreError
  | DependencyRepositoryError
  | DeliverableRepositoryError
  | VerificationRepositoryError
  | AcceptanceRepositoryError
  | EvidenceRepositoryError
  | RetryVerificationOriginRepositoryError
  | BlobStoreError
  | AssignWorkTargetBindingStoreError
  | AgentLoopStepStoreError
  | ProviderFailure
  | ReadmissionTargetMismatch
  | ReadmissionGateIntegrityFailure
  | ReadmissionGateStoreError
  | WorkReadmissionHeld;

export interface CommandHandler<C, R> {
  readonly commandType: string;
  readonly schemaVersion: string;
  /** Historical receipt versions a handler can validate read-only on replay. */
  readonly priorReceiptSchemaVersions?: ReadonlyArray<string>;
  readonly authority: CommandAuthorityRule<C>;
  readonly stopAdmission: StopAdmission;
  /** Read-only canonical binding check before a stored receipt is replayed. */
  readonly validateReceiptReplay?: (
    receipt: CommandReceipt<R, CommandRejection>,
    payload: C,
    envelope: GatewayEnvelope<C>,
    context: CommandSubmissionContext,
  ) => Effect.Effect<void, CommandHandlerError, TransactionScope>;
  /** Optional read-only preparation hook. The Gateway runs it only after an
   * advisory receipt miss and before BEGIN IMMEDIATE; its output is not
   * authority and must be revalidated by execute inside the transaction. */
  readonly prepare?: (
    envelope: GatewayEnvelope<C>,
    context: CommandSubmissionContext,
    authority: CommandAuthorityFact,
  ) => Effect.Effect<
    unknown,
    CommandHandlerError | TransactionOperationalFailure
  >;
  readonly execute: (
    envelope: GatewayEnvelope<C>,
    context: CommandSubmissionContext,
    prepared?: unknown,
  ) => Effect.Effect<
    CommandResult<CommandOutcome<R>>,
    CommandHandlerError,
    TransactionScope
  >;
}

export type CommandGatewayError =
  | InternalCommandContractDefect
  | CommandHandlerError
  | ExecutionRepositoryError
  | TransactionOperationalFailure;

/** A typed internal caller violated the registered command payload contract.
 * This is a non-command defect: it is never persisted as a receipt, attempt,
 * authority rejection, or domain event. */
export interface InternalCommandContractDefect {
  readonly _tag: "InternalCommandContractDefect";
  readonly commandType: string;
  readonly issues: ReadonlyArray<CommandInputIssue>;
}

export interface CommandGatewayService {
  readonly execute: <C, R>(
    envelope: GatewayEnvelope<C>,
    context: CommandSubmissionContext,
    authority: CommandAuthorityFact,
  ) => Effect.Effect<CommandReceipt<R, CommandRejection>, CommandGatewayError>;
}

export class CommandGateway extends Context.Service<
  CommandGateway,
  CommandGatewayService
>()("arbor/CommandGateway") {}
