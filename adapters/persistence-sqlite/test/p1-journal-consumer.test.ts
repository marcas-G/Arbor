import { Actor, type EventTypeName, ProjectId, parse } from "@arbor/domain";
import {
  ConsumerOffsetStore,
  DomainEventJournal,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  ConsumerDeadLetterStoreLive,
  ConsumerOffsetStoreLive,
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  P1_MIGRATIONS,
  ProjectionStoreLive,
  rebuildProjection,
  runConsumerBatch,
  runMigrations,
  TransactionPortLive,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const actor = parse(Actor)("user:test");
const consumerId = "projection-test";
const eventType = (name: string) => name as EventTypeName;

const draft = (name: string, eventVersion = 1) => ({
  projectId,
  eventType: eventType(name),
  eventVersion,
  occurredAt: "t",
  aggregateRef: projectId,
  actor,
  payload: {},
});

const append = (drafts: ReadonlyArray<ReturnType<typeof draft>>) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const journal = yield* DomainEventJournal;
    yield* tx.transact(journal.append(drafts));
  });

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  return Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ConsumerOffsetStoreLive, infra),
    Layer.provide(ConsumerDeadLetterStoreLive, infra),
    Layer.provide(ProjectionStoreLive, infra),
  );
};

const readOffset = (consumerIdValue: string) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const offsets = yield* ConsumerOffsetStore;
    return yield* tx.transact(offsets.read(consumerIdValue, projectId));
  });

const projectionRows = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* sql.unsafe<{ sequence: number }>(
    "SELECT sequence FROM projection_state WHERE project_id = ? ORDER BY sequence",
    [projectId],
  );
});

describe("journal consumer", () => {
  it("reads offset 0 when fresh and applies a batch, advancing the offset", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      const fresh = yield* readOffset(consumerId);
      yield* append([draft("ProjectCreated"), draft("WorkspaceCreated")]);
      const result = yield* runConsumerBatch(consumerId, projectId, 10);
      const offset = yield* readOffset(consumerId);
      const rows = yield* projectionRows;
      return { fresh, result, offset, rows };
    });
    const { fresh, result, offset, rows } = await Effect.runPromise(
      Effect.provide(program, makeApp()),
    );
    expect(fresh).toBe(0);
    expect(result.applied).toBe(2);
    expect(result.quarantined).toBe(0);
    expect(result.lastSequence).toBe(2);
    expect(offset).toBe(2);
    expect(rows.map((row) => row.sequence)).toEqual([1, 2]);
  });

  it("quarantines a poison event and advances past it", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* append([
        draft("ProjectCreated", 1),
        draft("WorkspaceCreated", 2),
        draft("WorkCompleted", 1),
      ]);
      const result = yield* runConsumerBatch(consumerId, projectId, 10);
      const offset = yield* readOffset(consumerId);
      const rows = yield* projectionRows;
      const sql = yield* SqlClient;
      const letters = yield* sql.unsafe<{ sequence: number }>(
        "SELECT sequence FROM consumer_dead_letters WHERE consumer_id = ?",
        [consumerId],
      );
      return { result, offset, rows, letters };
    });
    const { result, offset, rows, letters } = await Effect.runPromise(
      Effect.provide(program, makeApp()),
    );
    expect(result.applied).toBe(2);
    expect(result.quarantined).toBe(1);
    expect(result.lastSequence).toBe(3);
    expect(offset).toBe(3);
    expect(rows.map((row) => row.sequence)).toEqual([1, 3]);
    expect(letters.map((row) => row.sequence)).toEqual([2]);
  });

  it("re-applies idempotently on redelivery", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      yield* append([draft("ProjectCreated"), draft("WorkspaceCreated")]);
      yield* runConsumerBatch(consumerId, projectId, 10);
      const second = yield* runConsumerBatch(consumerId, projectId, 10);
      const rows = yield* projectionRows;
      return { second, rows };
    });
    const { second, rows } = await Effect.runPromise(
      Effect.provide(program, makeApp()),
    );
    expect(second.applied).toBe(0);
    expect(second.lastSequence).toBe(2);
    expect(rows).toHaveLength(2);
  });

  it("refuses rebuild below the pruned floor and replays otherwise", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P1_MIGRATIONS);
      const tx = yield* TransactionPort;
      const offsets = yield* ConsumerOffsetStore;
      const sql = yield* SqlClient;
      yield* append([
        draft("ProjectCreated"),
        draft("WorkspaceCreated"),
        draft("WorkCompleted"),
      ]);
      yield* runConsumerBatch(consumerId, projectId, 10);
      yield* sql.unsafe(
        "DELETE FROM domain_events WHERE project_id = ? AND sequence = 1",
        [projectId],
      );
      yield* tx.transact(offsets.advance(consumerId, projectId, 1));
      const refused = yield* rebuildProjection(consumerId, projectId).pipe(
        Effect.flip,
      );
      yield* tx.transact(offsets.advance(consumerId, projectId, 3));
      const rebuilt = yield* rebuildProjection(consumerId, projectId);
      const offset = yield* readOffset(consumerId);
      const rows = yield* projectionRows;
      return { refused, rebuilt, offset, rows };
    });
    const { refused, rebuilt, offset, rows } = await Effect.runPromise(
      Effect.provide(program, makeApp()),
    );
    expect(refused._tag).toBe("ConsumerRebuildRefused");
    expect(rebuilt).toEqual({ replayed: 1, floor: 2 });
    expect(offset).toBe(3);
    expect(rows.map((row) => row.sequence)).toEqual([3]);
  });
});
