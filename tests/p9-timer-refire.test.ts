import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  layer,
  P8_MIGRATIONS,
  runMigrations,
  SchedulerTimerStoreLive,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  Principal,
  ProjectId,
  parse,
  SessionId,
  type WakeReason,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  fireDueTimers,
  startupRecovery,
  sweepRecovery,
} from "../packages/execution-runtime/src/index.js";
import {
  ExecutionScheduler,
  type SchedulerDecision,
  type SchedulerTimer,
  SchedulerTimerStore,
} from "../packages/ports/src/index.js";
import { makeP7App, p7SeedProject, runP7 } from "./support/p7-app.js";
import { faultingTransactionP9 } from "./support/p9-fault-transaction.js";

const principal = parse(Principal)("user:gov");

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789c1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789c1");

const DUE_AT = "2000-01-01T00:00:00.000Z";
const NOT_DUE_AT = "2999-01-01T00:00:00.000Z";

interface SchedulerCall {
  readonly workspaceId: WorkspaceId;
  readonly wakeReason: WakeReason;
}

/** ExecutionScheduler stub: records `reevaluate` calls and decides Idle. */
const makeSchedulerStub = () => {
  const calls: SchedulerCall[] = [];
  const stub = Layer.succeed(
    ExecutionScheduler,
    ExecutionScheduler.of({
      reevaluate: (wsId, wakeReason) =>
        Effect.sync(() => {
          calls.push({ workspaceId: wsId, wakeReason });
          return { _tag: "Idle" } as SchedulerDecision;
        }),
      registerWorkWait: () => Effect.void,
      clearWorkWait: () => Effect.void,
      scheduleTimer: () => Effect.void,
      dueTimers: () => Effect.succeed([]),
    }),
  );
  return { calls, stub };
};

const makeTimerApp = () => {
  const base = makeP7App();
  const scheduler = makeSchedulerStub();
  const timers = Layer.provide(SchedulerTimerStoreLive, base);
  return {
    calls: scheduler.calls,
    app: Layer.mergeAll(base, timers, scheduler.stub),
  };
};

const INSERT_TIMER = (timerId: string, fireAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO scheduler_timers (timer_id, workspace_id, work_id, kind, fire_at, created_at) VALUES (?,?,NULL,'TimeReached',?,'t')",
      [timerId, workspaceId, fireAt],
    );
  });

const timerRows = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ timer_id: string }>(
      "SELECT timer_id FROM scheduler_timers ORDER BY timer_id",
    );
    return rows.map((row) => row.timer_id);
  });

const seedBaseWorkspace = Effect.gen(function* () {
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

describe("P9-005 durable timer re-drive (fire + clear one tx, D4)", () => {
  it("sweep fires the due timer (row cleared + workspace reevaluate with Recovery reason) and leaves the not-yet-due row intact (D4)", async () => {
    const { calls, app } = makeTimerApp();
    await runP7(
      Effect.gen(function* () {
        yield* runMigrations(P8_MIGRATIONS);
        yield* p7SeedProject;
        yield* INSERT_TIMER("tmr_p9_due", DUE_AT);
        yield* INSERT_TIMER("tmr_p9_future", NOT_DUE_AT);
        const pass = yield* sweepRecovery(principal);
        expect(pass.firedTimers.map((t: SchedulerTimer) => t.timerId)).toEqual([
          "tmr_p9_due",
        ]);
        expect(yield* timerRows()).toEqual(["tmr_p9_future"]);
        expect(calls).toEqual([
          { workspaceId, wakeReason: { _tag: "Recovery" } },
        ]);
      }),
      app,
    );
  });

  it("repeated sweep is idempotent: the cleared timer never re-fires and no duplicate wake is recorded", async () => {
    const { calls, app } = makeTimerApp();
    await runP7(
      Effect.gen(function* () {
        yield* runMigrations(P8_MIGRATIONS);
        yield* p7SeedProject;
        yield* INSERT_TIMER("tmr_p9_due", DUE_AT);
        yield* INSERT_TIMER("tmr_p9_future", NOT_DUE_AT);
        yield* sweepRecovery(principal);
        const second = yield* sweepRecovery(principal);
        expect(second.firedTimers).toEqual([]);
        expect(yield* timerRows()).toEqual(["tmr_p9_future"]);
        expect(calls.length).toBe(1);
      }),
      app,
    );
  });

  it("fire+clear share one transaction: a COMMIT-failure injection leaves the row intact (no lost timer) and the next sweep re-fires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p9-timer-"));
    const filename = join(dir, "timers.db");
    const first = makeSchedulerStub();
    const faultBase = layer({ filename });
    const faulting = Layer.mergeAll(
      faultBase,
      ClockLive,
      Layer.provide(faultingTransactionP9("fail-on-commit", 1), faultBase),
      Layer.provide(SchedulerTimerStoreLive, faultBase),
      first.stub,
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* runMigrations(P8_MIGRATIONS);
            yield* seedBaseWorkspace;
            yield* INSERT_TIMER("tmr_p9_atomic", DUE_AT);
            // Kill before COMMIT: the fire transaction rolls back — the row
            // survives and no wake was enqueued (P2 `05` §6 no-lost-timer).
            const exit = yield* Effect.exit(fireDueTimers);
            expect(Exit.isFailure(exit)).toBe(true);
            expect(yield* timerRows()).toEqual(["tmr_p9_atomic"]);
            expect(first.calls.length).toBe(0);
          }),
          faulting,
        ),
      ),
    );
    // Next sweep (healthy transaction port, same durable DB) re-fires once.
    const second = makeSchedulerStub();
    const cleanBase = layer({ filename });
    const healthy = Layer.mergeAll(
      cleanBase,
      ClockLive,
      Layer.provide(TransactionPortLive, cleanBase),
      Layer.provide(SchedulerTimerStoreLive, cleanBase),
      second.stub,
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const fired = yield* fireDueTimers;
            expect(fired.map((t: SchedulerTimer) => t.timerId)).toEqual([
              "tmr_p9_atomic",
            ]);
            expect(yield* timerRows()).toEqual([]);
            expect(second.calls).toEqual([
              { workspaceId, wakeReason: { _tag: "Recovery" } },
            ]);
          }),
          healthy,
        ),
      ),
    );
  });

  it("startupRecovery (T1) also drives due timers after the nine-step pass", async () => {
    const { calls, app } = makeTimerApp();
    await runP7(
      Effect.gen(function* () {
        yield* runMigrations(P8_MIGRATIONS);
        yield* p7SeedProject;
        yield* INSERT_TIMER("tmr_p9_t1", DUE_AT);
        const pass = yield* startupRecovery(principal);
        expect(pass.firedTimers.map((t: SchedulerTimer) => t.timerId)).toEqual([
          "tmr_p9_t1",
        ]);
        expect(yield* timerRows()).toEqual([]);
        expect(calls.length).toBe(1);
      }),
      app,
    );
  });
});
