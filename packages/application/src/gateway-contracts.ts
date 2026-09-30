import type {
  Actor,
  CommandId,
  CommandReceipt,
  CommandSubmissionContext,
  ProjectId,
} from "@arbor/domain";
import type {
  AcceptanceRepositoryError,
  CommandStoreError,
  DeliverableRepositoryError,
  DependencyRepositoryError,
  DomainEventJournalError,
  EnvironmentError,
  EnvironmentRevisionStoreError,
  EvidenceRepositoryError,
  ExecutionRepositoryError,
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
}

export interface CommandOutcome<R> {
  readonly result: R;
  readonly events: ReadonlyArray<PendingDomainEvent>;
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
  | MessageStoreError
  | InboxProjectionStoreError
  | EnvironmentError
  | EnvironmentRevisionStoreError
  | WorktreeStoreError
  | ResourceOwnershipRepositoryError
  | ProjectToolRegistryError
  | PermissionGrantRepositoryError
  | HumanMessageStoreError
  | DependencyRepositoryError
  | DeliverableRepositoryError
  | VerificationRepositoryError
  | AcceptanceRepositoryError
  | EvidenceRepositoryError;

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
  | CommandHandlerError
  | ExecutionRepositoryError
  | TransactionOperationalFailure;

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
