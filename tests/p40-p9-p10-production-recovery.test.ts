import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import {
  AttentionProjectionStoreLive,
  ClockLive,
  ConsumerDeadLetterStoreLive,
  ConsumerOffsetStoreLive,
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  makeProjectAttentionProjectionStore,
  rebuildProjection,
  runConsumerBatch,
  ToolInvocationStoreLive,
  ToolObservationReplayAttentionFactStoreLive,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  AttentionProjectionStore,
  ConsumerOffsetStore,
  DomainEventJournal,
  type ProjectId,
  ProjectionStore,
  sha256Hex,
  ToolInvocationStore,
  ToolObservationReplayAttentionFactStore,
  TransactionPort,
  type TransactionPortService,
} from "../packages/ports/src/index.js";
import { deriveProjectAttention } from "../packages/projection-runtime/src/attention-loader.js";
import {
  createSchema42TestDatabase,
  type Schema42TestDatabase,
} from "./support/schema42-database.js";

const projectId = "prj_018f2b3c-4d5e-7abc-8def-0123456789b1";
const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789b1";
const sessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789b1";
const executionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789b1";
const invocationId = "tin_018f2b3c-4d5e-7abc-8def-0123456789b1";
const providerTurnId = "ptn_018f2b3c-4d5e-7abc-8def-0123456789b1";
const logicalActionId = "lac_018f2b3c-4d5e-7abc-8def-0123456789b1";
const callRef = "call-p40-p9-p10";
const workerId = "worker:p40-p9-p10";
const incarnationId = "incarnation:p40-p9-p10";
const consumerId = "p10:attention:p40-test";
const now = "2026-10-12T00:00:01.000Z";
const failureCode = "Missing" as const;
const databases: Schema42TestDatabase[] = [];

const fence = {
  executionId,
  workerId,
  workerIncarnationId: incarnationId,
  fencingGeneration: 0,
} as never;

const intent = {
  invocationId,
  executionId,
  workspaceId,
  toolName: "read",
  toolVersion: "1",
  sideEffectSemantics: "ReadOnly",
  argumentsJson: "{}",
  resolvedRegions: [],
  approvalId: null,
  intentAt: now,
} as never;

const makeFixture = (databaseFilename: string) => {
  const sqlite = layer({ filename: databaseFilename });
  const infra = Layer.mergeAll(sqlite, ClockLive, IdGeneratorLive);
  const journal = Layer.provideMerge(DomainEventJournalLive, infra);
  const replayFacts = Layer.provideMerge(
    ToolObservationReplayAttentionFactStoreLive,
    Layer.mergeAll(infra, journal),
  );
  const stores = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
    Layer.provide(AttentionProjectionStoreLive, infra),
    Layer.provide(ConsumerOffsetStoreLive, infra),
    Layer.provide(ConsumerDeadLetterStoreLive, infra),
  );
  return { app: Layer.mergeAll(infra, journal, replayFacts, stores) };
};

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.cleanup();
  }
});

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        `INSERT INTO projects (
          project_id, name, root_workspace_id, project_policy,
          project_policy_revision, default_configuration, environment_ref,
          lifecycle, revision, created_at, updated_at
        ) VALUES (?, 'P40 P9 P10', ?, '{}', 0, '{}', 'local', 'Open', 0, 't0', 't0')`,
        [projectId, workspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO sessions (
          session_id, binding_kind, workspace_id, execution_id,
          context_epoch, created_at
        ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
        [sessionId, workspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO workspaces (
          workspace_id, project_id, parent_workspace_id, name,
          responsibility_definition, responsibility_revision,
          resource_boundary, resource_boundary_revision, agent_binding,
          primary_session_id, current_work_id, workspace_policy,
          workspace_policy_revision, revision, lifecycle, created_at, updated_at
        ) VALUES (?, ?, NULL, 'root', '{}', 0, '{}', 0, '{}', ?, NULL, '{}', 0, 0, 'Active', 't0', 't0')`,
        [workspaceId, projectId, sessionId],
      );
      yield* sql.unsafe(
        `INSERT INTO executions (
          execution_id, project_id, binding_kind, workspace_id,
          episode_kind, episode_ref, episode_revision, parent_execution_id,
          mission, session_id, admitted_at, stop_requested_at,
          settlement_kind, settlement_json, settled_at
        ) VALUES (?, ?, 'execution_bound', ?, NULL, NULL, NULL, NULL,
          'P9 P10 recovery projection', ?, 't0', NULL, NULL, NULL, NULL)`,
        [executionId, projectId, workspaceId, sessionId],
      );
      yield* sql.unsafe(
        `INSERT INTO execution_leases (
          execution_id, worker_id, worker_incarnation_id, generation,
          expires_at, updated_at
        ) VALUES (?, ?, ?, 0, '2999-01-01T00:00:00.000Z', 't0')`,
        [executionId, workerId, incarnationId],
      );
    }),
  );
});

const sourceFactsWithoutOtherP10Sources = {
  findAssignWorkBindingFailure: () => Effect.succeed(Option.none()),
  findDeliverReplayFailure: () => Effect.succeed(Option.none()),
  listDeliverReplayFailures: () => Effect.succeed([]),
  listPendingDeliverReplayAttention: () => Effect.succeed([]),
  // Schema 42 exposes the P41 marker store; this no-facts test source reports
  // the matching capability so P10 reset/rebuild can qualify its empty set.
  isSubmittedDecisionBindingAvailable: () => Effect.succeed(true),
  listSubmittedDecisionBindingFailures: () => Effect.succeed([]),
  acknowledgePendingDeliverReplayAttention: () => Effect.void,
} as never;

const withTxFault = (
  tx: TransactionPortService,
  boundary: "before" | "after",
  armed: { value: boolean },
): TransactionPortService =>
  ({
    transact: <A, E, R>(body: Effect.Effect<A, E, R>) => {
      const operation = tx.transact(body as never);
      if (boundary === "before") {
        return tx.transact(
          Effect.gen(function* () {
            const value = yield* body;
            if (armed.value) {
              armed.value = false;
              return yield* Effect.fail(
                new Error("simulated pre-COMMIT crash"),
              );
            }
            return value;
          }),
        ) as never;
      }
      return operation.pipe(
        Effect.tap(() =>
          armed.value
            ? Effect.sync(() => {
                armed.value = false;
                throw new Error("simulated post-COMMIT crash");
              })
            : Effect.void,
        ),
      ) as never;
    },
  }) as never;

describe("P40 P9/P10 durable replay-failure recovery", () => {
  it("keeps P9 fact/event atomic and projects exactly one P10 row through restart and rebuild", async () => {
    const database = await createSchema42TestDatabase();
    databases.push(database);
    const { app } = makeFixture(database.databaseFilename);
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seed;
          const tx = yield* TransactionPort;
          const invocations = yield* ToolInvocationStore;
          yield* tx.transact(invocations.recordIntent(intent, fence, now));
        }),
        app,
      ),
    );

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const tx = yield* TransactionPort;
          const sql = yield* SqlClient;
          const facts = yield* ToolObservationReplayAttentionFactStore;
          const journal = yield* DomainEventJournal;
          const rows = yield* AttentionProjectionStore;
          const offsets = yield* ConsumerOffsetStore;
          const toolFacts = yield* ToolObservationReplayAttentionFactStore;
          const listP40Rows = (id: ProjectId) => {
            const list = rows.listToolObservationReplayFailures;
            if (list === undefined)
              return Effect.die("P40 row reader unavailable");
            return list(id);
          };
          const p9Counts = () =>
            sql.unsafe<{ readonly facts: number; readonly events: number }>(
              `SELECT
                 (SELECT COUNT(*) FROM tool_observation_replay_attention_facts) AS facts,
                 (SELECT COUNT(*) FROM domain_events
                   WHERE event_type = 'ToolObservationReplayEvidenceEscalated') AS events`,
            );
          const recordFailure = () =>
            facts.recordFailure({
              projectId: projectId as never,
              executionId: executionId as never,
              targetWorkspaceId: workspaceId as never,
              logicalActionId,
              providerTurnId,
              callRef,
              invocationId: invocationId as never,
              failureCode,
              firstDetectedAt: now,
              executionFence: fence,
            });

          const p9Before = yield* Effect.exit(
            tx.transact(
              Effect.gen(function* () {
                yield* recordFailure();
                return yield* Effect.fail(new Error("pre-COMMIT P9 stop"));
              }),
            ),
          );
          expect(Exit.isFailure(p9Before)).toBe(true);
          expect((yield* p9Counts())[0]).toEqual({ facts: 0, events: 0 });

          const p9After = yield* Effect.exit(
            Effect.gen(function* () {
              const persisted = yield* tx.transact(recordFailure());
              return yield* Effect.fail(
                new Error(`post-COMMIT P9 stop:${persisted.attentionFactId}`),
              );
            }),
          );
          expect(Exit.isFailure(p9After)).toBe(true);
          expect((yield* p9Counts())[0]).toEqual({ facts: 1, events: 1 });
          const fact = yield* tx.transact(recordFailure());
          expect(fact.attentionFactId).toBe(
            `att_${sha256Hex(JSON.stringify({ executionId, invocationId, version: 1 }))}`,
          );
          expect((yield* p9Counts())[0]).toEqual({ facts: 1, events: 1 });

          const p10Projection = makeProjectAttentionProjectionStore(
            projectId as never,
            sourceFactsWithoutOtherP10Sources,
            rows,
            undefined,
            toolFacts,
          );
          const poll = (txService: TransactionPortService = tx) =>
            runConsumerBatch(consumerId, projectId as never, 10).pipe(
              Effect.provideService(ProjectionStore, p10Projection),
              Effect.provideService(TransactionPort, txService),
            );
          const p10Before = yield* Effect.exit(
            poll(withTxFault(tx, "before", { value: true })),
          );
          expect(Exit.isFailure(p10Before)).toBe(true);
          expect(
            (yield* tx.transact(listP40Rows(projectId as never))).length,
          ).toBe(0);
          expect(
            yield* tx.transact(offsets.read(consumerId, projectId as never)),
          ).toBe(0);

          const p10After = yield* Effect.exit(
            poll(withTxFault(tx, "after", { value: true })),
          );
          expect(Exit.isFailure(p10After)).toBe(true);
          const afterP10Commit = yield* tx.transact(
            Effect.gen(function* () {
              return {
                rows: yield* listP40Rows(projectId as never),
                offset: yield* offsets.read(consumerId, projectId as never),
              };
            }),
          );
          expect(afterP10Commit.rows).toHaveLength(1);
          expect(afterP10Commit.rows[0]).toMatchObject({
            source: "ToolObservationReplayEvidenceFailure",
            severity: "ActionRequired",
            targetWorkspaceId: workspaceId,
            dedupKey: fact.attentionFactId,
            sourceFactId: fact.attentionFactId,
            sourceEventId: fact.eventId,
            failureCode,
          });
          expect(afterP10Commit.offset).toBe(1);

          const rebuildCrash = yield* Effect.exit(
            rebuildProjection(consumerId, projectId as never, 10, async () => {
              throw new Error("stop after P10 reset/rewind commit");
            }).pipe(Effect.provideService(ProjectionStore, p10Projection)),
          );
          expect(Exit.isFailure(rebuildCrash)).toBe(true);
          const rebuildState = yield* tx.transact(
            Effect.gen(function* () {
              return {
                rows: yield* listP40Rows(projectId as never),
                offset: yield* offsets.read(consumerId, projectId as never),
              };
            }),
          );
          expect(rebuildState.rows).toHaveLength(0);
          expect(rebuildState.offset).toBe(0);

          const rebuildRetry = yield* rebuildProjection(
            consumerId,
            projectId as never,
            10,
          ).pipe(Effect.provideService(ProjectionStore, p10Projection));
          expect(rebuildRetry.replayed).toBe(1);
          const rebuilt = yield* tx.transact(
            Effect.gen(function* () {
              return {
                rows: yield* listP40Rows(projectId as never),
                offset: yield* offsets.read(consumerId, projectId as never),
              };
            }),
          );
          expect(rebuilt.rows).toHaveLength(1);
          expect(rebuilt.rows[0]?.dedupKey).toBe(fact.attentionFactId);
          expect(rebuilt.offset).toBe(1);
          const retained = yield* tx.transact(
            journal.readAfter(projectId as never, 0, 10),
          );
          expect(retained).toHaveLength(1);
          const visibleRows = yield* deriveProjectAttention(
            projectId as never,
            {
              listWorkspacesByProject: () => Effect.succeed([]),
              listExecutionSettlementFacts: () => Effect.succeed([]),
              listOpenVerifications: () => Effect.succeed([]),
              listUnsatisfiedDependencies: () => Effect.succeed([]),
              readEvents: () => Effect.succeed([]),
              listWorksByWorkspace: () => Effect.succeed([]),
              listProjectedToolObservationReplayFailures: (id: ProjectId) =>
                tx.transact(listP40Rows(id)),
            } as never,
          );
          return { fact, p10Row: rebuilt.rows[0], visibleRows };
        }),
        app,
      ),
    );
    expect(result.p10Row?.sourceFactId).toBe(result.fact.attentionFactId);
    expect(result.visibleRows).toContainEqual({
      source: "ToolObservationReplayEvidenceFailure",
      severity: "ActionRequired",
      targetWorkspaceId: workspaceId,
      dedupKey: result.fact.attentionFactId,
      summary:
        "A terminal tool outcome could not be replayed from durable observation evidence; recovery is paused.",
      occurredAt: now,
    });
  }, 120_000);
});
