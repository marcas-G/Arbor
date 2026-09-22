import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  P8_MIGRATIONS,
  P12_MIGRATIONS,
  ProjectionStoreLive,
  rebuildProjection,
  runConsumerBatch,
  runMigrations,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  CommandId,
  Principal,
  ProjectId,
  parse,
  WorkId,
} from "../packages/domain/dist/index.js";
import {
  type ConsumerDeadLetterStore,
  type ConsumerOffsetStore,
  DomainEventJournal,
  type IdGenerator,
  type PendingDomainEvent,
  ProjectionStore,
  TransactionPort,
  TransactionScope,
} from "../packages/ports/src/index.js";
import { p7SeedProject, p7SeedWork } from "./support/p7-app.js";
import {
  type CommitGate,
  commitGate,
  gatedTransactionPort,
  makeP9ConsumerApp,
  p9Boot,
  runP9Consumer,
} from "./support/p9-consumer-app.js";
import {
  collectDurabilityEvidence,
  type DurabilityEvidence,
} from "./support/p9-durability-evidence.js";
import { labeled } from "./support/p9-harness-api.js";

/** P9-011 — generic projection rebuild (RB-1..RB-5 / PR1–PR4, GQ2 P9
 * face) + the durability-asserted evidence protocol (GQ5). The rebuild
 * surface is the GENERIC P1 projection (projection_state /
 * rebuildProjection / runConsumerBatch) — business projections are P10
 * (negative assertion at the bottom). */

const projectA = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789e1");
const projectEmpty = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789e2",
);
const testActor = parse(Principal)("user:test") as never;

const makeConsumerInfra = (
  transaction?: Layer.Layer<TransactionPort, never, SqlClient>,
  projection?: Layer.Layer<ProjectionStore, unknown, SqlClient>,
): Layer.Layer<ConsumerInfraServices> => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const txLayer =
    transaction === undefined
      ? Layer.provide(TransactionPortLive, infra)
      : Layer.provide(transaction, infra);
  return Layer.mergeAll(
    infra,
    txLayer,
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ConsumerOffsetStoreLive, infra),
    Layer.provide(ConsumerDeadLetterStoreLive, infra),
    Layer.provide(
      projection ?? Layer.provide(ProjectionStoreLive, infra),
      infra,
    ),
  ) as Layer.Layer<ConsumerInfraServices>;
};

type ConsumerInfraServices =
  | SqlClient
  | TransactionPort
  | DomainEventJournal
  | ConsumerOffsetStore
  | ConsumerDeadLetterStore
  | ProjectionStore
  | IdGenerator;

const draft = (sequence: number, eventVersion = 1): PendingDomainEvent => ({
  projectId: projectA,
  eventType: (sequence % 2 === 0
    ? "WorkspaceCreated"
    : "ProjectCreated") as never,
  eventVersion,
  occurredAt: "t",
  aggregateRef: projectA,
  actor: testActor,
  payload: { sequence },
});

const appendEvents = (drafts: ReadonlyArray<PendingDomainEvent>) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const journal = yield* DomainEventJournal;
    yield* tx.transact(journal.append(drafts));
  });

const offsetOf = (consumerId: string) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const sql = yield* SqlClient;
    void tx;
    const rows = yield* sql.unsafe<{ last_sequence: number }>(
      "SELECT last_sequence FROM consumer_offsets WHERE consumer_id = ? AND project_id = ?",
      [consumerId, projectA],
    );
    return Number(rows[0]?.last_sequence ?? 0);
  });

const projectionRows = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ sequence: number; event_type: string }>(
    "SELECT sequence, event_type FROM projection_state ORDER BY sequence",
  );
  return rows.map((row) => ({
    sequence: Number(row.sequence),
    eventType: row.event_type,
  }));
});

const deadLetterCount = (consumerId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ count: number }>(
      "SELECT COUNT(*) AS count FROM consumer_dead_letters WHERE consumer_id = ?",
      [consumerId],
    );
    return Number(rows[0]?.count ?? 0);
  });

const pruneTo = (floor: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "DELETE FROM domain_events WHERE project_id = ? AND sequence < ?",
      [projectA, floor],
    );
  });

const regressOffset = (consumerId: string, value: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "UPDATE consumer_offsets SET last_sequence = ? WHERE consumer_id = ?",
      [value, consumerId],
    );
  });

const dropOffset = (consumerId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe("DELETE FROM consumer_offsets WHERE consumer_id = ?", [
      consumerId,
    ]);
  });

const migrate = runMigrations(P8_MIGRATIONS);

describe("p9-rebuild (RB-1..RB-5 / PR1–PR4 — generic face, GQ2)", () => {
  it("RB-1/PR3 [crash-injected]: offset below the pruned floor — typed ConsumerRebuildRefused, no partial reset, no state destruction", async () => {
    expect(labeled("RB-1-floor-refusal", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* migrate;
            yield* appendEvents([draft(1), draft(2), draft(3)]);
            yield* runConsumerBatch("rb1", projectA, 10);
            expect(yield* offsetOf("rb1")).toBe(3);
            expect((yield* projectionRows).length).toBe(3);
            // Prune below sequence 2 and regress the offset under it.
            yield* pruneTo(2);
            yield* regressOffset("rb1", 1);
            const refused = yield* rebuildProjection("rb1", projectA).pipe(
              Effect.flip,
            );
            expect(refused._tag).toBe("ConsumerRebuildRefused");
            expect(refused).toMatchObject({ offset: 1, floor: 2 });
            // No partial reset: rows and offset untouched by the refusal.
            expect((yield* projectionRows).length).toBe(3);
            expect(yield* offsetOf("rb1")).toBe(1);
          }),
          makeConsumerInfra(),
        ),
      ),
    );
  });

  it("RB-2 [crash-injected]: reset atomicity — abort mid-rebuild leaves the pre-reset state, never a hybrid; the retry completes to the post-reset state", async () => {
    expect(labeled("RB-2-reset-atomicity", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const gate = commitGate();
    let armedOnce = false;
    /** The injection point: the reset statement arms the commit gate from
     * INSIDE the reset transaction (once) — the rewind+reset COMMIT then
     * fails; the retry rebuild runs an unarmed reset. */
    const armingProjection: Layer.Layer<ProjectionStore, never, SqlClient> =
      Layer.effect(
        ProjectionStore,
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql
            .unsafe(
              "CREATE TABLE IF NOT EXISTS projection_state (project_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_type TEXT NOT NULL, PRIMARY KEY (project_id, sequence))",
            )
            .pipe(Effect.orDie);
          return ProjectionStore.of({
            apply: (batch) =>
              Effect.gen(function* () {
                yield* TransactionScope;
                for (const event of batch) {
                  yield* sql
                    .unsafe(
                      "INSERT OR IGNORE INTO projection_state (project_id, sequence, event_type) VALUES (?,?,?)",
                      [event.projectId, event.sequence, event.eventType],
                    )
                    .pipe(Effect.orDie);
                }
              }),
            reset: () =>
              Effect.gen(function* () {
                yield* TransactionScope;
                yield* sql
                  .unsafe("DELETE FROM projection_state")
                  .pipe(Effect.orDie);
                if (!armedOnce) {
                  armedOnce = true;
                  (gate as CommitGate).armed = true;
                }
              }),
          });
        }),
      );
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* migrate;
            yield* appendEvents([draft(1), draft(2), draft(3)]);
            yield* runConsumerBatch("rb2", projectA, 10);
            expect(yield* offsetOf("rb2")).toBe(3);
            const preReset = yield* projectionRows;
            const failure = yield* rebuildProjection("rb2", projectA).pipe(
              Effect.flip,
            );
            expect(failure._tag).toBe("TransactionOperationalFailure");
            // Pre-reset state: reset + rewind rolled back together —
            // never rows-deleted-with-offset-rewound (hybrid).
            expect(yield* projectionRows).toEqual(preReset);
            expect(yield* offsetOf("rb2")).toBe(3);
            // Retry (fail-once gate already discharged) → post-reset state.
            const done = yield* rebuildProjection("rb2", projectA);
            expect(done).toEqual({ replayed: 3, floor: 1 });
            expect(yield* offsetOf("rb2")).toBe(3);
            expect((yield* projectionRows).length).toBe(3);
          }),
          makeConsumerInfra(gatedTransactionPort(gate), armingProjection),
        ),
      ),
    );
  });

  it("RB-3 [crash-injected]: replay idempotency — re-running rebuild is a no-op delta; re-quarantine is a PK no-op", async () => {
    expect(labeled("RB-3-replay-idempotency", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* migrate;
            yield* appendEvents([draft(1), draft(2, 2), draft(3)]);
            // Establish the consumer position first (a fresh offset 0
            // under floor 1 is the RB-1 refusal, not this row's fixture).
            const consumed = yield* runConsumerBatch("rb3", projectA, 10);
            expect(consumed.applied).toBe(2);
            expect(consumed.quarantined).toBe(1);
            const first = yield* rebuildProjection("rb3", projectA);
            expect(first).toEqual({ replayed: 3, floor: 1 });
            const rowsAfterFirst = yield* projectionRows;
            expect(rowsAfterFirst.map((row) => row.sequence)).toEqual([1, 3]);
            expect(yield* deadLetterCount("rb3")).toBe(1);
            const second = yield* rebuildProjection("rb3", projectA);
            expect(second).toEqual({ replayed: 3, floor: 1 });
            // No-op delta: identical row set, still exactly one dead letter.
            expect(yield* projectionRows).toEqual(rowsAfterFirst);
            expect(yield* deadLetterCount("rb3")).toBe(1);
            expect(yield* offsetOf("rb3")).toBe(3);
          }),
          makeConsumerInfra(),
        ),
      ),
    );
  });

  it("RB-4 [crash-injected]: rebuildability — with intact domain_events the rebuild always reaches the same projection state", async () => {
    expect(labeled("RB-4-rebuildability", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* migrate;
            yield* appendEvents([draft(1), draft(2), draft(3), draft(4)]);
            for (;;) {
              const result = yield* runConsumerBatch("rb4", projectA, 2);
              if (result.applied + result.quarantined === 0) {
                break;
              }
            }
            expect(yield* offsetOf("rb4")).toBe(4);
            const consumed = yield* projectionRows;
            // Damage the projection state; the intact journal owns the
            // truth — the rebuild must restore the identical state.
            const sql = yield* SqlClient;
            yield* sql.unsafe(
              "DELETE FROM projection_state WHERE sequence IN (2, 4)",
            );
            expect((yield* projectionRows).length).toBe(2);
            const rebuilt = yield* rebuildProjection("rb4", projectA);
            expect(rebuilt).toEqual({ replayed: 4, floor: 1 });
            expect(yield* projectionRows).toEqual(consumed);
            expect(yield* offsetOf("rb4")).toBe(4);
          }),
          makeConsumerInfra(),
        ),
      ),
    );
  });

  it("RB-5 [crash-injected]: degenerate zero-events project — floor 0, replay 0, success", async () => {
    expect(labeled("RB-5-degenerate", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* migrate;
            const degenerate = yield* rebuildProjection("rb5", projectEmpty);
            expect(degenerate).toEqual({ replayed: 0, floor: 0 });
          }),
          makeConsumerInfra(),
        ),
      ),
    );
  });

  it("PR1 [crash-injected]: consumer offset row lost — batch replay from the effective retained floor converges, no duplicates", async () => {
    expect(labeled("PR1-offset-lost-replay", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* migrate;
            yield* appendEvents([draft(1), draft(2), draft(3)]);
            yield* runConsumerBatch("pr1", projectA, 10);
            expect((yield* projectionRows).length).toBe(3);
            yield* pruneTo(2);
            yield* dropOffset("pr1");
            expect(yield* offsetOf("pr1")).toBe(0);
            const replay = yield* runConsumerBatch("pr1", projectA, 10);
            // readAfter(0) starts at the retained floor: only 2,3 exist.
            expect(replay.applied).toBe(2);
            expect(replay.quarantined).toBe(0);
            expect(yield* offsetOf("pr1")).toBe(3);
            // Converged, no duplicates (PK-deduped re-apply).
            expect((yield* projectionRows).map((row) => row.sequence)).toEqual([
              1, 2, 3,
            ]);
          }),
          makeConsumerInfra(),
        ),
      ),
    );
  });

  it("PR2 [crash-injected]: explicit reset rewinds to MIN(domain_events.sequence) and replays in (project_id, sequence) order", async () => {
    expect(labeled("PR2-reset-order", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* migrate;
            yield* appendEvents([draft(1), draft(2), draft(3)]);
            yield* runConsumerBatch("pr2", projectA, 10);
            yield* pruneTo(2);
            const rebuilt = yield* rebuildProjection("pr2", projectA);
            expect(rebuilt).toEqual({ replayed: 2, floor: 2 });
            expect(yield* offsetOf("pr2")).toBe(3);
            // Reset discarded the pruned sequence's row; the replay
            // re-applied exactly the retained events, ascending.
            expect((yield* projectionRows).map((row) => row.sequence)).toEqual([
              2, 3,
            ]);
          }),
          makeConsumerInfra(),
        ),
      ),
    );
  });

  it("PR4 [crash-injected]: projection failure never rolls back domain transactions — journal intact, offset stays, typed failure", async () => {
    expect(
      labeled("PR4-projection-failure-isolation", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const failingProjection: Layer.Layer<ProjectionStore> = Layer.succeed(
      ProjectionStore,
      {
        apply: () =>
          Effect.fail({
            _tag: "ConsumerOffsetStoreFailure" as const,
            cause: "injected projection failure",
          }),
        reset: () => Effect.void,
      },
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* migrate;
            yield* appendEvents([draft(1)]);
            const sql = yield* SqlClient;
            const journalCount = yield* sql.unsafe<{ count: number }>(
              "SELECT COUNT(*) AS count FROM domain_events",
            );
            const failure = yield* runConsumerBatch("pr4", projectA, 10).pipe(
              Effect.flip,
            );
            expect((failure as { _tag: string })._tag).toBe(
              "ConsumerOffsetStoreFailure",
            );
            // Invariant 37: the journaled domain facts survive.
            const after = yield* sql.unsafe<{ count: number }>(
              "SELECT COUNT(*) AS count FROM domain_events",
            );
            expect(Number(after[0]?.count)).toBe(
              Number(journalCount[0]?.count),
            );
            expect(yield* offsetOf("pr4")).toBe(0);
          }),
          makeConsumerInfra(undefined, failingProjection),
        ),
      ),
    );
  });

  it("GQ2 P10 boundary [negative assertion]: no p9 suite file imports or asserts business-projection rebuild", async () => {
    // Character classes keep this file's own assertion text from
    // matching the surface it guards.
    const businessProjectionSurface =
      /InboxProjection[S]tore|Attention[P]rojection|Attention[V]iew|WaitGraph[V]iew|rebuild[I]nbox|rebuild[A]ttention|rebuild[W]aitGraph/;
    const dir = import.meta.dirname;
    const p9Suites = readdirSync(dir).filter(
      (name) => name.startsWith("p9-") && name.endsWith(".test.ts"),
    );
    expect(p9Suites.length).toBeGreaterThanOrEqual(5);
    for (const name of p9Suites) {
      const source = readFileSync(join(dir, name), "utf8");
      expect(
        businessProjectionSurface.test(source),
        `${name} must not touch business-projection rebuild (P10, GQ2)`,
      ).toBe(false);
    }
  });
});

describe("p9-durability (GQ5 evidence protocol, 02 §12)", () => {
  it("DA-evidence [durability-asserted]: reopened DB — integrity ok, frozen user_version, FULL+WAL active, counts reconcile with the fixture", async () => {
    expect(
      labeled("DA1-DA2-evidence-protocol", "durability-asserted").guarantee,
    ).toBe("durability-asserted");
    const dir = mkdtempSync(join(tmpdir(), "arbor-p9-durability-"));
    const filename = join(dir, "durability.db");
    const WORK_C = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000001");
    const WORK_P = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000002");
    const ASSIGN_CMD_C = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789b1",
    );
    const ASSIGN_CMD_P = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789b2",
    );
    const expected = await runP9Consumer(
      Effect.gen(function* () {
        yield* p9Boot;
        yield* p7SeedProject;
        const consumer = yield* p7SeedWork(WORK_C, ASSIGN_CMD_C);
        expect(consumer.resolution._tag).toBe("Committed");
        const producer = yield* p7SeedWork(WORK_P, ASSIGN_CMD_P);
        expect(producer.resolution._tag).toBe("Committed");
        const sql = yield* SqlClient;
        const snapshot = (table: string) =>
          Effect.gen(function* () {
            const rows = yield* sql.unsafe<{ count: number }>(
              `SELECT COUNT(*) AS count FROM ${table}`,
            );
            return Number(rows[0]?.count ?? 0);
          });
        return {
          works: yield* snapshot("works"),
          executions: yield* snapshot("executions"),
          domain_events: yield* snapshot("domain_events"),
          commands: yield* snapshot("commands"),
          consumer_offsets: yield* snapshot("consumer_offsets"),
        };
      }),
      makeP9ConsumerApp({ filename }),
    );
    expect(expected.works).toBe(2);
    expect(expected.domain_events).toBeGreaterThanOrEqual(3);
    expect(expected.consumer_offsets).toBe(0);
    // Scope closed (daemon exit CI approximation) → reopen + evidence.
    const evidence: DurabilityEvidence =
      await collectDurabilityEvidence(filename);
    // Step 5: the explicit durability-asserted label — never claimed as
    // crash-injected (GQ5).
    expect(evidence.guarantee).toBe("durability-asserted");
    expect(evidence.guarantee).not.toBe("crash-injected");
    // Step 1: synchronous = FULL + WAL active.
    expect(evidence.synchronous).toBe(2);
    expect(evidence.journalMode.toLowerCase()).toBe("wal");
    // Step 2: reopen succeeded; integrity ok.
    expect(evidence.integrity).toBe("ok");
    // Step 3: user_version == frozen migration baseline (P1 `06` §5). The
    // fixture is booted through `p9Boot` (`P9_CONSUMER_MIGRATIONS`), which at
    // P12 is the full ordered baseline (max applied id 13).
    const baseline = P12_MIGRATIONS.reduce(
      (max, migration) => Math.max(max, migration.id),
      0,
    );
    expect(evidence.version).toBe(baseline);
    // Step 4: count reconciliation against the fixture.
    expect(evidence.counts.works).toBe(expected.works);
    expect(evidence.counts.executions).toBe(expected.executions);
    expect(evidence.counts.execution_leases).toBe(0);
    expect(evidence.counts.domain_events).toBe(expected.domain_events);
    expect(evidence.counts.commands).toBe(expected.commands);
    expect(evidence.counts.consumer_offsets).toBe(expected.consumer_offsets);
  });

  it("DA1/DA2 [durability-asserted]: power-loss / WAL-checkpoint classes are evidenced, never crash-injected — claims bounded by the DurabilityEnvelope", async () => {
    const da1 = labeled("DA1-power-loss-after-commit", "durability-asserted");
    const da2 = labeled("DA2-wal-checkpoint-crash", "durability-asserted");
    expect(da1.guarantee).toBe("durability-asserted");
    expect(da2.guarantee).toBe("durability-asserted");
    // A durability-asserted row is never labeled crash-injected and vice
    // versa: the labeling is exactly one class per row (GQ5).
    expect(da1.guarantee).not.toBe("crash-injected");
    expect(labeled("CC-1", "crash-injected").guarantee).not.toBe(
      "durability-asserted",
    );
    // Storage-media / region loss stays outside the envelope and is
    // reported truthfully (P2 `06` §7): the evidence type carries only
    // the honest reopen/integrity claim, no simulation.
    const dir = mkdtempSync(join(tmpdir(), "arbor-p9-durability-"));
    const filename = join(dir, "empty.db");
    // A migrated-but-empty database: the minimal truthful fixture.
    await Effect.runPromise(
      Effect.scoped(Effect.provide(migrate, layer({ filename }))),
    );
    const evidence = await collectDurabilityEvidence(filename);
    expect(evidence.integrity).toBe("ok");
    const baseline = P8_MIGRATIONS.reduce(
      (max, migration) => Math.max(max, migration.id),
      0,
    );
    expect(evidence.version).toBe(baseline);
    expect(evidence.counts.works).toBe(0);
    expect(evidence.counts.domain_events).toBe(0);
  });
});
