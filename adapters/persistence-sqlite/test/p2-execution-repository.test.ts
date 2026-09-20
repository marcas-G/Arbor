import {
  type Execution,
  ExecutionId,
  type ExecutionSettlement,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import { Clock, ExecutionRepository, TransactionPort } from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  ExecutionRepositoryLive,
  layer,
  P2_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive);
  const deps = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
  );
  return Layer.mergeAll(infra, deps);
};

const exeId = (id: string): ExecutionId =>
  parse(ExecutionId)(id) as ExecutionId;

const mainExecution = (id: string): Execution => ({
  executionId: exeId(id),
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
});

const boundExecution = (id: string): Execution => ({
  executionId: exeId(id),
  projectId,
  workspaceId,
  binding: {
    _tag: "ExecutionBoundAgentBinding",
    parentExecutionId: exeId("exe_018f2b3c-4d5e-7abc-8def-0123456789a1"),
    mission: "m",
  },
  sessionId,
  admittedAt: "t",
  stopRequestedAt: null,
  state: { status: "Active", settlement: null },
});

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

describe("P2 ExecutionRepository", () => {
  it("admits one active main; allows ExecutionBound concurrently", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P2_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const repo = yield* ExecutionRepository;
      const first = yield* tx.transact(
        repo.tryAdmitMainExecution(
          mainExecution("exe_018f2b3c-4d5e-7abc-8def-0123456789a1"),
        ),
      );
      const second = yield* tx.transact(
        repo.tryAdmitMainExecution(
          mainExecution("exe_018f2b3c-4d5e-7abc-8def-0123456789a2"),
        ),
      );
      yield* tx.transact(
        repo.admitExecution(
          boundExecution("exe_018f2b3c-4d5e-7abc-8def-0123456789b1"),
        ),
      );
      yield* tx.transact(
        repo.admitExecution(
          boundExecution("exe_018f2b3c-4d5e-7abc-8def-0123456789b2"),
        ),
      );
      return { first, second };
    });
    const { first, second } = await Effect.runPromise(
      Effect.provide(program, app),
    );
    expect(Option.isSome(first)).toBe(true);
    expect(Option.isNone(second)).toBe(true);
  });

  it("settles once and reports the settlement", async () => {
    const app = makeApp();
    const settlement: ExecutionSettlement = {
      _tag: "Completed",
      result: { _tag: "CoordinationCompleted" },
    };
    const program = Effect.gen(function* () {
      yield* runMigrations(P2_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const repo = yield* ExecutionRepository;
      const id = exeId("exe_018f2b3c-4d5e-7abc-8def-0123456789a1");
      yield* tx.transact(repo.tryAdmitMainExecution(mainExecution(id)));
      yield* tx.transact(repo.settle(id, settlement, "t1"));
      yield* tx.transact(
        repo.settle(
          id,
          { _tag: "Interrupted", result: { _tag: "StopRequested" } },
          "t2",
        ),
      );
      return yield* tx.transact(repo.findById(id));
    });
    const loaded = await Effect.runPromise(Effect.provide(program, app));
    expect(Option.isSome(loaded)).toBe(true);
    if (Option.isSome(loaded)) {
      expect(loaded.value.state.status).toBe("Settled");
      if (loaded.value.state.status === "Settled") {
        expect(loaded.value.state.settlement._tag).toBe("Completed");
      }
    }
  });

  it("runs the lease CAS lifecycle with monotonic generations", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P2_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const repo = yield* ExecutionRepository;
      const clock = yield* Clock;
      const id = exeId("exe_018f2b3c-4d5e-7abc-8def-0123456789a1");
      yield* tx.transact(repo.tryAdmitMainExecution(mainExecution(id)));
      const first = yield* tx.transact(
        repo.tryAcquireLease(id, "worker-a", "2999-01-01T00:00:00.000Z"),
      );
      const live = yield* tx.transact(
        repo.tryAcquireLease(id, "worker-b", "2999-01-01T00:00:00.000Z"),
      );
      const staleRenew = yield* tx.transact(
        repo.renewLease(
          id,
          "worker-a",
          99 as never,
          "2999-01-01T00:00:00.000Z",
        ),
      );
      yield* tx.transact(repo.releaseLease(id, "worker-a", 0 as never));
      const reacquired = yield* tx.transact(
        repo.tryAcquireLease(id, "worker-c", "2999-01-01T00:00:00.000Z"),
      );
      yield* tx.transact(repo.releaseLease(id, "worker-c", 1 as never));
      const expired = yield* tx.transact(
        repo.tryAcquireLease(id, "worker-d", "2000-01-01T00:00:00.000Z"),
      );
      const now = yield* clock.now();
      const expiredActive = yield* tx.transact(
        repo.findExpiredActiveExecutions("2999-12-31T00:00:00.000Z"),
      );
      const unsettled = yield* tx.transact(repo.findUnsettledExecutions());
      return {
        first,
        live,
        staleRenew,
        reacquired,
        expired,
        now,
        expiredActive,
        unsettled,
      };
    });
    const r = await Effect.runPromise(Effect.provide(program, app));
    expect(Option.isSome(r.first)).toBe(true);
    if (Option.isSome(r.first)) expect(r.first.value.generation).toBe(0);
    expect(Option.isNone(r.live)).toBe(true);
    expect(Option.isNone(r.staleRenew)).toBe(true);
    expect(Option.isSome(r.reacquired)).toBe(true);
    if (Option.isSome(r.reacquired)) {
      expect(r.reacquired.value.generation).toBe(1);
    }
    expect(Option.isSome(r.expired)).toBe(true);
    expect(r.expiredActive.length).toBeGreaterThanOrEqual(1);
    expect(r.unsettled.length).toBe(1);
    expect(typeof r.now).toBe("string");
  });
});
