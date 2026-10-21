import type {
  Actor,
  CommandId,
  DomainEvent,
  EventId,
  EventTypeName,
  ProjectId,
} from "@arbor/domain";
import {
  decodeSupportedEventPayload,
  EVENT_CATALOG,
  isSupportedEventReadPair,
  isSupportedEventWritePair,
} from "@arbor/domain";
import {
  DomainEventJournal,
  IdGenerator,
  type PendingDomainEvent,
  type RawJournalDecodeResult,
  type RawJournalEventCandidate,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  persistenceCorruption,
  repositoryFailure,
} from "./repository-error.js";

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

const toEvent = (row: EventRow, payload: unknown): DomainEvent<unknown> => ({
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
  payload,
});

const decodeRawCandidate = (
  candidate: RawJournalEventCandidate,
): RawJournalDecodeResult => {
  const {
    eventIdRaw,
    projectIdRaw,
    sequenceRaw,
    eventTypeRaw,
    eventVersionRaw,
    occurredAtRaw,
    aggregateRefRaw,
    actorRaw,
    causedByCommandIdRaw,
    causedByEventIdRaw,
    correlationRefRaw,
    payloadJsonRaw,
  } = candidate;
  if (
    typeof eventIdRaw !== "string" ||
    typeof projectIdRaw !== "string" ||
    typeof sequenceRaw !== "number" ||
    !Number.isSafeInteger(sequenceRaw) ||
    typeof eventVersionRaw !== "number" ||
    !Number.isSafeInteger(eventVersionRaw) ||
    typeof occurredAtRaw !== "string" ||
    typeof aggregateRefRaw !== "string" ||
    typeof actorRaw !== "string" ||
    (causedByCommandIdRaw !== null &&
      typeof causedByCommandIdRaw !== "string") ||
    (causedByEventIdRaw !== null && typeof causedByEventIdRaw !== "string") ||
    (correlationRefRaw !== null && typeof correlationRefRaw !== "string") ||
    typeof payloadJsonRaw !== "string"
  ) {
    return { _tag: "Poison", reason: "MalformedEnvelope" };
  }
  if (
    typeof eventTypeRaw !== "string" ||
    !Object.hasOwn(EVENT_CATALOG, eventTypeRaw)
  ) {
    return { _tag: "Poison", reason: "UnknownEventType" };
  }
  if (!Number.isSafeInteger(eventVersionRaw)) {
    return { _tag: "Poison", reason: "MalformedEnvelope" };
  }
  if (!isSupportedEventReadPair(eventTypeRaw, eventVersionRaw)) {
    return { _tag: "Poison", reason: "UnsupportedEventPair" };
  }

  // Preserve the established P1 row decoder's typed-column projection. Event
  // IDs have historically been cast from stored values, not reparsed through
  // the entity-ID codec.
  const envelope: Omit<DomainEvent<unknown>, "payload"> = {
    eventId: eventIdRaw as EventId,
    projectId: projectIdRaw as ProjectId,
    sequence: sequenceRaw as DomainEvent<unknown>["sequence"],
    eventType: eventTypeRaw as EventTypeName,
    eventVersion: eventVersionRaw,
    occurredAt: occurredAtRaw,
    aggregateRef: aggregateRefRaw,
    actor: actorRaw as Actor,
    ...(causedByCommandIdRaw === null
      ? {}
      : { causedByCommandId: causedByCommandIdRaw as CommandId }),
    ...(causedByEventIdRaw === null
      ? {}
      : { causedByEventId: causedByEventIdRaw as EventId }),
    ...(correlationRefRaw === null
      ? {}
      : { correlationRef: correlationRefRaw }),
  };

  try {
    // Match the existing readAfter decoder: registered event-type lookup plus
    // JSON parsing, without retroactively imposing the current schema on
    // persisted payloads whose event version is independently classified.
    const payload = JSON.parse(payloadJsonRaw);
    const decoded = decodeSupportedEventPayload(
      eventTypeRaw,
      eventVersionRaw,
      payload,
    );
    if (decoded._tag === "UnsupportedPair") {
      return { _tag: "Poison", reason: "UnsupportedEventPair" };
    }
    if (decoded._tag === "MalformedPayload") {
      return { _tag: "Poison", reason: "MalformedPayload" };
    }
    return {
      _tag: "Decoded",
      event: { ...envelope, payload: decoded.payload },
    };
  } catch {
    return { _tag: "Poison", reason: "MalformedPayload" };
  }
};

export const DomainEventJournalLive: Layer.Layer<
  DomainEventJournal,
  never,
  SqlClient | IdGenerator
> = Layer.effect(
  DomainEventJournal,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const ids = yield* IdGenerator;
    const failure = repositoryFailure("DomainEventJournal", "event-journal");
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    const appendWithIds = (
      events: ReadonlyArray<{
        readonly eventId: EventId;
        readonly draft: PendingDomainEvent;
      }>,
    ) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        for (const { draft } of events) {
          if (!isSupportedEventWritePair(draft.eventType, draft.eventVersion)) {
            return yield* Effect.fail({
              _tag: "PersistenceCorruption" as const,
              repository: "DomainEventJournal" as const,
              operation: "append-event-version-pair",
              reason: "event type/version pair is not registered for writing",
            });
          }
        }
        for (const { eventId, draft } of events) {
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
      });
    const appendReturningIds = (drafts: ReadonlyArray<PendingDomainEvent>) =>
      Effect.gen(function* () {
        const events: Array<{
          readonly eventId: EventId;
          readonly draft: PendingDomainEvent;
        }> = [];
        for (const draft of drafts) {
          events.push({
            eventId: yield* ids.generate<EventId>("Event"),
            draft,
          });
        }
        yield* appendWithIds(events);
        return events.map(({ eventId }) => eventId);
      });
    return DomainEventJournal.of({
      append: (drafts: ReadonlyArray<PendingDomainEvent>) =>
        Effect.as(appendReturningIds(drafts), undefined),
      appendReturningIds,
      appendWithIds,
      readAfter: (projectId, sequence, limit) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<EventRow>(
              "SELECT * FROM domain_events WHERE project_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
              [projectId, sequence, limit],
            ),
          );
          const events: DomainEvent<unknown>[] = [];
          for (const row of rows) {
            const eventVersion = Number(row.event_version);
            if (!isSupportedEventReadPair(row.event_type, eventVersion)) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "DomainEventJournal",
                  "read-event-version-pair",
                  "stored event type/version pair is not registered",
                ),
              );
            }
            let rawPayload: unknown;
            try {
              rawPayload = JSON.parse(row.payload_json);
            } catch {
              return yield* Effect.fail(
                persistenceCorruption(
                  "DomainEventJournal",
                  "read-event-payload",
                  "stored event payload is malformed JSON",
                ),
              );
            }
            const decoded = decodeSupportedEventPayload(
              row.event_type,
              eventVersion,
              rawPayload,
            );
            if (decoded._tag !== "Decoded") {
              return yield* Effect.fail(
                persistenceCorruption(
                  "DomainEventJournal",
                  "read-event-payload",
                  "stored event payload does not match its registered pair",
                ),
              );
            }
            events.push(toEvent(row, decoded.payload));
          }
          return events;
        }),
      readAfterRaw: (projectId, sequence, limit) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          return yield* run(
            sql.unsafe<RawJournalEventCandidate>(
              `SELECT event_id AS eventIdRaw, project_id AS projectIdRaw,
                      sequence AS sequenceRaw, event_type AS eventTypeRaw,
                      event_version AS eventVersionRaw, occurred_at AS occurredAtRaw,
                      aggregate_ref AS aggregateRefRaw, actor AS actorRaw,
                      caused_by_command_id AS causedByCommandIdRaw,
                      caused_by_event_id AS causedByEventIdRaw,
                      correlation_ref AS correlationRefRaw, payload_json AS payloadJsonRaw
                 FROM domain_events
                WHERE project_id = ? AND sequence > ?
                ORDER BY sequence LIMIT ?`,
              [projectId, sequence, limit],
            ),
          );
        }),
      decodeRaw: (candidate) => Effect.succeed(decodeRawCandidate(candidate)),
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
