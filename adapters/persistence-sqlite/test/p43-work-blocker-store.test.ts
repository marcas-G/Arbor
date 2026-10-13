import type {
  InboxEntry,
  Sha256,
  WorkBlocker,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import {
  InboxProjectionStore,
  TransactionPort,
  WorkBlockerStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  CURRENT_MIGRATIONS,
  InboxProjectionStoreLive,
  layer,
  P38_MIGRATIONS,
  P43_BLOCKED_WORKEPISODE_MIGRATION,
  runMigrations,
  TransactionPortLive,
  WorkBlockerStoreLive,
} from "../src/index.js";
import { createSchema42TestDatabase } from "../../../tests/support/schema42-database.js";

const projectId = "prj_blocked_test";
const workspaceId = "ws_blocked_test" as WorkspaceId;
const sessionId = "ses_blocked_test";
const workId = "wrk_blocked_test" as WorkId;
const executionId = "exe_blocked_test";
const appLayer = (filename = ":memory:") => {
  const base = layer({ filename });
  return Layer.mergeAll(
    base,
    Layer.provide(TransactionPortLive, base),
    Layer.provide(WorkBlockerStoreLive, base),
    Layer.provide(InboxProjectionStoreLive, base),
  );
};

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id,name,root_workspace_id,project_policy,project_policy_revision,default_configuration,environment_ref,lifecycle,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "p",
          workspaceId,
          "{}",
          0,
          "{}",
          "local",
          "Open",
          0,
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id,binding_kind,workspace_id,execution_id,context_epoch,created_at) VALUES (?,?,?,NULL,?,?)",
        [sessionId, "WorkspacePrimary", workspaceId, 0, "t"],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id,project_id,parent_workspace_id,name,responsibility_definition,responsibility_revision,resource_boundary,resource_boundary_revision,agent_binding,primary_session_id,current_work_id,workspace_policy,workspace_policy_revision,revision,lifecycle,created_at,updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)",
        [
          workspaceId,
          projectId,
          "w",
          "{}",
          0,
          "{}",
          0,
          "{}",
          sessionId,
          "{}",
          0,
          0,
          "Active",
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO works (work_id,project_id,workspace_id,objective,why,constraints,completion_expectation,verification_mission,provenance,lifecycle,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          workId,
          projectId,
          workspaceId,
          "o",
          "w",
          "[]",
          "done",
          "{}",
          "{}",
          "Open",
          0,
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id,project_id,binding_kind,workspace_id,episode_kind,episode_ref,episode_revision,parent_execution_id,mission,session_id,admitted_at,stop_requested_at,settlement_kind,settlement_json,settled_at) VALUES (?,?,?,?,?,?,?,NULL,NULL,?,?,NULL,NULL,NULL,NULL)",
        [
          executionId,
          projectId,
          "workspace",
          workspaceId,
          "WorkEpisode",
          workId,
          0,
          sessionId,
          "t",
        ],
      );
    }),
  );
});

const baseBlocker: WorkBlocker = {
  blockerId: "a".repeat(64) as Sha256,
  projectId: projectId as WorkBlocker["projectId"],
  workspaceId,
  workId,
  targetWorkRevision: 0 as WorkBlocker["targetWorkRevision"],
  failureFingerprint: "b".repeat(64) as Sha256,
  state: "Open",
  openCycleId: executionId as WorkBlocker["openCycleId"],
  latestRequestRef: "blob:req-1",
  failedActionRefs: [
    {
      executionId: executionId as WorkBlocker["openCycleId"],
      providerTurnId: "ptn_blocked_test" as never,
      logicalStepNo: 0,
      repairAttempt: 0,
      actionIndex: 0,
      logicalActionId: "la_blocked_test",
      callRef: "call:0",
      resultRef: "result:0",
      settlementRef: "settlement:0",
      observationSourceRef: "observation:0",
      terminalDenial: { _tag: "HandlerRejected", routeKind: "Executable" },
    },
  ],
  revision: 0,
};

const applyP43AndSeed = Effect.gen(function* () {
  yield* runMigrations([
    {
      id: P43_BLOCKED_WORKEPISODE_MIGRATION.migrationVersion,
      name: "blocked_work_episode_ledger_test_only",
      sql: P43_BLOCKED_WORKEPISODE_MIGRATION.sql,
    },
  ]);
  yield* seed;
});

const migrateLegacyTestDatabase = Effect.gen(function* () {
  yield* runMigrations(P38_MIGRATIONS);
  yield* seed;
});

describe("unregistered P43 WorkBlocker and Inbox sequence adapters", () => {
  it("keeps the descriptor out of the production migration prefix", () => {
    expect(CURRENT_MIGRATIONS.some((migration) => migration.id === 43)).toBe(
      false,
    );
  });

  it("keeps legacy Inbox admission functional before P43", async () => {
    const program = Effect.gen(function* () {
      yield* migrateLegacyTestDatabase;
      const tx = yield* TransactionPort;
      const inbox = yield* InboxProjectionStore;
      const entry: InboxEntry = {
        recipientWorkspaceId: workspaceId,
        entryKey: "legacy-entry",
        kind: "Message",
        summary: "legacy",
        admittedAt: "t0",
      };
      yield* tx.transact(inbox.admitUpsert(entry));
      return yield* tx.transact(inbox.countByKey(workspaceId, entry.entryKey));
    });
    expect(await Effect.runPromise(Effect.provide(program, appLayer()))).toBe(
      1,
    );
  });

  it("opens, updates idempotently, reopens, resolves, and supersedes with revision guards", async () => {
    const database = await createSchema42TestDatabase();
    try {
      const program = Effect.gen(function* () {
        yield* applyP43AndSeed;
        const tx = yield* TransactionPort;
        const store = yield* WorkBlockerStore;

        const opened = yield* tx.transact(store.openOrUpdate(baseBlocker));
        const first = yield* tx.transact(store.findById(baseBlocker.blockerId));
        const replayed = yield* tx.transact(store.openOrUpdate(baseBlocker));
        const afterReplay = yield* tx.transact(
          store.findById(baseBlocker.blockerId),
        );

        const refreshed = yield* tx.transact(
          store.openOrUpdate({
            ...baseBlocker,
            latestRequestRef: "blob:req-2",
          }),
        );
        const updated = yield* tx.transact(
          store.findById(baseBlocker.blockerId),
        );
        const resolution = {
          blockerId: baseBlocker.blockerId,
          workId,
          targetWorkRevision: baseBlocker.targetWorkRevision,
          successfulActionRefs: ["success:action-1"] as const,
        };
        yield* tx.transact(store.resolve(resolution));
        yield* tx.transact(store.resolve(resolution));
        const resolved = yield* tx.transact(
          store.findById(baseBlocker.blockerId),
        );

        const reopened = yield* tx.transact(
          store.openOrUpdate({ ...refreshed, latestRequestRef: "blob:req-3" }),
        );
        yield* tx.transact(
          store.supersede(workId, baseBlocker.targetWorkRevision),
        );
        const superseded = yield* tx.transact(
          store.findById(baseBlocker.blockerId),
        );
        return {
          opened,
          replayed,
          first,
          afterReplay,
          updated,
          resolved,
          reopened,
          superseded,
        };
      });
      const result = await Effect.runPromise(
        Effect.provide(program, appLayer(database.databaseFilename)),
      );
      expect(result.opened.revision).toBe(0);
      expect(result.replayed.revision).toBe(0);
      expect(Option.isSome(result.first)).toBe(true);
      expect(Option.getOrThrow(result.first).revision).toBe(0);
      expect(Option.getOrThrow(result.afterReplay).revision).toBe(0);
      expect(Option.getOrThrow(result.updated).latestRequestRef).toBe(
        "blob:req-2",
      );
      expect(Option.getOrThrow(result.updated).revision).toBe(1);
      expect(Option.getOrThrow(result.resolved).state).toBe("Resolved");
      expect(Option.getOrThrow(result.resolved).revision).toBe(2);
      expect(Option.getOrThrow(result.superseded).state).toBe("Superseded");
      expect(Option.getOrThrow(result.superseded).revision).toBe(4);
      expect(result.reopened.state).toBe("Open");
      expect(result.reopened.revision).toBe(3);
    } finally {
      database.cleanup();
    }
  }, 120_000);

  it("advances Inbox sequence only on new admissions, and keeps it monotonic after consume", async () => {
    const database = await createSchema42TestDatabase();
    try {
      const program = Effect.gen(function* () {
        yield* applyP43AndSeed;
        const tx = yield* TransactionPort;
        const inbox = yield* InboxProjectionStore;
        const entry: InboxEntry = {
          recipientWorkspaceId: workspaceId,
          entryKey: "settlement:one",
          kind: "WorkBlocked" as InboxEntry["kind"],
          summary: "blocked",
          admittedAt: "t1",
        };
        const before = yield* tx.transact(inbox.currentSequence(workspaceId));
        yield* tx.transact(inbox.admitUpsertSequenced(entry));
        const once = yield* tx.transact(inbox.currentSequence(workspaceId));
        yield* tx.transact(inbox.admitUpsertSequenced(entry));
        const replay = yield* tx.transact(inbox.currentSequence(workspaceId));
        yield* tx.transact(inbox.markConsumed(workspaceId, "settlement:one"));
        const afterConsume = yield* tx.transact(
          inbox.currentSequence(workspaceId),
        );
        yield* tx.transact(
          inbox.admitUpsertSequenced({
            ...entry,
            entryKey: "settlement:two",
            admittedAt: "t2",
          }),
        );
        const next = yield* tx.transact(inbox.currentSequence(workspaceId));
        return { before, once, replay, afterConsume, next };
      });
      const result = await Effect.runPromise(
        Effect.provide(program, appLayer(database.databaseFilename)),
      );
      expect(result).toEqual({
        before: 0,
        once: 1,
        replay: 1,
        afterConsume: 1,
        next: 2,
      });
    } finally {
      database.cleanup();
    }
  }, 120_000);
});
