import type {
  FormationProposalId,
  FormationProposalRecord,
  InboxEntry,
  MessageId,
  OutboundMessage,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { RepositoryFailure } from "./errors.js";
import type { TransactionScope } from "./session.js";

export type FormationProposalStoreError =
  RepositoryFailure<"FormationProposalStore">;
export type MessageStoreError = RepositoryFailure<"MessageStore">;
export type InboxProjectionStoreError =
  RepositoryFailure<"InboxProjectionStore">;

/** P6 `01` §4.1/§4.2 (D1). Governance-entity persistence with exact-revision
 * decisions (L3 CAS). */
export interface FormationProposalStoreService {
  readonly insert: (
    record: FormationProposalRecord,
  ) => Effect.Effect<void, FormationProposalStoreError, TransactionScope>;
  readonly findById: (
    proposalId: FormationProposalId,
  ) => Effect.Effect<
    Option.Option<FormationProposalRecord>,
    FormationProposalStoreError,
    TransactionScope
  >;
  /** Atomic compare-and-set on (proposalId, expectedRevision, state=Pending).
   * `None` means the row moved on (stale decision or terminal state). */
  readonly decideIfPendingRevision: (
    proposalId: FormationProposalId,
    expectedRevision: number,
    next: FormationProposalRecord,
  ) => Effect.Effect<
    Option.Option<FormationProposalRecord>,
    FormationProposalStoreError,
    TransactionScope
  >;
}

export class FormationProposalStore extends Context.Service<
  FormationProposalStore,
  FormationProposalStoreService
>()("arbor/FormationProposalStore") {}

/** P6 `02` §3. Durable communication facts (SendMessage → MessageSent). */
export interface MessageRecord {
  readonly messageId: MessageId;
  readonly senderWorkspaceId: WorkspaceId;
  readonly message: OutboundMessage;
  readonly sentAt: string;
}

export interface MessageStoreService {
  readonly append: (
    record: MessageRecord,
  ) => Effect.Effect<void, MessageStoreError, TransactionScope>;
  readonly findById: (
    messageId: MessageId,
  ) => Effect.Effect<
    Option.Option<MessageRecord>,
    MessageStoreError,
    TransactionScope
  >;
  /** Promotion helper (P6 `02` §4): marks a correlation answered. Idempotent. */
  readonly closeCorrelation: (
    correlationId: string,
  ) => Effect.Effect<void, MessageStoreError, TransactionScope>;
  readonly isCorrelationClosed: (
    correlationId: string,
  ) => Effect.Effect<boolean, MessageStoreError, TransactionScope>;
  /** P10-008 read-only extension: every canonical message addressed to a
   * recipient — the state-reconciliation audit face comparing
   * inbox_entries against canonical message facts. */
  readonly listByRecipient: (
    recipientWorkspaceId: WorkspaceId,
  ) => Effect.Effect<
    ReadonlyArray<MessageRecord>,
    MessageStoreError,
    TransactionScope
  >;
}

export class MessageStore extends Context.Service<
  MessageStore,
  MessageStoreService
>()("arbor/MessageStore") {}

/** P6 `02` §4 / `01` §3 (D3). Inbox projection with upsert-by-entryKey
 * admission; replay-safe under at-least-once delivery. */
export interface InboxProjectionStoreService {
  readonly admitUpsert: (
    entry: InboxEntry,
  ) => Effect.Effect<void, InboxProjectionStoreError, TransactionScope>;
  readonly listUnconsumed: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<
    ReadonlyArray<InboxEntry>,
    InboxProjectionStoreError,
    TransactionScope
  >;
  readonly markConsumed: (
    workspaceId: WorkspaceId,
    entryKey: string,
  ) => Effect.Effect<void, InboxProjectionStoreError, TransactionScope>;
  /** Test/observability hook: exact count of live entries for a key owner. */
  readonly countByKey: (
    workspaceId: WorkspaceId,
    entryKey: string,
  ) => Effect.Effect<number, InboxProjectionStoreError, TransactionScope>;
}

export class InboxProjectionStore extends Context.Service<
  InboxProjectionStore,
  InboxProjectionStoreService
>()("arbor/InboxProjectionStore") {}
