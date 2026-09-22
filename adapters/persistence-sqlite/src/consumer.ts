import type { DomainEvent, ProjectId } from "@arbor/domain";
import {
  Clock,
  ConsumerDeadLetterStore,
  type ConsumerDeadLetterStoreError,
  ConsumerOffsetStore,
  type ConsumerOffsetStoreError,
  DomainEventJournal,
  type DomainEventJournalError,
  ProjectionStore,
  type TransactionOperationalFailure,
  TransactionPort,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

export interface ConsumerRunResult {
  readonly fromSequence: number;
  readonly lastSequence: number;
  readonly applied: number;
  readonly quarantined: number;
}

export type ConsumerRunError =
  | DomainEventJournalError
  | ConsumerOffsetStoreError
  | ConsumerDeadLetterStoreError
  | TransactionOperationalFailure;

export interface ConsumerRebuildRefused {
  readonly _tag: "ConsumerRebuildRefused";
  readonly offset: number;
  readonly floor: number;
}

export const ConsumerOffsetStoreLive: Layer.Layer<
  ConsumerOffsetStore,
  never,
  SqlClient | Clock
> = Layer.effect(
  ConsumerOffsetStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const clock = yield* Clock;
    const failure = (cause: unknown): ConsumerOffsetStoreError => ({
      _tag: "ConsumerOffsetStoreFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    return ConsumerOffsetStore.of({
      read: (consumerId, projectId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ last_sequence: number }>(
              "SELECT last_sequence FROM consumer_offsets WHERE consumer_id = ? AND project_id = ?",
              [consumerId, projectId],
            ),
          );
          return Number(rows[0]?.last_sequence ?? 0);
        }),
      advance: (consumerId, projectId, lastSequence) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          yield* run(
            sql.unsafe(
              "INSERT INTO consumer_offsets (consumer_id, project_id, last_sequence, updated_at) VALUES (?,?,?,?) ON CONFLICT(consumer_id, project_id) DO UPDATE SET last_sequence = excluded.last_sequence, updated_at = excluded.updated_at",
              [consumerId, projectId, lastSequence, now],
            ),
          );
        }),
    });
  }),
);

export const ConsumerDeadLetterStoreLive: Layer.Layer<
  ConsumerDeadLetterStore,
  never,
  SqlClient | Clock
> = Layer.effect(
  ConsumerDeadLetterStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const clock = yield* Clock;
    const failure = (cause: unknown): ConsumerDeadLetterStoreError => ({
      _tag: "ConsumerDeadLetterStoreFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    return ConsumerDeadLetterStore.of({
      quarantine: (consumerId, projectId, sequence, reason) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          yield* run(
            sql.unsafe(
              "INSERT OR IGNORE INTO consumer_dead_letters (consumer_id, project_id, sequence, reason, created_at) VALUES (?,?,?,?,?)",
              [consumerId, projectId, sequence, reason, now],
            ),
          );
        }),
    });
  }),
);

export const ProjectionStoreLive: Layer.Layer<
  ProjectionStore,
  ConsumerOffsetStoreError,
  SqlClient | Clock
> = Layer.effect(
  ProjectionStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = (cause: unknown): ConsumerOffsetStoreError => ({
      _tag: "ConsumerOffsetStoreFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    yield* run(
      sql.unsafe(
        "CREATE TABLE IF NOT EXISTS projection_state (project_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_type TEXT NOT NULL, PRIMARY KEY (project_id, sequence))",
      ),
    );
    return ProjectionStore.of({
      apply: (batch: ReadonlyArray<DomainEvent<unknown>>) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          for (const event of batch) {
            yield* run(
              sql.unsafe(
                "INSERT OR IGNORE INTO projection_state (project_id, sequence, event_type) VALUES (?,?,?)",
                [event.projectId, event.sequence, event.eventType],
              ),
            );
          }
        }),
      reset: () =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(sql.unsafe("DELETE FROM projection_state"));
        }),
    });
  }),
);

export const runConsumerBatch = (
  consumerId: string,
  projectId: ProjectId,
  batchSize: number,
): Effect.Effect<
  ConsumerRunResult,
  ConsumerRunError,
  | TransactionPort
  | DomainEventJournal
  | ConsumerOffsetStore
  | ConsumerDeadLetterStore
  | ProjectionStore
> =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const journal = yield* DomainEventJournal;
    const offsets = yield* ConsumerOffsetStore;
    const deadLetters = yield* ConsumerDeadLetterStore;
    const projection = yield* ProjectionStore;
    return yield* tx.transact(
      Effect.gen(function* () {
        const fromSequence = yield* offsets.read(consumerId, projectId);
        const events = yield* journal.readAfter(
          projectId,
          fromSequence,
          batchSize,
        );
        const applicable: DomainEvent<unknown>[] = [];
        let lastSequence = fromSequence;
        for (const event of events) {
          lastSequence = event.sequence;
          if (event.eventVersion > 1) {
            yield* deadLetters.quarantine(
              consumerId,
              projectId,
              event.sequence,
              `unsupported eventVersion ${event.eventVersion}`,
            );
            continue;
          }
          applicable.push(event);
        }
        if (applicable.length > 0) {
          yield* projection.apply(applicable);
        }
        if (lastSequence !== fromSequence) {
          yield* offsets.advance(consumerId, projectId, lastSequence);
        }
        return {
          fromSequence,
          lastSequence,
          applied: applicable.length,
          quarantined: events.length - applicable.length,
        };
      }),
    );
  });

export const rebuildProjection = (
  consumerId: string,
  projectId: ProjectId,
  batchSize = 100,
): Effect.Effect<
  { readonly replayed: number; readonly floor: number },
  ConsumerRunError | ConsumerRebuildRefused,
  | TransactionPort
  | DomainEventJournal
  | ConsumerOffsetStore
  | ConsumerDeadLetterStore
  | ProjectionStore
  | SqlClient
> =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const offsets = yield* ConsumerOffsetStore;
    const projection = yield* ProjectionStore;
    const sql = yield* SqlClient;
    const floorRows = yield* sql
      .unsafe<{ floor: number | null }>(
        "SELECT MIN(sequence) AS floor FROM domain_events WHERE project_id = ?",
        [projectId],
      )
      .pipe(
        Effect.mapError(
          (cause): ConsumerOffsetStoreError => ({
            _tag: "ConsumerOffsetStoreFailure",
            cause,
          }),
        ),
      );
    const floor = Number(floorRows[0]?.floor ?? 0);
    const offset = yield* tx.transact(offsets.read(consumerId, projectId));
    if (offset < floor) {
      return yield* Effect.fail<ConsumerRebuildRefused>({
        _tag: "ConsumerRebuildRefused",
        offset,
        floor,
      });
    }
    yield* tx.transact(
      Effect.gen(function* () {
        yield* projection.reset();
        // P1 `05` §6: replay ALL retained domain_events — the batch read
        // is exclusive of the stored offset, so the rewind target is the
        // sequence before the floor (clamped: absent row reads 0), which
        // makes the rebuild deliver the floor event exactly like the
        // PR1 offset-loss batch replay does.
        yield* offsets.advance(consumerId, projectId, Math.max(floor - 1, 0));
      }),
    );
    let replayed = 0;
    for (;;) {
      const result = yield* runConsumerBatch(consumerId, projectId, batchSize);
      const processed = result.applied + result.quarantined;
      if (processed === 0) {
        break;
      }
      replayed += processed;
    }
    return { replayed, floor };
  });
