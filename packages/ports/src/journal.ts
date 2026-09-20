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

export interface DomainEventJournalService {
  readonly append: (
    drafts: ReadonlyArray<PendingDomainEvent>,
  ) => Effect.Effect<
    void,
    DomainEventJournalError,
    TransactionScope | IdGenerator
  >;
  readonly readAfter: (
    projectId: ProjectId,
    sequence: number,
    limit: number,
  ) => Effect.Effect<
    ReadonlyArray<DomainEvent<unknown>>,
    DomainEventJournalError,
    TransactionScope
  >;
  readonly lastSequence: (
    projectId: ProjectId,
  ) => Effect.Effect<number, DomainEventJournalError, TransactionScope>;
}

export class DomainEventJournal extends Context.Service<
  DomainEventJournal,
  DomainEventJournalService
>()("arbor/DomainEventJournal") {}
