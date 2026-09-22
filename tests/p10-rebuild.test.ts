import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AcceptanceRepositoryLive,
  ClockLive,
  ConsumerDeadLetterStoreLive,
  ConsumerOffsetStoreLive,
  DependencyRepositoryLive,
  DomainEventJournalLive,
  EvidenceRepositoryLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  InboxProjectionStoreLive,
  layer,
  MessageStoreLive,
  P8_MIGRATIONS,
  ProjectionStoreLive,
  rebuildProjection,
  runConsumerBatch,
  runMigrations,
  TransactionPortLive,
  VerificationRepositoryLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { DependencyAwareRunnableWorkSourceLive } from "../apps/single-workspace/src/runnable-source-p7.js";
import {
  type ProjectId,
  parse,
  WorkId,
} from "../packages/domain/dist/index.js";
import {
  ConsumerDeadLetterStore,
  ConsumerOffsetStore,
  DomainEventJournal,
  ProjectionStore,
  TransactionPort,
} from "../packages/ports/src/index.js";
import {
  ageConsumedInboxEntries,
  buildTreeView,
  compareProjectionState,
  deriveEffectiveFacts,
  deriveProjectAttention,
  deriveUsageRows,
  makeStartupRebuildHook,
  operatorRebuild,
  orchestrateRebuild,
  projectionReadError,
  REBUILD_STAGE_ORDER,
  type RebuildOrchestrationDeps,
  rebuildOnDetectedDrift,
  reconcileInbox,
  retainAttentionRows,
  retainTranscriptWindow,
} from "../packages/projection-runtime/src/index.js";

import type { P10FixtureDeps } from "./support/p10-fixture.js";
import {
  insertDependencyRow,
  insertEventRow,
  insertMessageRow,
  insertProjectRootRow,
  insertWorkRow,
  insertWorkspaceRow,
  makeP10Deps,
  p10Child,
  p10Project,
  p10Root,
  seedCanonical,
  setCurrentWork,
} from "./support/p10-fixture.js";

/** P10-009 — rebuild at scale (P10 `04`): checkpointed catch-up per
 * materialized projection along the P1 offsets face (view-prefixed
 * consumer ids), drift forced reset (corrected floor−1 rewind), replay
 * dependency order (raw fact views → EffectiveFacts → Attention last),
 * RB-4 per-view query correctness, Inbox reconciliation orchestration,
 * projection-side retention, and the journal-horizon negative. */

const W_ROOT = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000d1");
const DEP_1 = "dep_00000000-0000-7000-8000-0000000000d1";
const MSG_NO_INBOX = "msg_00000000-0000-7000-8000-0000000000d1";

const consumerIdOf = (stage: (typeof REBUILD_STAGE_ORDER)[number]) =>
  `p10-rebuild:${stage}`;

// --- app: p10 fixture stores + the P1/P9 consumer faces ----------------------

const makeRebuildApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const stores = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(DependencyRepositoryLive, infra),
    Layer.provide(VerificationRepositoryLive, infra),
    Layer.provide(EvidenceRepositoryLive, infra),
    Layer.provide(AcceptanceRepositoryLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(MessageStoreLive, infra),
    Layer.provide(InboxProjectionStoreLive, infra),
    Layer.provide(ConsumerOffsetStoreLive, infra),
    Layer.provide(ConsumerDeadLetterStoreLive, infra),
    Layer.provide(ProjectionStoreLive, infra),
  );
  return Layer.mergeAll(
    infra,
    stores,
    Layer.provide(DependencyAwareRunnableWorkSourceLive, stores),
  ) as unknown as Layer.Layer<SqlClient>;
};

const runRebuild = <A, R>(program: Effect.Effect<A, unknown, R>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        program as Effect.Effect<A, unknown, SqlClient>,
        makeRebuildApp(),
      ),
    ),
  );

interface RebuildHarness {
  readonly deps: RebuildOrchestrationDeps;
  readonly fixture: P10FixtureDeps;
  readonly offsetOf: (
    stage: (typeof REBUILD_STAGE_ORDER)[number],
  ) => Effect.Effect<number, unknown, never>;
  readonly catchUpSpy: ReadonlyArray<{
    readonly stage: string;
    readonly fromSequence: number;
    readonly applied: number;
  }>;
}

const makeRebuildHarness = (
  wrapCatchUp?: (
    inner: RebuildOrchestrationDeps["catchUpView"],
  ) => RebuildOrchestrationDeps["catchUpView"],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const tx = yield* TransactionPort;
    const offsets = yield* ConsumerOffsetStore;
    const journal = yield* DomainEventJournal;
    const deadLetters = yield* ConsumerDeadLetterStore;
    const projection = yield* ProjectionStore;
    const fixture = yield* makeP10Deps();

    const prunedFloor = (projectId: ProjectId) =>
      Effect.map(
        sql.unsafe<{ floor: number | null }>(
          "SELECT MIN(sequence) AS floor FROM domain_events WHERE project_id = ?",
          [projectId],
        ),
        (rows) => Number(rows[0]?.floor ?? 0),
      ).pipe(Effect.mapError(projectionReadError));

    const catchUpSpy: Array<{
      stage: string;
      fromSequence: number;
      applied: number;
    }> = [];

    const baseCatchUp: RebuildOrchestrationDeps["catchUpView"] = (
      stage,
      projectId,
      batchSize,
    ) =>
      Effect.map(
        runConsumerBatch(consumerIdOf(stage), projectId, batchSize ?? 100).pipe(
          Effect.provideService(TransactionPort, tx),
          Effect.provideService(DomainEventJournal, journal),
          Effect.provideService(ConsumerOffsetStore, offsets),
          Effect.provideService(ConsumerDeadLetterStore, deadLetters),
          Effect.provideService(ProjectionStore, projection),
          Effect.mapError(projectionReadError),
        ),
        (result) => {
          catchUpSpy.push({
            stage,
            fromSequence: result.fromSequence,
            applied: result.applied,
          });
          return result;
        },
      );

    const deps: RebuildOrchestrationDeps = {
      prunedFloor,
      journalLastSequence: fixture.journalLastSequence,
      readViewCheckpoint: (stage, projectId) =>
        Effect.mapError(
          tx.transact(offsets.read(consumerIdOf(stage), projectId)),
          projectionReadError,
        ),
      catchUpView:
        wrapCatchUp === undefined ? baseCatchUp : wrapCatchUp(baseCatchUp),
      rebuildView: (stage, projectId) =>
        Effect.mapError(
          rebuildProjection(consumerIdOf(stage), projectId).pipe(
            Effect.provideService(TransactionPort, tx),
            Effect.provideService(DomainEventJournal, journal),
            Effect.provideService(ConsumerOffsetStore, offsets),
            Effect.provideService(ConsumerDeadLetterStore, deadLetters),
            Effect.provideService(ProjectionStore, projection),
            Effect.provideService(SqlClient, sql),
          ),
          projectionReadError,
        ),
      forceResetView: (stage, projectId) =>
        Effect.mapError(
          tx.transact(
            Effect.gen(function* () {
              yield* projection.reset();
              const floor = yield* prunedFloor(projectId);
              const rewoundTo = Math.max(floor - 1, 0);
              yield* offsets.advance(consumerIdOf(stage), projectId, rewoundTo);
              return { rewoundTo };
            }),
          ),
          projectionReadError,
        ),
      listWorkspaces: (projectId) =>
        Effect.map(
          fixture.tree.listWorkspacesByProject(projectId),
          (workspaces) =>
            workspaces.map((workspace) => ({
              workspaceId: workspace.workspaceId,
            })),
        ),
      reconcileInbox: (workspaceId) =>
        reconcileInbox(workspaceId, fixture.inboxReconcile),
    };

    const offsetOf = (
      stage: (typeof REBUILD_STAGE_ORDER)[number],
    ): Effect.Effect<number, unknown, never> =>
      Effect.map(
        sql.unsafe<{ last_sequence: number }>(
          "SELECT last_sequence FROM consumer_offsets WHERE consumer_id = ? AND project_id = ?",
          [consumerIdOf(stage), p10Project],
        ),
        (rows) => Number(rows[0]?.last_sequence ?? 0),
      );

    return {
      deps,
      fixture,
      offsetOf,
      catchUpSpy,
    };
  });

// --- canonical seed ------------------------------------------------------------

const migrate = Effect.gen(function* () {
  yield* runMigrations(P8_MIGRATIONS);
});

const seedBase = seedCanonical(
  Effect.gen(function* () {
    yield* insertProjectRootRow(p10Root, p10Project);
    yield* insertWorkspaceRow(
      { workspaceId: p10Root, parentWorkspaceId: null, name: "root" },
      p10Project,
    );
    yield* insertWorkspaceRow(
      { workspaceId: p10Child, parentWorkspaceId: p10Root, name: "child" },
      p10Project,
    );
    yield* insertWorkRow(
      { workId: W_ROOT, workspaceId: p10Root, objective: "rebuild" },
      p10Project,
    );
    yield* setCurrentWork(p10Root, W_ROOT);
    yield* insertDependencyRow({
      dependencyId: DEP_1,
      consumerWorkId: W_ROOT,
      producerWorkspaceId: p10Child,
    });
    // Inbox reconciliation fixture: a canonical message fact with NO
    // inbox row (MissingEntry drift — repaired only via P6 admission).
    yield* insertMessageRow({
      messageId: MSG_NO_INBOX,
      senderWorkspaceId: p10Child,
      recipientWorkspaceId: p10Root,
      kind: "Report",
      bodyRef: "blob:r1",
      sentAt: "t2",
    });
  }),
);

const neutralEvent = (n: number) =>
  insertEventRow({
    eventId: `evt_00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
    projectId: p10Project,
    eventType: "ProjectPolicyChanged",
    payload: { n },
    occurredAt: `t${n}`,
  });

const unfulfillableEvent = insertEventRow({
  eventId: "evt_00000000-0000-7000-8000-000000000004",
  projectId: p10Project,
  eventType: "DependencyMarkedUnfulfillable",
  payload: { dependencyId: DEP_1, dependencyRevision: 0 },
  occurredAt: "t4",
});

const seedJournal = seedCanonical(
  Effect.gen(function* () {
    yield* neutralEvent(1);
    yield* neutralEvent(2);
    yield* neutralEvent(3);
    yield* unfulfillableEvent;
    yield* neutralEvent(5);
    yield* neutralEvent(6);
  }),
);

/** Incremental application: append one event, then checkpointed catch-up
 * of every stage (this is the incremental path RB-4 compares against). */
const incrementalApply = (h: RebuildHarness) =>
  Effect.gen(function* () {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      yield* seedCanonical(n === 4 ? unfulfillableEvent : neutralEvent(n));
      for (const stage of REBUILD_STAGE_ORDER) {
        for (;;) {
          const result = yield* h.deps.catchUpView(stage, p10Project, 100);
          if (result.applied + result.quarantined === 0) {
            break;
          }
        }
      }
    }
  });

interface ViewStates {
  readonly attention: ReadonlyArray<
    import("../packages/projection-runtime/src/index.js").AttentionRow
  >;
  readonly effectiveFacts: import("../packages/projection-runtime/src/index.js").EffectiveFactsSnapshot;
  readonly tree: import("../packages/projection-runtime/src/index.js").TreeViewNode;
  readonly usage: ReadonlyArray<
    import("../packages/projection-runtime/src/index.js").UsageRowView
  >;
}

const captureViews = (
  h: RebuildHarness,
): Effect.Effect<ViewStates, unknown, SqlClient> =>
  Effect.gen(function* () {
    return {
      attention: yield* deriveProjectAttention(p10Project, h.fixture.attention),
      effectiveFacts: yield* deriveEffectiveFacts(
        p10Root,
        h.fixture.effectiveFacts,
      ),
      tree: yield* buildTreeView({ projectId: p10Project }, h.fixture.tree),
      usage: yield* deriveUsageRows(
        { projectId: p10Project, groupBy: "workspace" },
        h.fixture.usage,
      ),
    };
  });

const CANONICAL_TABLES = [
  "domain_events",
  "project_event_sequences",
  "projects",
  "workspaces",
  "works",
  "dependencies",
  "messages",
  "inbox_entries",
  "sessions",
  "executions",
  "verifications",
];

const snapshotTables = (
  tables: ReadonlyArray<string>,
): Effect.Effect<Record<string, string>, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const out: Record<string, string> = {};
    for (const table of tables) {
      const rows = yield* sql.unsafe<Record<string, unknown>>(
        `SELECT * FROM "${table}" ORDER BY rowid`,
      );
      out[table] = JSON.stringify(rows);
    }
    return out;
  });

const regressAttentionWatermark = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.unsafe(
    "UPDATE consumer_offsets SET last_sequence = 1 WHERE consumer_id = ?",
    [consumerIdOf("attention")],
  );
});

const pruneBelowFloor = (floor: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "DELETE FROM domain_events WHERE project_id = ? AND sequence < ?",
      [p10Project, floor],
    );
  });

describe("P10-009 rebuild orchestration (04 §1)", () => {
  it("replay dependency order is frozen: raw fact views → EffectiveFacts → Attention last", () => {
    expect([...REBUILD_STAGE_ORDER]).toEqual([
      "raw-facts",
      "effective-facts",
      "tree",
      "usage",
      "attention",
    ]);
    expect(REBUILD_STAGE_ORDER[REBUILD_STAGE_ORDER.length - 1]).toBe(
      "attention",
    );
  });

  it("force drift → orchestrated rebuild → per-view state == incremental replay (RB-4); catch-up never below the pruned floor; journal horizon untouched", async () => {
    await runRebuild(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedBase;
        const h = yield* makeRebuildHarness();
        yield* incrementalApply(h);

        // The incremental reference: every stage checkpoint == journal
        // head, no drift detected.
        for (const stage of REBUILD_STAGE_ORDER) {
          expect(yield* h.offsetOf(stage)).toBe(6);
        }
        const incremental = yield* captureViews(h);

        // Force drift (fixture-side, P1 ownership): prune the journal
        // below sequence 3, then regress the attention watermark to 1.
        yield* pruneBelowFloor(3);
        yield* regressAttentionWatermark;
        const beforeRebuild = yield* snapshotTables(CANONICAL_TABLES);

        const { drift, report } = yield* rebuildOnDetectedDrift(
          h.deps,
          p10Project,
        );
        // Detected drift = exactly the attention stage below the floor.
        expect(drift).toEqual([
          { stage: "attention", watermark: 1, prunedFloor: 3 },
        ]);
        const attentionStage = report.stages.find(
          (stage) => stage.stage === "attention",
        )!;
        expect(attentionStage.driftReset).toBe(true);
        // Corrected rewind form (DID v1.12 G2a): floor − 1.
        expect(attentionStage.resetRewoundTo).toBe(2);
        // Catch-up replays exactly the retained events 3..6 — never
        // below the pruned floor.
        expect(attentionStage.replayed).toBe(4);
        expect(attentionStage.toWatermark).toBe(6);
        // Non-drifted stages: plain checkpointed catch-up, zero replay.
        for (const stage of report.stages.filter(
          (s) => s.stage !== "attention",
        )) {
          expect(stage.driftReset).toBe(false);
          expect(stage.replayed).toBe(0);
          expect(stage.fromWatermark).toBe(6);
        }
        for (const stage of REBUILD_STAGE_ORDER) {
          expect(yield* h.offsetOf(stage)).toBe(6);
        }

        // Journal horizon negative: every canonical table (incl.
        // domain_events and the P1 sequence counter) is byte-identical
        // across the orchestrated rebuild — pruning was the fixture's,
        // the rebuild pruned nothing.
        expect(yield* snapshotTables(CANONICAL_TABLES)).toEqual(beforeRebuild);

        // RB-4 per-view query correctness: rebuild-path derives equal the
        // incremental-path derives for every materialized view.
        const rebuilt = yield* captureViews(h);
        expect(
          compareProjectionState(
            "attention",
            rebuilt.attention,
            incremental.attention,
          ).equal,
        ).toBe(true);
        expect(
          compareProjectionState(
            "effective-facts",
            rebuilt.effectiveFacts,
            incremental.effectiveFacts,
          ).equal,
        ).toBe(true);
        expect(
          compareProjectionState("tree", rebuilt.tree, incremental.tree).equal,
        ).toBe(true);
        expect(
          compareProjectionState("usage", rebuilt.usage, incremental.usage)
            .equal,
        ).toBe(true);

        // Inbox reconciliation orchestrated: the seeded canonical message
        // without an inbox row reports as MissingEntry (audit only).
        const rootReconciliation = report.inboxReconciliation.find(
          (entry) => entry.workspaceId === p10Root,
        )!;
        expect(
          rootReconciliation.drift.some(
            (item) =>
              item.kind === "MissingEntry" &&
              item.entryKey === `msg:${MSG_NO_INBOX}`,
          ),
        ).toBe(true);
      }),
    );
  });

  it("crash mid-rebuild → checkpoint resume from checkpoint+1 (apply-then-advance persists the crash point)", async () => {
    await runRebuild(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedBase;
        yield* seedJournal;
        const sql = yield* SqlClient;

        // Prime every stage checkpoint to 2 (two events incrementally
        // applied per stage).
        const primed = yield* makeRebuildHarness();
        for (const stage of REBUILD_STAGE_ORDER) {
          const result = yield* primed.deps.catchUpView(stage, p10Project, 2);
          expect(result.applied).toBe(2);
        }

        // Crash injection: the first progressing catch-up batch of the
        // orchestration persists (apply-then-advance), then the very
        // next batch call fails — mid-rebuild crash. The wrapper pins
        // batchSize 2 so the crash point lands mid-journal (4 of 6).
        let crashDischarged = false;
        const h = yield* makeRebuildHarness(
          (inner) => (stage, projectId, _batchSize) =>
            inner(stage, projectId, 2).pipe(
              Effect.flatMap((result) => {
                if (
                  !crashDischarged &&
                  result.applied + result.quarantined > 0
                ) {
                  crashDischarged = true;
                  return Effect.fail(
                    projectionReadError("crash injected mid-rebuild"),
                  );
                }
                return Effect.succeed(result);
              }),
            ),
        );
        const failure = yield* Effect.flip(
          orchestrateRebuild(h.deps, {
            projectId: p10Project,
            trigger: "drift-detected",
          }),
        );
        expect(failure._tag).toBe("ProjectionReadFailure");

        // The crash point is a persisted checkpoint: raw-facts advanced
        // to 4 (batch 3,4 applied + advanced atomically); the stages
        // after it in the order never ran.
        const offset = (consumerId: string) =>
          Effect.map(
            sql.unsafe<{ last_sequence: number }>(
              "SELECT last_sequence FROM consumer_offsets WHERE consumer_id = ?",
              [consumerId],
            ),
            (rows) => Number(rows[0]?.last_sequence ?? 0),
          );
        expect(yield* offset(consumerIdOf("raw-facts"))).toBe(4);
        expect(yield* offset(consumerIdOf("effective-facts"))).toBe(2);

        // Resume: a fresh orchestration catches up FROM the checkpoint —
        // raw-facts resumes at 4 (reads 5,6 only), later stages at 2.
        const resumed = yield* makeRebuildHarness();
        const report = yield* orchestrateRebuild(resumed.deps, {
          projectId: p10Project,
          trigger: "drift-detected",
        });
        const rawFactsStage = report.stages.find(
          (stage) => stage.stage === "raw-facts",
        )!;
        expect(rawFactsStage.fromWatermark).toBe(4);
        expect(rawFactsStage.replayed).toBe(2);
        expect(rawFactsStage.toWatermark).toBe(6);
        const effectiveFactsStage = report.stages.find(
          (stage) => stage.stage === "effective-facts",
        )!;
        expect(effectiveFactsStage.fromWatermark).toBe(2);
        expect(effectiveFactsStage.replayed).toBe(4);
        for (const stage of REBUILD_STAGE_ORDER) {
          expect(yield* offset(consumerIdOf(stage))).toBe(6);
        }

        // The resumed end state is the correct incremental state: the
        // attention view carries the unfulfillable fact (the
        // vacant-producer live join over the still-Unsatisfied seeded
        // dependency is the expected second row).
        const views = yield* captureViews(resumed);
        const unfulfillable = views.attention.filter(
          (row) => row.source === "DependencyUnfulfillable",
        );
        expect(unfulfillable).toHaveLength(1);
        expect(unfulfillable[0]!.dedupKey).toBe(`unfulfillable:${DEP_1}:0`);
        // Resume never re-read below its checkpoint: every raw-facts
        // catch-up during resume started at 4 or 6.
        const rawFactsFroms = resumed.catchUpSpy
          .filter((entry) => entry.stage === "raw-facts")
          .map((entry) => entry.fromSequence);
        expect(rawFactsFroms).toEqual([4, 6]);
      }),
    );
  });

  it("explicit operator trigger rides the P9 generic rebuild unchanged (full replay per stage); startup hook declares its trigger", async () => {
    await runRebuild(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedBase;
        yield* seedJournal;
        const h = yield* makeRebuildHarness();
        for (const stage of REBUILD_STAGE_ORDER) {
          for (;;) {
            const result = yield* h.deps.catchUpView(stage, p10Project, 100);
            if (result.applied + result.quarantined === 0) {
              break;
            }
          }
        }
        const report = yield* operatorRebuild(h.deps, p10Project);
        expect(report.trigger).toBe("explicit-operator");
        expect(report.stages).toHaveLength(REBUILD_STAGE_ORDER.length);
        for (const stage of report.stages) {
          expect(stage.driftReset).toBe(false);
          expect(stage.resetRewoundTo).toBe(null);
          // The P9 generic rebuild replays the full retained journal.
          expect(stage.replayed).toBe(6);
          expect(stage.toWatermark).toBe(6);
        }
      }),
    );

    await runRebuild(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedBase;
        yield* seedJournal;
        const h = yield* makeRebuildHarness();
        // Fresh checkpoints (0) sit below the floor (1): the startup
        // pass takes the forced-reset cold-start path and lands at head.
        const report = yield* makeStartupRebuildHook(h.deps)(p10Project);
        expect(report.trigger).toBe("startup-after-nine-step");
        for (const stage of report.stages) {
          expect(stage.toWatermark).toBe(6);
        }
        for (const stage of REBUILD_STAGE_ORDER) {
          expect(yield* h.offsetOf(stage)).toBe(6);
        }
      }),
    );
  });

  it("RB-4 comparison helper reports mismatch detail (negative control)", () => {
    const comparison = compareProjectionState(
      "attention",
      [{ dedupKey: "a" }, { dedupKey: "b" }],
      [{ dedupKey: "a" }],
    );
    expect(comparison.equal).toBe(false);
    expect(comparison.mismatches[0]!.path).toBe(".length");
    expect(comparison.view).toBe("attention");
  });
});

describe("P10-009 projection-side retention (04 §1.2 — view lifetimes only)", () => {
  it("transcript paging window keeps the most recent page of entries", () => {
    const entries = [1, 2, 3, 4, 5].map((n) => ({ at: `t${n}` }));
    const window = retainTranscriptWindow(entries, { limit: 2 });
    expect(window.kept).toEqual([{ at: "t4" }, { at: "t5" }]);
    expect(window.dropped).toEqual([{ at: "t1" }, { at: "t2" }, { at: "t3" }]);
    expect(retainTranscriptWindow(entries, { limit: 9 }).kept).toHaveLength(5);
  });

  it("attention-row lifetime ends when the underlying fact is superseded (dedup key no longer live)", () => {
    const rows = [
      {
        source: "DependencyUnfulfillable" as const,
        severity: "Attention" as const,
        targetWorkspaceId: p10Root,
        dedupKey: "unfulfillable:dep:0",
        summary: "live",
        occurredAt: "t",
      },
      {
        source: "Deadlock" as const,
        severity: "ActionRequired" as const,
        targetWorkspaceId: p10Root,
        dedupKey: "deadlock:[old]:ws",
        summary: "superseded",
        occurredAt: "t",
      },
    ];
    const retained = retainAttentionRows(
      rows,
      new Set(["unfulfillable:dep:0"]),
    );
    expect(retained.kept.map((row) => row.dedupKey)).toEqual([
      "unfulfillable:dep:0",
    ]);
    expect(retained.dropped.map((row) => row.dedupKey)).toEqual([
      "deadlock:[old]:ws",
    ]);
  });

  it("consumed-inbox summary aging: consumed-before-cutoff entries collapse to a count; underlying rows stay canonical", () => {
    const rows = [
      { entryKey: "msg:a", consumedAt: null },
      { entryKey: "msg:b", consumedAt: "t9" },
      { entryKey: "msg:c", consumedAt: "t1" },
      { entryKey: "msg:d", consumedAt: "t2" },
    ];
    const aged = ageConsumedInboxEntries(rows, { cutoff: "t5" });
    expect(aged.live.map((row) => row.entryKey)).toEqual(["msg:a", "msg:b"]);
    expect(aged.agedSummary).toEqual({ consumedBeforeCutoff: 2 });
  });
});
