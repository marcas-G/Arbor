import type {
  Actor,
  CommandId,
  DomainEvent,
  EventId,
  EventTypeName,
  ProjectId,
} from "@arbor/domain";
import {
  DomainEventJournal,
  type DomainEventJournalError,
  IdGenerator,
  type PendingDomainEvent,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

interface EventRow {
  readonly event_id: string;
  readonly project_id: string;
  readonly sequence: number;
  readonly event_type: string;
  readonly event_version: number;
  readonly occurred_at: string;
  readonly aggregate_ref: string;
  readonly actor: string;
  readonly caused_by_command_id: string | null;
  readonly caused_by_event_id: string | null;
  readonly correlation_ref: string | null;
  readonly payload_json: string;
}

const toEvent = (row: EventRow): DomainEvent<unknown> => ({
  eventId: row.event_id as EventId,
  projectId: row.project_id as ProjectId,
  sequence: Number(row.sequence) as DomainEvent<unknown>["sequence"],
  eventType: row.event_type as EventTypeName,
  eventVersion: Number(row.event_version),
  occurredAt: row.occurred_at,
  aggregateRef: row.aggregate_ref,
  actor: row.actor as Actor,
  ...(row.caused_by_command_id === null
    ? {}
    : { causedByCommandId: row.caused_by_command_id as CommandId }),
  ...(row.caused_by_event_id === null
    ? {}
    : { causedByEventId: row.caused_by_event_id as EventId }),
  ...(row.correlation_ref === null
    ? {}
    : { correlationRef: row.correlation_ref }),
  payload: JSON.parse(row.payload_json),
});

export const DomainEventJournalLive: Layer.Layer<
  DomainEventJournal,
  never,
  SqlClient | IdGenerator
> = Layer.effect(
  DomainEventJournal,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const ids = yield* IdGenerator;
    const failure = (cause: unknown): DomainEventJournalError => ({
      _tag: "DomainEventJournalFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    return DomainEventJournal.of({
      append: (drafts: ReadonlyArray<PendingDomainEvent>) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          for (const draft of drafts) {
            const eventId = yield* ids.generate<string>("Event");
            const sequenceRows = yield* run(
              sql.unsafe<{ last_sequence: number }>(
                "INSERT INTO project_event_sequences (project_id, last_sequence) VALUES (?, 1) ON CONFLICT(project_id) DO UPDATE SET last_sequence = last_sequence + 1 RETURNING last_sequence",
                [draft.projectId],
              ),
            );
            const sequence = Number(sequenceRows[0]?.last_sequence ?? 0);
            yield* run(
              sql.unsafe(
                "INSERT INTO domain_events (event_id, project_id, sequence, event_type, event_version, occurred_at, aggregate_ref, actor, caused_by_command_id, caused_by_event_id, correlation_ref, payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                [
                  eventId,
                  draft.projectId,
                  sequence,
                  draft.eventType,
                  draft.eventVersion,
                  draft.occurredAt,
                  draft.aggregateRef,
                  draft.actor,
                  draft.causedByCommandId ?? null,
                  draft.causedByEventId ?? null,
                  draft.correlationRef ?? null,
                  JSON.stringify(draft.payload),
                ],
              ),
            );
          }
        }),
      readAfter: (projectId, sequence, limit) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<EventRow>(
              "SELECT * FROM domain_events WHERE project_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
              [projectId, sequence, limit],
            ),
          );
          return rows.map(toEvent);
        }),
      lastSequence: (projectId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ last_sequence: number }>(
              "SELECT last_sequence FROM project_event_sequences WHERE project_id = ?",
              [projectId],
            ),
          );
          return Number(rows[0]?.last_sequence ?? 0);
        }),
    });
  }),
);
