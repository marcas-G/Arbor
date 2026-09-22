import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P8_MIGRATIONS,
  runMigrations,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  consumeConclusionSignals,
  deliverVerificationWake,
  type VerificationConclusion,
  type VerificationWakeDependencies,
} from "../packages/application/src/verification-wake.js";
import {
  CommandId,
  parse,
  VerificationId,
  type VerificationVerdict,
  type WakeReason,
  WorkId,
  WorkRevision,
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

const WORK_TARGET = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789c1");
const WORK_WAITER = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789c2");
const WORK_WAITER2 = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789c3");
const WORK_OTHER = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789c4");
const CMD_TARGET = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789d1");
const CMD_WAITER = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789d2");
const CMD_WAITER2 = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d3",
);
const VER_1 = parse(VerificationId)("ver_018f2b3c-4d5e-7abc-8def-0123456789c1");

interface SchedulerCall {
  readonly workspaceId: WorkspaceId;
  readonly wakeReason: WakeReason;
}

/** ExecutionScheduler stub (P7 wake-pipeline precedent): reevaluate is
 * recorded and decides Idle. */
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

const makeWakeDeps = Effect.gen(function* () {
  return {
    tx: yield* TransactionPort,
    waits: yield* WorkWaitStore,
    works: yield* WorkRepository,
    scheduler: yield* ExecutionScheduler,
  } satisfies VerificationWakeDependencies;
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

const waitOf = (workId: WorkId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const waits = yield* WorkWaitStore;
    return yield* tx.transact(waits.findByWork(workId));
  });

const seedFixture = Effect.gen(function* () {
  yield* runMigrations(P8_MIGRATIONS);
  yield* p7SeedProject;
  for (const [workId, commandId] of [
    [WORK_TARGET, CMD_TARGET],
    [WORK_WAITER, CMD_WAITER],
    [WORK_WAITER2, CMD_WAITER2],
  ] as const) {
    const receipt = yield* p7SeedWork(workId, commandId);
    expect(receipt.resolution._tag).toBe("Committed");
  }
}) as Effect.Effect<void, unknown, never>;

/** M-1 new shape (v1.11 G2 work-level): workId + targetWorkRevision. */
const newShape = (workId: WorkId, targetWorkRevision: number) => ({
  _tag: "VerificationChanged",
  workId,
  targetWorkRevision,
});

/** M-1 pre-migration persisted shape: keyed by verificationId — a type
 * the WakeCondition union no longer carries; workId is absent. */
const oldShape = {
  _tag: "VerificationChanged",
  verificationId: VER_1,
  observedRevision: 0,
};

const conclude = (verdict: VerificationVerdict): VerificationConclusion => ({
  workId: WORK_TARGET,
  targetWorkRevision: parse(WorkRevision)(0),
  verdict,
  verificationId: VER_1,
  ownerWorkspaceId: p7RootWorkspace,
});

describe("p8-wake-channels (P8-009, 03 §3 dual-channel wake)", () => {
  it("Pass releases the matching VerificationChanged wait (channel 1) and never routes channel 2", async () => {
    const { calls, app } = makeWakeApp();
    await runP7(
      Effect.gen(function* () {
        yield* seedFixture;
        yield* insertWait(WORK_WAITER, [newShape(WORK_TARGET, 0)]);
        const deps = yield* makeWakeDeps;
        const outcome = yield* deliverVerificationWake(conclude("Pass"), deps);
        expect(outcome).toEqual({ releasedWaits: 1, routed: false });
        expect(yield* waitOf(WORK_WAITER)).toEqual(Option.none());
        // PASS never fires channel 2 (Acceptance is Parent cognition).
        expect(calls).toEqual([]);
      }),
      app,
    );
  });

  it.each(["Fail", "Unknown"])(
    "%s releases channel 1 and routes VerificationReturned to the owner workspace (channel 2)",
    async (verdict) => {
      const { calls, app } = makeWakeApp();
      await runP7(
        Effect.gen(function* () {
          yield* seedFixture;
          yield* insertWait(WORK_WAITER, [newShape(WORK_TARGET, 0)]);
          const deps = yield* makeWakeDeps;
          const outcome = yield* deliverVerificationWake(
            conclude(verdict as VerificationVerdict),
            deps,
          );
          expect(outcome).toEqual({ releasedWaits: 1, routed: true });
          expect(yield* waitOf(WORK_WAITER)).toEqual(Option.none());
          expect(calls).toEqual([
            {
              workspaceId: p7RootWorkspace,
              wakeReason: { _tag: "VerificationReturned" },
            },
          ]);
        }),
        app,
      );
    },
  );

  it("exact equality: mismatched targetWorkRevision and mismatched workId never release", async () => {
    const { calls, app } = makeWakeApp();
    await runP7(
      Effect.gen(function* () {
        yield* seedFixture;
        // Conclusion is WORK_TARGET @ revision 0 — neither wait expresses
        // that exact (workId, targetWorkRevision) fact.
        yield* insertWait(WORK_WAITER, [newShape(WORK_TARGET, 1)]);
        yield* insertWait(WORK_WAITER2, [newShape(WORK_OTHER, 0)]);
        const deps = yield* makeWakeDeps;
        const outcome = yield* deliverVerificationWake(conclude("Fail"), deps);
        expect(outcome).toEqual({ releasedWaits: 0, routed: true });
        expect(Option.isSome(yield* waitOf(WORK_WAITER))).toBe(true);
        expect(Option.isSome(yield* waitOf(WORK_WAITER2))).toBe(true);
        // Channel 2 is at-least-once independent of channel-1 matching.
        expect(calls.length).toBe(1);
      }),
      app,
    );
  });

  it("persisted pre-M-1 old-shape conditions do not match (migration semantics as-is); the new shape beside them does", async () => {
    const { calls, app } = makeWakeApp();
    await runP7(
      Effect.gen(function* () {
        yield* seedFixture;
        yield* insertWait(WORK_WAITER, [oldShape]);
        yield* insertWait(WORK_WAITER2, [newShape(WORK_TARGET, 0)]);
        const deps = yield* makeWakeDeps;
        const outcome = yield* deliverVerificationWake(conclude("Fail"), deps);
        expect(outcome).toEqual({ releasedWaits: 1, routed: true });
        // The old row keeps its wait: no workId field → never equal.
        expect(Option.isSome(yield* waitOf(WORK_WAITER))).toBe(true);
        expect(yield* waitOf(WORK_WAITER2)).toEqual(Option.none());
        expect(calls.length).toBe(1);
      }),
      app,
    );
  });

  it("replaying the same conclusion is an idempotent no-op release; the repeated reevaluate is harmless", async () => {
    const { calls, app } = makeWakeApp();
    await runP7(
      Effect.gen(function* () {
        yield* seedFixture;
        yield* insertWait(WORK_WAITER, [newShape(WORK_TARGET, 0)]);
        const deps = yield* makeWakeDeps;
        const first = yield* deliverVerificationWake(conclude("Fail"), deps);
        expect(first).toEqual({ releasedWaits: 1, routed: true });
        // Replay: the clear is a DELETE no-op (releasedWaits 0); the
        // duplicate reevaluate re-derives the same decision (SD No.53).
        const replay = yield* deliverVerificationWake(conclude("Fail"), deps);
        expect(replay).toEqual({ releasedWaits: 0, routed: true });
        expect(yield* waitOf(WORK_WAITER)).toEqual(Option.none());
        expect(calls.length).toBe(2);
      }),
      app,
    );
  });

  it("consumeConclusionSignals delivers a batch sequentially and aggregates outcomes", async () => {
    const { calls, app } = makeWakeApp();
    await runP7(
      Effect.gen(function* () {
        yield* seedFixture;
        yield* insertWait(WORK_WAITER, [newShape(WORK_TARGET, 0)]);
        const deps = yield* makeWakeDeps;
        const outcomes = yield* consumeConclusionSignals(
          [conclude("Fail"), { ...conclude("Pass"), workId: WORK_OTHER }],
          deps,
        );
        expect(outcomes).toEqual([
          { releasedWaits: 1, routed: true },
          { releasedWaits: 0, routed: false },
        ]);
        expect(yield* waitOf(WORK_WAITER)).toEqual(Option.none());
        expect(calls.map((call) => call.wakeReason._tag)).toEqual([
          "VerificationReturned",
        ]);
      }),
      app,
    );
  });
});
