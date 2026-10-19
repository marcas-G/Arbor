import type {
  Actor,
  CommandId,
  DomainEvent,
  EventId,
  EventTypeName,
  ProjectId,
} from "@arbor/domain";
import { Context, type Effect } from "effect";
import type { DomainEventJournalError } from "./errors.js";
import type { IdGenerator } from "./runtime.js";
import type { TransactionScope } from "./session.js";

export interface PendingDomainEvent {
  readonly projectId: ProjectId;
  readonly eventType: EventTypeName;
  readonly eventVersion: number;
  readonly occurredAt: string;
  readonly aggregateRef: string;
  readonly actor: Actor;
  readonly causedByCommandId?: CommandId;
  readonly causedByEventId?: EventId;
  readonly correlationRef?: string;
  readonly payload: unknown;
}

export interface IdentifiedPendingDomainEvent {
  readonly eventId: EventId;
  readonly draft: PendingDomainEvent;
}

/** P1/05 DeliverReplay preflight view. Values intentionally remain unknown so
 * source identity can be checked before any event decoding occurs. */
export interface RawJournalEventCandidate {
  readonly eventIdRaw: unknown;
  readonly projectIdRaw: unknown;
  readonly sequenceRaw: unknown;
  readonly eventTypeRaw: unknown;
  readonly eventVersionRaw: unknown;
  readonly occurredAtRaw: unknown;
  readonly aggregateRefRaw: unknown;
  readonly actorRaw: unknown;
  readonly causedByCommandIdRaw: unknown;
  readonly causedByEventIdRaw: unknown;
  readonly correlationRefRaw: unknown;
  readonly payloadJsonRaw: unknown;
}

export type RawJournalDecodeResult =
  | {
      readonly _tag: "Decoded";
      readonly event: DomainEvent<unknown>;
    }
  | {
      readonly _tag: "Poison";
      readonly reason:
        | "MalformedEnvelope"
        | "UnknownEventType"
        | "MalformedPayload";
    };

export interface DomainEventJournalService {
  readonly append: (
    drafts: ReadonlyArray<PendingDomainEvent>,
  ) => Effect.Effect<
    void,
    DomainEventJournalError,
    TransactionScope | IdGenerator
  >;
  readonly appendReturningIds: (
    drafts: ReadonlyArray<PendingDomainEvent>,
  ) => Effect.Effect<
    ReadonlyArray<EventId>,
    DomainEventJournalError,
    TransactionScope | IdGenerator
  >;
  /** Persist caller-allocated event identities in the caller's transaction.
   * P9 uses this to bind an immutable source fact and retained queue before
   * appending its wake event while keeping all three writes atomic. */
  readonly appendWithIds?: (
    events: ReadonlyArray<IdentifiedPendingDomainEvent>,
  ) => Effect.Effect<void, DomainEventJournalError, TransactionScope>;
  readonly readAfter: (
    projectId: ProjectId,
    sequence: number,
    limit: number,
  ) => Effect.Effect<
    ReadonlyArray<DomainEvent<unknown>>,
    DomainEventJournalError,
    TransactionScope
  >;
  readonly readAfterRaw: (
    projectId: ProjectId,
    sequence: number,
    limit: number,
  ) => Effect.Effect<
    ReadonlyArray<RawJournalEventCandidate>,
    DomainEventJournalError,
    TransactionScope
  >;
  /** Decode one raw candidate through the same closed P1 event catalog. The
   * caller invokes this only after source-specific raw-ID preflight. */
  readonly decodeRaw: (
    candidate: RawJournalEventCandidate,
  ) => Effect.Effect<RawJournalDecodeResult, DomainEventJournalError>;
  readonly lastSequence: (
    projectId: ProjectId,
  ) => Effect.Effect<number, DomainEventJournalError, TransactionScope>;
}

export class DomainEventJournal extends Context.Service<
  DomainEventJournal,
  DomainEventJournalService
>()("arbor/DomainEventJournal") {}
