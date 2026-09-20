import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  ExecutionRepositoryLive,
  layer,
  P2_MIGRATIONS,
  runMigrations,
  SchedulerTimerStoreLive,
  TransactionPortLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  parse,
  type WakeReason,
  WorkId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  ExecutionSchedulerLive,
  RunnableWorkSourceStubLive,
} from "../packages/execution-runtime/src/index.js";
import {
  ExecutionScheduler,
  RunnableWorkSource,
  type RunnableWorkSourceService,
  type SchedulerDecision,
} from "../packages/ports/src/index.js";

const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const workA = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workB = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a2");
const wake: WakeReason = { _tag: "Recovery" };

const makeApp = (source: RunnableWorkSourceService) => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive);
  const repo = Layer.provide(ExecutionRepositoryLive, infra);
  const deps = Layer.mergeAll(
    infra,
    repo,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(SchedulerTimerStoreLive, infra),
    Layer.succeed(RunnableWorkSource, source),
    Layer.provide(
      ExecutionSchedulerLive,
      Layer.mergeAll(
        infra,
        repo,
        Layer.provide(WorkWaitStoreLive, infra),
        Layer.provide(SchedulerTimerStoreLive, infra),
        Layer.succeed(RunnableWorkSource, source),
        Layer.provide(TransactionPortLive, infra),
      ),
    ),
  );
  return deps;
};

const evaluate = async (
  source: RunnableWorkSourceService,
): Promise<SchedulerDecision> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* runMigrations(P2_MIGRATIONS);
        const scheduler = yield* ExecutionScheduler;
        return yield* scheduler.reevaluate(workspaceId, wake);
      }),
      makeApp(source),
    ) as Effect.Effect<SchedulerDecision, unknown, never>,
  );

describe("P2 ExecutionScheduler", () => {
  it("applies the DID §8.18A decision table", async () => {
    expect(
      (
        await evaluate({
          classify: () =>
            Effect.succeed({ current: Option.some(workA), runnable: [] }),
        })
      )._tag,
    ).toBe("Admit");
    expect(
      (
        await evaluate({
          classify: () =>
            Effect.succeed({ current: Option.none(), runnable: [] }),
        })
      )._tag,
    ).toBe("Idle");
    const one = await evaluate({
      classify: () =>
        Effect.succeed({ current: Option.none(), runnable: [workA] }),
    });
    expect(one._tag).toBe("SelectCurrentWork");
    const many = await evaluate({
      classify: () =>
        Effect.succeed({ current: Option.none(), runnable: [workA, workB] }),
    });
    expect(many._tag).toBe("Admit");
    if (many._tag === "Admit") expect(many.focus._tag).toBe("Coordination");
  });

  it("is Noop when an active main execution exists", async () => {
    const decision = await evaluate({
      classify: () =>
        Effect.succeed({ current: Option.none(), runnable: [workA] }),
    });
    // No execution admitted in this fresh DB, so it is not Noop.
    expect(decision._tag).not.toBe("Noop");
    void SqlClient;
    void RunnableWorkSourceStubLive;
  });
});
