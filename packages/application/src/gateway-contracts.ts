import type {
  Actor,
  CommandId,
  CommandReceipt,
  CommandSubmissionContext,
  ProjectId,
} from "@arbor/domain";
import type {
  AcceptanceRepositoryError,
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
  ResourceOwnershipRepositoryError,
  SchedulerTimerStoreError,
  SessionRepositoryError,
  TransactionOperationalFailure,
  TransactionScope,
  VerificationRepositoryError,
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
}

/**
 * Explicitly erases a typed handler at the registry boundary. The gateway
 * decodes and validates the payload before invoking this handler; keeping the
 * unavoidable variance cast here prevents individual registries from hiding
 * ad-hoc `as unknown as` conversions in business wiring.
 */
export const eraseCommandHandler = <C, R>(
  handler: CommandHandler<C, R>,
): CommandHandler<unknown, unknown> => ({
  commandType: handler.commandType,
  schemaVersion: handler.schemaVersion,
  authority: handler.authority as CommandAuthorityRule<unknown>,
  stopAdmission: handler.stopAdmission,
  execute: (envelope, context) =>
    handler.execute(envelope as GatewayEnvelope<C>, context) as Effect.Effect<
      CommandResult<CommandOutcome<unknown>>,
      CommandHandlerError,
      TransactionScope
    >,
});

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
  | DependencyRepositoryError
  | DeliverableRepositoryError
  | VerificationRepositoryError
  | AcceptanceRepositoryError
  | EvidenceRepositoryError
  | AssignWorkTargetBindingStoreError;

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
