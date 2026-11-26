import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AcceptanceRepositoryLive,
  ClockLive,
  CommandStoreLive,
  ConsumerDeadLetterStoreLive,
  ConsumerOffsetStoreLive,
  DeliverableRepositoryLive,
  DependencyRepositoryLive,
  DomainEventJournalLive,
  EvidenceRepositoryLive,
  ExecutionRepositoryLive,
  FormationFulfillmentStoreLive,
  FormationProposalStoreLive,
  IdGeneratorLive,
  InboxProjectionStoreLive,
  layer,
  MessageStoreLive,
  ProjectionStoreLive,
  ProjectRepositoryLive,
  rebuildProjection,
  runConsumerBatch,
  TransactionPortLive,
  VerificationRepositoryLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import { DependencyAwareRunnableWorkSourceLive } from "../../apps/single-workspace/src/runnable-source-p7.js";
import { parse, WorkId } from "../../packages/domain/dist/index.js";
import {
  ConsumerDeadLetterStore,
  ConsumerOffsetStore,
  DomainEventJournal,
  ProjectionStore,
  TransactionPort,
} from "../../packages/ports/src/index.js";
import type {
  AttentionRow,
  EffectiveFactsSnapshot,
  TreeViewNode,
  UsageRowView,
} from "../../packages/projection-runtime/src/index.js";
import {
  buildTreeView,
  compareProjectionState,
  deriveEffectiveFacts,
  deriveProjectAttention,
  deriveUsageRows,
  orchestrateRebuild,
  projectionReadError,
  REBUILD_STAGE_ORDER,
  type RebuildOrchestrationDeps,
  rebuildOnDetectedDrift,
  reconcileInbox,
} from "../../packages/projection-runtime/src/index.js";
import { NoHoldWorkReadmissionGateStoreLive } from "../../packages/testkit/src/index.js";
import {
  insertDependencyRow,
  insertEventRow,
  insertMessageRow,
  insertProjectRootRow,
  insertWorkRow,
  insertWorkspaceRow,
  makeP10Deps,
  migrate,
  type FixtureDependencies,
  p10Child,
  p10Project,
  p10Root,
  seedCanonical,
  setCurrentWork,
} from "../support/fixture-support.js";

describe("-acceptance (P10 07 Stories A–G)", () => {
  it("Story E — Rebuild at scale: drift → orchestrated rebuild → RB-4 per-view equality; checkpoint resume from the persisted crash point; journal horizon untouched (negative)", async () => {
    const work = parse(WorkId)("wrk_00000000-0000-7000-8000-0000000000e1");
    const dep = "dep_00000000-0000-7000-8000-0000000000e1";
    const msg = "msg_00000000-0000-7000-8000-0000000000e1";

    const consumerIdOf = (stage: (typeof REBUILD_STAGE_ORDER)[number]) =>
      `p10-acceptance-rebuild:${stage}`;

    const makeApp = () => {
      const base = layer({ filename: ":memory:" });
      const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
      const stores = Layer.mergeAll(
        Layer.provide(TransactionPortLive, infra),
        Layer.provide(ProjectRepositoryLive, infra),
        Layer.provide(WorkspaceRepositoryLive, infra),
        Layer.provide(WorkRepositoryLive, infra),
        Layer.provide(DeliverableRepositoryLive, infra),
        Layer.provide(FormationProposalStoreLive, infra),
        Layer.provide(FormationFulfillmentStoreLive, infra),
        Layer.provide(CommandStoreLive, infra),
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
        NoHoldWorkReadmissionGateStoreLive,
      );
      return Layer.mergeAll(
        infra,
        stores,
        Layer.provide(DependencyAwareRunnableWorkSourceLive, stores),
      ) as unknown as Layer.Layer<SqlClient>;
    };

    const run = <A, R>(program: Effect.Effect<A, unknown, R>): Promise<A> =>
      Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            program as Effect.Effect<A, unknown, SqlClient>,
            makeApp(),
          ),
        ),
      );

    const makeHarness = (
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

        const prunedFloor = (projectId: typeof p10Project) =>
          Effect.map(
            sql.unsafe<{ floor: number | null }>(
              "SELECT MIN(sequence) AS floor FROM domain_events WHERE project_id = ?",
              [projectId],
            ),
            (rows) => Number(rows[0]?.floor ?? 0),
          ).pipe(Effect.mapError(projectionReadError));

        const baseCatchUp: RebuildOrchestrationDeps["catchUpView"] = (
          stage,
          projectId,
          batchSize,
        ) =>
          Effect.map(
            runConsumerBatch(
              consumerIdOf(stage),
              projectId,
              batchSize ?? 100,
            ).pipe(
              Effect.provideService(TransactionPort, tx),
              Effect.provideService(DomainEventJournal, journal),
              Effect.provideService(ConsumerOffsetStore, offsets),
              Effect.provideService(ConsumerDeadLetterStore, deadLetters),
              Effect.provideService(ProjectionStore, projection),
              Effect.mapError(projectionReadError),
            ),
            (result) => result,
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
                  yield* offsets.advance(
                    consumerIdOf(stage),
                    projectId,
                    rewoundTo,
                  );
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

        return { deps, fixture, offsetOf };
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
          { workId: work, workspaceId: p10Root, objective: "rebuild" },
          p10Project,
        );
        yield* setCurrentWork(p10Root, work);
        yield* insertDependencyRow({
          dependencyId: dep,
          consumerWorkId: work,
          producerWorkspaceId: p10Child,
        });
        yield* insertMessageRow({
          messageId: msg,
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
      payload: { dependencyId: dep, dependencyRevision: 0 },
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

    interface ViewStates {
      readonly attention: ReadonlyArray<AttentionRow>;
      readonly effectiveFacts: EffectiveFactsSnapshot;
      readonly tree: TreeViewNode;
      readonly usage: ReadonlyArray<UsageRowView>;
    }

    const captureViews = (
      fixture: FixtureDependencies,
    ): Effect.Effect<ViewStates, unknown, SqlClient> =>
      Effect.gen(function* () {
        return {
          attention: yield* deriveProjectAttention(
            p10Project,
            fixture.attention,
          ),
          effectiveFacts: yield* deriveEffectiveFacts(
            p10Root,
            fixture.effectiveFacts,
          ),
          tree: yield* buildTreeView({ projectId: p10Project }, fixture.tree),
          usage: yield* deriveUsageRows(
            { projectId: p10Project, groupBy: "workspace" },
            fixture.usage,
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

    await run(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedBase;
        const h = yield* makeHarness();

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
        for (const stage of REBUILD_STAGE_ORDER) {
          expect(yield* h.offsetOf(stage)).toBe(6);
        }
        const incremental = yield* captureViews(h.fixture);

        yield* pruneBelowFloor(3);
        yield* regressAttentionWatermark;
        const beforeRebuild = yield* snapshotTables(CANONICAL_TABLES);

        const { drift, report } = yield* rebuildOnDetectedDrift(
          h.deps,
          p10Project,
        );
        expect(drift).toEqual([
          { stage: "attention", watermark: 1, prunedFloor: 3 },
        ]);
        // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
        const attentionStage = report.stages.find(
          (stage) => stage.stage === "attention",
        )!;
        expect(attentionStage.driftReset).toBe(true);
        expect(attentionStage.resetRewoundTo).toBe(2);
        expect(attentionStage.replayed).toBe(4);
        expect(attentionStage.toWatermark).toBe(6);
        for (const stage of report.stages.filter(
          (entry) => entry.stage !== "attention",
        )) {
          expect(stage.driftReset).toBe(false);
          expect(stage.replayed).toBe(0);
        }
        for (const stage of REBUILD_STAGE_ORDER) {
          expect(yield* h.offsetOf(stage)).toBe(6);
        }

        const sql = yield* SqlClient;
        const floorRows = yield* sql.unsafe<{ floor: number | null }>(
          "SELECT MIN(sequence) AS floor FROM domain_events WHERE project_id = ?",
          [p10Project],
        );
        expect(Number(floorRows[0]?.floor ?? 0)).toBe(3);
        expect(yield* snapshotTables(CANONICAL_TABLES)).toEqual(beforeRebuild);

        const rebuilt = yield* captureViews(h.fixture);
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
      }),
    );

    await run(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedBase;
        yield* seedJournal;
        const sql = yield* SqlClient;

        const primed = yield* makeHarness();
        for (const stage of REBUILD_STAGE_ORDER) {
          const result = yield* primed.deps.catchUpView(stage, p10Project, 2);
          expect(result.applied).toBe(2);
        }

        let crashDischarged = false;
        const h = yield* makeHarness(
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

        const resumed = yield* makeHarness();
        const report = yield* orchestrateRebuild(resumed.deps, {
          projectId: p10Project,
          trigger: "drift-detected",
        });
        // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
        const rawFactsStage = report.stages.find(
          (stage) => stage.stage === "raw-facts",
        )!;
        expect(rawFactsStage.fromWatermark).toBe(4);
        expect(rawFactsStage.replayed).toBe(2);
        expect(rawFactsStage.toWatermark).toBe(6);
        for (const stage of REBUILD_STAGE_ORDER) {
          expect(yield* offset(consumerIdOf(stage))).toBe(6);
        }

        const views = yield* captureViews(resumed.fixture);
        const unfulfillable = views.attention.filter(
          (row) => row.source === "DependencyUnfulfillable",
        );
        expect(unfulfillable).toHaveLength(1);
        expect(unfulfillable[0]?.dedupKey).toBe(`unfulfillable:${dep}:0`);
      }),
    );
  });
});
