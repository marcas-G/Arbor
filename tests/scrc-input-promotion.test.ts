import { Effect, Layer, Result } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  ExecutionRepositoryLive,
  InboxProjectionStoreLive,
  layer,
  P19_MIGRATIONS,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  InputPromotionService,
  InputPromotionServiceLive,
} from "../packages/application/src/index.js";
import {
  type Execution,
  ExecutionId,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  ExecutionRepository,
  InboxProjectionStore,
  TransactionPort,
} from "../packages/ports/src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789c1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789c1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789c1",
) as ExecutionId;

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive);
  const tx = Layer.provide(TransactionPortLive, infra);
  const executions = Layer.provide(ExecutionRepositoryLive, infra);
  const sessions = Layer.provide(SessionRepositoryLive, infra);
  const inbox = Layer.provide(InboxProjectionStoreLive, infra);
  const dependencies = Layer.mergeAll(infra, tx, executions, sessions, inbox);
  return Layer.mergeAll(
    dependencies,
    Layer.provide(InputPromotionServiceLive, dependencies),
  );
};

const execution: Execution = {
  executionId,
  projectId,
  workspaceId,
  binding: {
    _tag: "WorkspaceExecution",
    workspaceId,
    focus: { _tag: "Coordination" },
  },
  sessionId,
  admittedAt: "t",
  stopRequestedAt: null,
  state: { status: "Active", settlement: null },
};

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
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
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,NULL,0,?)",
        [sessionId, "WorkspacePrimary", workspaceId, "t"],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)",
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
    }),
  );
  const tx = yield* TransactionPort;
  const executions = yield* ExecutionRepository;
  const inbox = yield* InboxProjectionStore;
  yield* tx.transact(executions.tryAdmitMainExecution(execution));
  yield* tx.transact(
    executions.tryAcquireLease(
      executionId,
      "worker:scrc",
      "inc:scrc",
      "2999-01-01T00:00:00.000Z",
    ),
  );
  yield* tx.transact(
    inbox.admitUpsert({
      recipientWorkspaceId: workspaceId,
      entryKey: "msg:one",
      kind: "Message",
      summary: "parent report",
      admittedAt: "t",
    }),
  );
});

const request = {
  workspaceId,
  entryKey: "msg:one",
  targetSessionId: sessionId,
  delivery: "Queue" as const,
  fence: {
    executionId,
    workerId: "worker:scrc",
    workerIncarnationId: "inc:scrc",
    fencingGeneration: 0 as never,
  },
};

describe("SCRC durable input promotion", () => {
  it("promotes one Inbox source exactly once and consumes it atomically", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P19_MIGRATIONS);
      yield* seed;
      const promotions = yield* InputPromotionService;
      const first = yield* promotions.promoteInbox(request);
      const replay = yield* promotions.promoteInbox(request);
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM session_entries WHERE item_type = 'UserMessage' AND source_kind = 'InboxEntry' AND source_ref = 'msg:one'",
      );
      const inbox = yield* sql.unsafe<{ consumed_at: string | null }>(
        "SELECT consumed_at FROM inbox_entries WHERE workspace_id = ? AND entry_key = ?",
        [workspaceId, "msg:one"],
      );
      return { first, replay, count: Number(rows[0]?.count), inbox };
    });
    const result = await Effect.runPromise(Effect.provide(program, makeApp()));
    expect(result.first).toEqual({ sequence: 0, inserted: true });
    expect(result.replay).toEqual({ sequence: 0, inserted: false });
    expect(result.count).toBe(1);
    expect(result.inbox[0]?.consumed_at).not.toBeNull();
  });

  it("rolls back Session append when Inbox consumption fails, then retries cleanly", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P19_MIGRATIONS);
      yield* seed;
      const sql = yield* SqlClient;
      yield* sql.unsafe(`
        CREATE TRIGGER scrc_fail_consume
        BEFORE UPDATE OF consumed_at ON inbox_entries
        BEGIN
          SELECT RAISE(ABORT, 'fault-before-inbox-consume');
        END
      `);
      const promotions = yield* InputPromotionService;
      const failed = yield* Effect.result(promotions.promoteInbox(request));
      const afterFailure = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM session_entries WHERE item_type = 'UserMessage'",
      );
      yield* sql.unsafe("DROP TRIGGER scrc_fail_consume");
      const retry = yield* promotions.promoteInbox(request);
      return { failed, afterFailure, retry };
    });
    const result = await Effect.runPromise(Effect.provide(program, makeApp()));
    expect(Result.isFailure(result.failed)).toBe(true);
    expect(Number(result.afterFailure[0]?.count)).toBe(0);
    expect(result.retry).toEqual({ sequence: 0, inserted: true });
  });
});
