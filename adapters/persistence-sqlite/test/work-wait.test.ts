import {
  ProjectId,
  parse,
  SessionId,
  type WaitSpec,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import {
  SchedulerTimerStore,
  TransactionPort,
  WorkWaitStore,
} from "@arbor/ports";
import { it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vitest";
import {
  layer,
  P2_MIGRATIONS,
  runMigrations,
  SchedulerTimerStoreLive,
  TransactionPortLive,
  WorkWaitStoreLive,
} from "../src/index.js";
import { seedWorkspaceGraph } from "./support/seed-workspace.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a1");

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base);
  return Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(SchedulerTimerStoreLive, infra),
  );
};

const seed = Effect.gen(function* () {
  yield* seedWorkspaceGraph({ projectId, workspaceId, sessionId });
  const sql = yield* SqlClient;
  yield* sql.unsafe(
    "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
});

const waitSpec: WaitSpec = {
  mode: "Any",
  conditions: [{ _tag: "TimeReached", instant: "2999-01-01T00:00:00.000Z" }],
};

describe("WorkWaitStore + SchedulerTimerStore", () => {
  it.effect("upserts, reads, and clears WorkWait", () =>
    Effect.gen(function* () {
      const app = makeApp();
      const program = Effect.gen(function* () {
        yield* runMigrations(P2_MIGRATIONS);
        yield* seed;
        const tx = yield* TransactionPort;
        const store = yield* WorkWaitStore;
        yield* tx.transact(
          store.upsert({ workId, waitSpec, registeredAt: "t", updatedAt: "t" }),
        );
        const found = yield* tx.transact(store.findByWork(workId));
        const active = yield* tx.transact(store.listActive());
        yield* tx.transact(store.clear(workId));
        const cleared = yield* tx.transact(store.findByWork(workId));
        return { found, active, cleared };
      });
      const r = yield* Effect.provide(program, app);
      expect(Option.isSome(r.found)).toBe(true);
      expect(r.active).toHaveLength(1);
      expect(Option.isNone(r.cleared)).toBe(true);
    }),
  );

  it.effect("rejects an empty WaitSpec as a defect", () =>
    Effect.gen(function* () {
      const app = makeApp();
      const program = Effect.gen(function* () {
        yield* runMigrations(P2_MIGRATIONS);
        yield* seed;
        const tx = yield* TransactionPort;
        const store = yield* WorkWaitStore;
        return yield* tx
          .transact(
            store.upsert({
              workId,
              waitSpec: { mode: "Any", conditions: [] },
              registeredAt: "t",
              updatedAt: "t",
            }),
          )
          .pipe(Effect.exit);
      });
      const exit = yield* Effect.provide(program, app);
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("schedules, lists due, and cancels timers", () =>
    Effect.gen(function* () {
      const app = makeApp();
      const program = Effect.gen(function* () {
        yield* runMigrations(P2_MIGRATIONS);
        yield* seed;
        const tx = yield* TransactionPort;
        const store = yield* SchedulerTimerStore;
        yield* tx.transact(
          store.schedule({
            timerId: "tmr_1",
            workspaceId,
            workId,
            kind: "TimeReached",
            fireAt: "2000-01-01T00:00:00.000Z",
            createdAt: "t",
          }),
        );
        const due = yield* tx.transact(store.due("2999-01-01T00:00:00.000Z"));
        yield* tx.transact(store.cancel("tmr_1"));
        const after = yield* tx.transact(store.due("2999-01-01T00:00:00.000Z"));
        return { due, after };
      });
      const r = yield* Effect.provide(program, app);
      expect(r.due.map((timer) => timer.timerId)).toEqual(["tmr_1"]);
      expect(r.after).toHaveLength(0);
    }),
  );
});
