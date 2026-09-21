import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  P7_MIGRATIONS,
  runMigrations,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { DependencyAwareRunnableWorkSourceLive } from "../apps/single-workspace/src/runnable-source-p7.js";
import {
  CommandId,
  type DeliverableKind,
  DependencyId,
  declareDependency,
  parse,
  WorkId,
  WorkspaceId,
  workspaceBound,
} from "../packages/domain/dist/index.js";
import {
  DependencyRepository,
  RunnableWorkSource,
  type SchedulerDecision,
  TransactionPort,
} from "../packages/ports/src/index.js";
import {
  makeP7App,
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  runP7,
} from "./support/p7-app.js";

const WORK_WAIT_ONLY = parse(WorkId)(
  "wrk_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const WORK_BLOCKED = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a2");
const WORK_DEP_ONLY = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a3");
const WORK_CLEAN = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a4");
const CMD_WAIT_ONLY = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d1",
);
const CMD_BLOCKED = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d2",
);
const CMD_DEP_ONLY = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789d3",
);
const CMD_CLEAN = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789d4");
const DEP_BLOCKED = parse(DependencyId)(
  "dep_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const DEP_UNREFERENCED = parse(DependencyId)(
  "dep_018f2b3c-4d5e-7abc-8def-0123456789a2",
);
const otherWorkspace = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789f1",
);

const makeClassificationApp = () => {
  const base = makeP7App();
  const waits = Layer.provide(WorkWaitStoreLive, base);
  return Layer.mergeAll(
    base,
    waits,
    Layer.provide(
      DependencyAwareRunnableWorkSourceLive,
      Layer.mergeAll(base, waits),
    ),
  );
};

const seedWork = (workId: WorkId, commandId: CommandId) =>
  Effect.gen(function* () {
    const receipt = yield* p7SeedWork(workId, commandId);
    expect(receipt.resolution._tag).toBe("Committed");
  });

const seedWorks = (
  entries: ReadonlyArray<readonly [WorkId, CommandId]>,
): Effect.Effect<void, unknown, never> =>
  Effect.gen(function* () {
    yield* runMigrations(P7_MIGRATIONS);
    yield* p7SeedProject;
    for (const [workId, commandId] of entries) {
      yield* seedWork(workId, commandId);
    }
  }) as Effect.Effect<void, unknown, never>;

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

const insertDependency = (
  dependencyId: DependencyId,
  consumerWorkId: WorkId,
): Effect.Effect<
  void,
  unknown,
  SqlClient | TransactionPort | DependencyRepository
> =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const deps = yield* DependencyRepository;
    yield* tx.transact(
      deps.insert(
        declareDependency({
          dependencyId,
          consumerWorkId,
          producerBinding: workspaceBound(otherWorkspace),
          revision: 0 as never,
          expectedDeliverable: {
            kind: "report" as never as DeliverableKind,
            requiredArtifactRoles: ["summary" as never],
          },
        }),
        p7Project,
      ),
    );
  });

const setCurrentWork = (
  workId: WorkId | null,
): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "UPDATE workspaces SET current_work_id = ? WHERE workspace_id = ?",
      [workId, p7RootWorkspace],
    );
  });

const classifyRoot: Effect.Effect<
  { current: Option.Option<WorkId>; runnable: ReadonlyArray<WorkId> },
  unknown,
  RunnableWorkSource
> = Effect.gen(function* () {
  const source = yield* RunnableWorkSource;
  return yield* source.classify(p7RootWorkspace);
});

/** §8.18A decision derivation over G3 classify outputs: current = Some ⇒
 * ¬waiting (row 1 → Admit current); current = None absorbs waiting-current
 * rows 2–4, so the runnable count alone decides (rows 5–7). */
const decideFromTable = (
  current: Option.Option<WorkId>,
  runnable: ReadonlyArray<WorkId>,
): SchedulerDecision =>
  Option.isSome(current)
    ? { _tag: "Admit", focus: { _tag: "Work", workId: current.value } }
    : runnable.length === 0
      ? { _tag: "Idle" }
      : runnable.length === 1
        ? { _tag: "SelectCurrentWork", workId: runnable[0] as WorkId }
        : { _tag: "Admit", focus: { _tag: "Coordination" } };

describe("P7-008 dependency-aware classification (03 §2/§3)", () => {
  it("wait × dependency matrix: waiting and blocked works leave runnable; unreferenced Unsatisfied stays runnable", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seedWorks([
          [WORK_WAIT_ONLY, CMD_WAIT_ONLY],
          [WORK_BLOCKED, CMD_BLOCKED],
          [WORK_DEP_ONLY, CMD_DEP_ONLY],
          [WORK_CLEAN, CMD_CLEAN],
        ]);
        yield* insertWait(WORK_WAIT_ONLY, [
          { _tag: "TimeReached", instant: "2099-01-01T00:00:00.000Z" },
        ]);
        yield* insertDependency(DEP_BLOCKED, WORK_BLOCKED);
        yield* insertWait(WORK_BLOCKED, [
          {
            _tag: "DependencyChanged",
            dependencyId: DEP_BLOCKED,
            observedRevision: 0,
          },
        ]);
        yield* insertDependency(DEP_UNREFERENCED, WORK_DEP_ONLY);
        const classified = yield* classifyRoot;
        expect(classified.current).toEqual(Option.none());
        expect([...classified.runnable]).toEqual([WORK_DEP_ONLY, WORK_CLEAN]);
        expect(
          decideFromTable(classified.current, classified.runnable),
        ).toEqual({ _tag: "Admit", focus: { _tag: "Coordination" } });
      }),
      makeClassificationApp(),
    );
  });

  it("blocked current resolves to None and decide() falls through to SelectCurrentWork (§8.18A row 3)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seedWorks([
          [WORK_BLOCKED, CMD_BLOCKED],
          [WORK_CLEAN, CMD_CLEAN],
        ]);
        yield* insertDependency(DEP_BLOCKED, WORK_BLOCKED);
        yield* insertWait(WORK_BLOCKED, [
          {
            _tag: "DependencyChanged",
            dependencyId: DEP_BLOCKED,
            observedRevision: 0,
          },
        ]);
        yield* setCurrentWork(WORK_BLOCKED);
        const classified = yield* classifyRoot;
        expect(classified.current).toEqual(Option.none());
        expect([...classified.runnable]).toEqual([WORK_CLEAN]);
        expect(
          decideFromTable(classified.current, classified.runnable),
        ).toEqual({ _tag: "SelectCurrentWork", workId: WORK_CLEAN });
      }),
      makeClassificationApp(),
    );
  });

  it("waiting current with no other runnable decides Idle — no model call path (§8.18A row 2, SD No.20)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seedWorks([[WORK_WAIT_ONLY, CMD_WAIT_ONLY]]);
        yield* insertWait(WORK_WAIT_ONLY, [
          { _tag: "TimeReached", instant: "2099-01-01T00:00:00.000Z" },
        ]);
        yield* setCurrentWork(WORK_WAIT_ONLY);
        const classified = yield* classifyRoot;
        expect(classified.current).toEqual(Option.none());
        expect([...classified.runnable]).toEqual([]);
        expect(
          decideFromTable(classified.current, classified.runnable),
        ).toEqual({ _tag: "Idle" });
      }),
      makeClassificationApp(),
    );
  });

  it("clean current is Some and decides Admit(current) (§8.18A row 1)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seedWorks([[WORK_CLEAN, CMD_CLEAN]]);
        yield* setCurrentWork(WORK_CLEAN);
        const classified = yield* classifyRoot;
        expect(classified.current).toEqual(Option.some(WORK_CLEAN));
        expect([...classified.runnable]).toEqual([]);
        expect(
          decideFromTable(classified.current, classified.runnable),
        ).toEqual({
          _tag: "Admit",
          focus: { _tag: "Work", workId: WORK_CLEAN },
        });
      }),
      makeClassificationApp(),
    );
  });
});
