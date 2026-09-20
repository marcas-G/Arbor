import {
  type AgentExecutionState,
  type Execution,
  ExecutionId,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import {
  AgentExecutionStateStore,
  ExecutionRepository,
  SessionRepository,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AgentExecutionStateStoreLive,
  ClockLive,
  ExecutionRepositoryLive,
  layer,
  P2_MIGRATIONS,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
) as ExecutionId;

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive);
  return Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(AgentExecutionStateStoreLive, infra),
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
  stopRequested: false,
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
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,NULL,?,?)",
        [sessionId, "WorkspacePrimary", workspaceId, 0, "t"],
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
});

describe("P2 Session appendEntry + AgentExecutionState", () => {
  it("allocates contiguous Session-local sequences", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P2_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const sessions = yield* SessionRepository;
      const a = yield* tx.transact(
        sessions.appendEntry(sessionId, {
          entryKind: "Input",
          payload: { a: 1 },
        }),
      );
      const b = yield* tx.transact(
        sessions.appendEntry(sessionId, {
          entryKind: "ModelOutput",
          payload: { b: 2 },
        }),
      );
      const c = yield* tx.transact(
        sessions.appendEntry(sessionId, {
          entryKind: "Observation",
          payload: { c: 3 },
        }),
      );
      return { a, b, c };
    });
    const r = await Effect.runPromise(Effect.provide(program, app));
    expect([r.a.sequence, r.b.sequence, r.c.sequence]).toEqual([0, 1, 2]);
  });

  it("rejects a fenced append with a stale generation without writing", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P2_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const repo = yield* ExecutionRepository;
      const sessions = yield* SessionRepository;
      yield* tx.transact(repo.tryAdmitMainExecution(execution));
      yield* tx.transact(
        repo.tryAcquireLease(
          executionId,
          "worker:a",
          "2999-01-01T00:00:00.000Z",
        ),
      );
      const ok = yield* tx.transact(
        sessions.appendEntry(
          sessionId,
          { entryKind: "Input", payload: {} },
          { executionId, fencingGeneration: 0 as never },
        ),
      );
      const stale = yield* tx
        .transact(
          sessions.appendEntry(
            sessionId,
            { entryKind: "Input", payload: {} },
            { executionId, fencingGeneration: 9 as never },
          ),
        )
        .pipe(Effect.flip);
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM session_entries",
      );
      return { ok, stale, count: Number(rows[0]?.count ?? 0) };
    });
    const r = await Effect.runPromise(Effect.provide(program, app));
    expect(r.ok.sequence).toBe(0);
    expect((r.stale as { _tag: string })._tag).toBe("LeaseFencingRejected");
    expect(r.count).toBe(1);
  });

  it("round-trips AgentExecutionState", async () => {
    const app = makeApp();
    const state: AgentExecutionState = {
      executionId,
      focus: { _tag: "Coordination" },
      wakeReason: { _tag: "Recovery" },
      currentMode: "execute",
      activeSkillRefs: ["skill-a"],
      turnNo: 3,
      recentDirectiveRefs: ["d1"],
      recentActionFingerprints: ["fp1"],
      updatedAt: "t2",
    };
    const program = Effect.gen(function* () {
      yield* runMigrations(P2_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const repo = yield* ExecutionRepository;
      const store = yield* AgentExecutionStateStore;
      yield* tx.transact(repo.tryAdmitMainExecution(execution));
      yield* tx.transact(store.upsert(state));
      return yield* tx.transact(store.find(executionId));
    });
    const loaded = await Effect.runPromise(Effect.provide(program, app));
    expect(Option.isSome(loaded)).toBe(true);
    if (Option.isSome(loaded)) {
      expect(loaded.value).toEqual(state);
    }
  });
});
