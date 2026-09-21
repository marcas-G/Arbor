import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P7_MIGRATIONS,
  runMigrations,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { buildSliceLayer } from "../apps/single-workspace/src/index.js";
import {
  consumeWakeSignals,
  deliverWakeSignal,
  type WakeSinkDependencies,
} from "../packages/application/src/wake-sink.js";
import {
  CommandId,
  DependencyId,
  parse,
  type WakeReason,
  WorkId,
  type WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  ExecutionScheduler,
  type SchedulerDecision,
  TransactionPort,
  WorkRepository,
  WorkWaitStore,
} from "../packages/ports/src/index.js";
import {
  makeP7App,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  runP7,
} from "./support/p7-app.js";

const WORK_CONSUMER = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789b1");
const CMD_CONSUMER = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789b1",
);
const WORK_OTHER = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789b2");
const CMD_OTHER = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789b2");
const DEP = parse(DependencyId)("dep_018f2b3c-4d5e-7abc-8def-0123456789b1");
const DEP_OTHER = parse(DependencyId)(
  "dep_018f2b3c-4d5e-7abc-8def-0123456789b2",
);

interface SchedulerCall {
  readonly workspaceId: WorkspaceId;
  readonly wakeReason: WakeReason;
}

/** ExecutionScheduler stub: reevaluate is recorded and decides Idle; no
 * other member is exercised by the sink (deps only pick `reevaluate`). */
const makeSchedulerStub = () => {
  const calls: SchedulerCall[] = [];
  const layer = Layer.succeed(
    ExecutionScheduler,
    ExecutionScheduler.of({
      reevaluate: (workspaceId, wakeReason) =>
        Effect.sync(() => {
          calls.push({ workspaceId, wakeReason });
          return { _tag: "Idle" } as SchedulerDecision;
        }),
      registerWorkWait: () => Effect.void,
      clearWorkWait: () => Effect.void,
      scheduleTimer: () => Effect.void,
      dueTimers: () => Effect.succeed([]),
    }),
  );
  return { calls, layer };
};

const makeWakeApp = () => {
  const scheduler = makeSchedulerStub();
  const base = makeP7App();
  return {
    calls: scheduler.calls,
    app: Layer.mergeAll(
      base,
      Layer.provide(WorkWaitStoreLive, base),
      scheduler.layer,
    ),
  };
};

const makeSinkDeps = Effect.gen(function* () {
  return {
    tx: yield* TransactionPort,
    waits: yield* WorkWaitStore,
    works: yield* WorkRepository,
    scheduler: yield* ExecutionScheduler,
  } satisfies WakeSinkDependencies;
});

const insertWait = (
  workId: WorkId,
  conditions: ReadonlyArray<unknown>,
): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO work_waits (work_id, wait_mode, conditions_json, registered_at, updated_at) VALUES (?,?,?,?,?)",
      [workId, "Any", JSON.stringify(conditions), "t", "t"],
    );
  });

const seedWakeFixture = Effect.gen(function* () {
  yield* runMigrations(P7_MIGRATIONS);
  yield* p7SeedProject;
  for (const [workId, commandId] of [
    [WORK_CONSUMER, CMD_CONSUMER],
    [WORK_OTHER, CMD_OTHER],
  ] as const) {
    const receipt = yield* p7SeedWork(workId, commandId);
    expect(receipt.resolution._tag).toBe("Committed");
  }
}) as Effect.Effect<void, unknown, never>;

const waitOf = (deps: WakeSinkDependencies, workId: WorkId) =>
  deps.tx.transact(deps.waits.findByWork(workId));

describe("p7-wake-pipeline (P7-011, 06 §2/§3)", () => {
  it("DependencySatisfied clears only the advanced DependencyChanged wait and reevaluates the target workspace", async () => {
    const { calls, app } = makeWakeApp();
    await runP7(
      Effect.gen(function* () {
        yield* seedWakeFixture;
        yield* insertWait(WORK_CONSUMER, [
          {
            _tag: "DependencyChanged",
            dependencyId: DEP,
            observedRevision: 0,
          },
        ]);
        yield* insertWait(WORK_OTHER, [
          {
            _tag: "DependencyChanged",
            dependencyId: DEP_OTHER,
            observedRevision: 0,
          },
        ]);
        const deps = yield* makeSinkDeps;
        const outcome = yield* deliverWakeSignal(
          {
            workspaceId: p7RootWorkspace,
            reason: "DependencySatisfied",
            detail: { dependencyId: DEP, fromRevision: 0, toRevision: 1 },
          },
          deps,
        );
        expect(outcome).toEqual({ woke: true, clearedWaits: 1 });
        expect(yield* waitOf(deps, WORK_CONSUMER)).toEqual(Option.none());
        // A wait on another dependency is not this signal's business.
        expect(Option.isSome(yield* waitOf(deps, WORK_OTHER))).toBe(true);
        expect(calls).toEqual([
          {
            workspaceId: p7RootWorkspace,
            wakeReason: { _tag: "DependencySatisfied" },
          },
        ]);
      }),
      app,
    );
  });

  it("observedRevision already at/after toRevision clears nothing (already seen); reevaluate still fires at-least-once", async () => {
    const { calls, app } = makeWakeApp();
    await runP7(
      Effect.gen(function* () {
        yield* seedWakeFixture;
        yield* insertWait(WORK_CONSUMER, [
          {
            _tag: "DependencyChanged",
            dependencyId: DEP,
            observedRevision: 2,
          },
        ]);
        const deps = yield* makeSinkDeps;
        const outcome = yield* deliverWakeSignal(
          {
            workspaceId: p7RootWorkspace,
            reason: "DependencySatisfied",
            detail: { dependencyId: DEP, fromRevision: 0, toRevision: 1 },
          },
          deps,
        );
        expect(outcome).toEqual({ woke: false, clearedWaits: 0 });
        expect(Option.isSome(yield* waitOf(deps, WORK_CONSUMER))).toBe(true);
        expect(calls.length).toBe(1);
      }),
      app,
    );
  });

  it("ChildDelivered reevaluates with its WakeReason and never clears waits", async () => {
    const { calls, app } = makeWakeApp();
    await runP7(
      Effect.gen(function* () {
        yield* seedWakeFixture;
        yield* insertWait(WORK_CONSUMER, [
          {
            _tag: "DependencyChanged",
            dependencyId: DEP,
            observedRevision: 0,
          },
        ]);
        const deps = yield* makeSinkDeps;
        const outcome = yield* deliverWakeSignal(
          {
            workspaceId: p7RootWorkspace,
            reason: "ChildDelivered",
            detail: {
              deliverableId: "dlv_018f2b3c-4d5e-7abc-8def-0123456789b1",
              messageId: "msg_018f2b3c-4d5e-7abc-8def-0123456789b1",
            },
          },
          deps,
        );
        expect(outcome).toEqual({ woke: false, clearedWaits: 0 });
        expect(Option.isSome(yield* waitOf(deps, WORK_CONSUMER))).toBe(true);
        expect(calls).toEqual([
          {
            workspaceId: p7RootWorkspace,
            wakeReason: { _tag: "ChildDelivered" },
          },
        ]);
      }),
      app,
    );
  });

  it("replaying the same signal is an idempotent no-op clear; the duplicate reevaluate is harmless", async () => {
    const { calls, app } = makeWakeApp();
    await runP7(
      Effect.gen(function* () {
        yield* seedWakeFixture;
        yield* insertWait(WORK_CONSUMER, [
          {
            _tag: "DependencyChanged",
            dependencyId: DEP,
            observedRevision: 0,
          },
        ]);
        const deps = yield* makeSinkDeps;
        const signal = {
          workspaceId: p7RootWorkspace,
          reason: "DependencySatisfied" as const,
          detail: { dependencyId: DEP, fromRevision: 0, toRevision: 1 },
        };
        const first = yield* deliverWakeSignal(signal, deps);
        expect(first).toEqual({ woke: true, clearedWaits: 1 });
        const replay = yield* deliverWakeSignal(signal, deps);
        expect(replay).toEqual({ woke: false, clearedWaits: 0 });
        expect(yield* waitOf(deps, WORK_CONSUMER)).toEqual(Option.none());
        expect(calls.length).toBe(2);
      }),
      app,
    );
  });

  it("consumeWakeSignals delivers sequentially and aggregates outcomes", async () => {
    const { calls, app } = makeWakeApp();
    await runP7(
      Effect.gen(function* () {
        yield* seedWakeFixture;
        yield* insertWait(WORK_CONSUMER, [
          {
            _tag: "DependencyChanged",
            dependencyId: DEP,
            observedRevision: 0,
          },
        ]);
        const deps = yield* makeSinkDeps;
        const outcomes = yield* consumeWakeSignals(
          [
            {
              workspaceId: p7RootWorkspace,
              reason: "DependencySatisfied",
              detail: { dependencyId: DEP, fromRevision: 0, toRevision: 1 },
            },
            { workspaceId: p7RootWorkspace, reason: "ChildDelivered" },
          ],
          deps,
        );
        expect(outcomes).toEqual([
          { woke: true, clearedWaits: 1 },
          { woke: false, clearedWaits: 0 },
        ]);
        expect(calls.map((call) => call.wakeReason._tag)).toEqual([
          "DependencySatisfied",
          "ChildDelivered",
        ]);
      }),
      app,
    );
  });

  it("composition smoke: buildSliceLayer builds and migrates a durable DB to v7 (P7_MIGRATIONS)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p7-wake-"));
    const app = buildSliceLayer({ databaseFile: join(dir, "slice.db") });
    const version = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P7_MIGRATIONS);
          yield* ExecutionScheduler;
          const sql = yield* SqlClient;
          const rows = yield* sql.unsafe<{ user_version: number }>(
            "PRAGMA user_version",
          );
          return Number(rows[0]?.user_version);
        }),
        app,
      ) as Effect.Effect<number, unknown, never>,
    );
    expect(version).toBe(7);
  });
});
