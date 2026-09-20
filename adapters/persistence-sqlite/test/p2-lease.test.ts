import {
  type Execution,
  ExecutionId,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  ExecutionRepository,
  LeaseService,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  ExecutionRepositoryLive,
  LeaseServiceLive,
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
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
) as ExecutionId;

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

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive);
  const deps = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
    Layer.provide(
      LeaseServiceLive,
      Layer.merge(infra, Layer.provide(ExecutionRepositoryLive, infra)),
    ),
  );
  return Layer.mergeAll(infra, deps);
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

describe("P2 LeaseService", () => {
  it("acquires, softly releases, and keeps the generation monotonic", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P2_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const repo = yield* ExecutionRepository;
      const leases = yield* LeaseService;
      const clock = yield* Clock;
      yield* tx.transact(repo.tryAdmitMainExecution(execution));

      const first = yield* tx.transact(leases.acquire(executionId, "worker-a"));
      const blocked = yield* tx
        .transact(leases.acquire(executionId, "worker-b"))
        .pipe(Effect.flip);
      const staleRenew = yield* tx
        .transact(leases.renew(executionId, "worker-a", 99 as never))
        .pipe(Effect.flip);
      yield* tx.transact(
        leases.release(executionId, "worker-a", first.generation),
      );
      const reacquired = yield* tx.transact(
        leases.acquire(executionId, "worker-c"),
      );
      const now = yield* clock.now();
      const invalidated = yield* tx.transact(leases.invalidateExpired(now));
      const current = yield* tx.transact(repo.currentLease(executionId));
      return { first, blocked, staleRenew, reacquired, invalidated, current };
    });
    const r = await Effect.runPromise(Effect.provide(program, app));
    expect(r.first.generation).toBe(0);
    expect((r.blocked as { _tag: string })._tag).toBe("LeaseFencingRejected");
    expect((r.staleRenew as { _tag: string })._tag).toBe(
      "LeaseFencingRejected",
    );
    expect(r.reacquired.generation).toBe(1);
    expect(r.invalidated).toBe(0);
    expect(Option.isSome(r.current)).toBe(true);
  });

  it("counts expired active executions", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P2_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const repo = yield* ExecutionRepository;
      const leases = yield* LeaseService;
      yield* tx.transact(repo.tryAdmitMainExecution(execution));
      yield* tx.transact(
        repo.tryAcquireLease(
          executionId,
          "worker-a",
          "2000-01-01T00:00:00.000Z",
        ),
      );
      return yield* tx.transact(
        leases.invalidateExpired("2999-01-01T00:00:00.000Z"),
      );
    });
    const invalidated = await Effect.runPromise(Effect.provide(program, app));
    expect(invalidated).toBe(1);
  });
});
