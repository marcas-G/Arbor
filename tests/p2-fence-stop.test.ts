import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  ExecutionRepositoryLive,
  layer,
  P12_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  FenceStopCheck,
  type StopAdmission,
} from "../packages/application/src/index.js";
import {
  type CommandSubmissionContext,
  type Execution,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import { FenceStopCheckLive } from "../packages/execution-runtime/src/index.js";
import {
  Clock,
  ExecutionRepository,
  TransactionPort,
} from "../packages/ports/src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
) as ExecutionId;
const principal = parse(Principal)("worker:a");

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive);
  const repo = Layer.provide(ExecutionRepositoryLive, infra);
  const tx = Layer.provide(TransactionPortLive, infra);
  const fence = Layer.provide(FenceStopCheckLive, Layer.merge(infra, repo));
  return Layer.mergeAll(infra, repo, tx, fence);
};

const execution = (): Execution => ({
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

const context = (generation: number): CommandSubmissionContext => ({
  _tag: "ExecutionOrigin",
  principal,
  executionId,
  fencingGeneration: generation as never,
});

const NORMAL: StopAdmission = { _tag: "NormalExecutionMutation" };
const QUIESCENCE: StopAdmission = { _tag: "QuiescenceControlMutation" };
const STOP: StopAdmission = { _tag: "StopControl" };

const check = (generation: number, admission: StopAdmission) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const fence = yield* FenceStopCheck;
    return yield* tx.transact(fence.check(context(generation), admission));
  });

describe("P2 FenceStopCheck", () => {
  it("rejects an invalid or missing fence", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P12_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const repo = yield* ExecutionRepository;
      const clock = yield* Clock;
      yield* tx.transact(repo.tryAdmitMainExecution(execution()));
      const noLease = yield* check(0, NORMAL);
      yield* tx.transact(
        repo.tryAcquireLease(
          executionId,
          "worker:a",
          "inc-a",
          "2000-01-01T00:00:00.000Z",
        ),
      );
      const wrongGen = yield* check(99, NORMAL);
      const expired = yield* check(0, NORMAL);
      return { noLease, wrongGen, expired };
    });
    const r = await Effect.runPromise(Effect.provide(program, app));
    expect(r.noLease).toBe("FencingRejected");
    expect(r.wrongGen).toBe("FencingRejected");
    expect(r.expired).toBe("FencingRejected");
  });

  it("distinguishes stop admission by the StopAdmission ADT", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P12_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const repo = yield* ExecutionRepository;
      const clock = yield* Clock;
      yield* tx.transact(repo.tryAdmitMainExecution(execution()));
      const now = yield* clock.now();
      yield* tx.transact(
        repo.tryAcquireLease(
          executionId,
          "worker:a",
          "inc-a",
          new Date(Date.parse(now) + 60_000).toISOString(),
        ),
      );
      const beforeStop = yield* check(0, NORMAL);
      yield* tx.transact(repo.requestStop(executionId, now));
      const normal = yield* check(0, NORMAL);
      const quiescence = yield* check(0, QUIESCENCE);
      const stopControl = yield* check(0, STOP);
      return { beforeStop, normal, quiescence, stopControl };
    });
    const r = await Effect.runPromise(Effect.provide(program, app));
    expect(r.beforeStop).toBe("Pass");
    expect(r.normal).toBe("ExecutionStopping");
    expect(r.quiescence).toBe("Pass");
    expect(r.stopControl).toBe("Pass");
  });

  it("rejects a settled execution and passes non-Execution origins", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P12_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const repo = yield* ExecutionRepository;
      const clock = yield* Clock;
      const fence = yield* FenceStopCheck;
      yield* tx.transact(repo.tryAdmitMainExecution(execution()));
      const now = yield* clock.now();
      yield* tx.transact(
        repo.tryAcquireLease(
          executionId,
          "worker:a",
          "inc-a",
          new Date(Date.parse(now) + 60_000).toISOString(),
        ),
      );
      yield* tx.transact(
        repo.settle(
          executionId,
          { _tag: "Completed", result: { _tag: "CoordinationCompleted" } },
          now,
        ),
      );
      const settled = yield* check(0, NORMAL);
      const external = yield* tx.transact(
        fence.check({ _tag: "External", principal }, NORMAL),
      );
      return { settled, external };
    });
    const r = await Effect.runPromise(Effect.provide(program, app));
    expect(r.settled).toBe("FencingRejected");
    expect(r.external).toBe("Pass");
  });
});
