import type {
  Actor,
  CommandId,
  CommandReceipt,
  CommandSubmissionContext,
  ProjectId,
} from "@arbor/domain";
import type {
  AcceptanceRepositoryError,
  AssignWorkApprovalCommandEvidence,
  AssignWorkCommandEvidence,
  AssignWorkTargetBindingStoreError,
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
  ReadmissionGateIntegrityFailure,
  ReadmissionGateStoreError,
  ReadmissionTargetMismatch,
  ResourceOwnershipRepositoryError,
  SchedulerTimerStoreError,
  SessionRepositoryError,
  ToolInvocationStoreError,
  TransactionOperationalFailure,
  TransactionScope,
  VerificationRepositoryError,
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
  | SessionRepositoryError
  | ExecutionRepositoryError
  | WorkWaitStoreError
  | SchedulerTimerStoreError
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
  | AssignWorkTargetBindingStoreError
  | ReadmissionTargetMismatch
  | ReadmissionGateIntegrityFailure
  | ReadmissionGateStoreError
  | WorkReadmissionHeld;

export interface CommandHandler<C, R> {
  readonly commandType: string;
  readonly schemaVersion: string;
  readonly authority: CommandAuthorityRule<C>;
  readonly stopAdmission: StopAdmission;
  readonly execute: (
    envelope: GatewayEnvelope<C>,
    context: CommandSubmissionContext,
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
