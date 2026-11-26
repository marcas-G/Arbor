import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";
import {
  P7_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  buildWaitGraph,
  type ClassifyOutputForGate,
  detectDeadlock,
  evaluateDeadlock,
  hasDeadlock,
  type WaitGraphWait,
  type WaitGraphWork,
} from "../../packages/application/src/wait-graph.js";
import {
  type Dependency,
  type DependencyId,
  type DependencyLifecycle,
  type ProducerBinding,
  parse,
  type WorkId,
  type WorkLifecycle,
  WorkRevision,
  type WorkspaceId,
  workBound,
  workspaceBound,
} from "../../packages/domain/dist/index.js";
import {
  DependencyRepository,
  DomainEventJournal,
  type PendingDomainEvent,
  RunnableWorkSource,
  TransactionPort,
  WorkRepository,
  WorkWaitStore,
} from "../../packages/ports/src/index.js";
import { p7Project, p7SeedProject } from "../support/p7-app.js";
import {
  cmd,
  DEP_E1,
  DEP_E2,
  dep,
  expectedOf,
  makeStoryApp,
  NOW_E,
  REV,
  runStory,
  submitDeclare,
  submitWithdraw,
  WORK_E1,
  WORK_E2,
  wrk,
  ws,
} from "./support.js";
import {
  countEvents,
  depChanged,
  insertWait,
  seedWorks,
} from "./support-store.js";

// --- Story E fixtures (assertions stand alone in this file) ---

const WS_EA = ws("00e101");
const WS_EB = ws("00e102");
const WS_EC = ws("00e103");
const WE1 = wrk("00e111");
const WE2 = wrk("00e112");
const WE3 = wrk("00e113");
const WE9 = wrk("00e119");
const ED1 = dep("00e121");
const ED2 = dep("00e122");

const pureDep = (
  dependencyId: DependencyId,
  consumerWorkId: WorkId,
  producerBinding: ProducerBinding,
  state: DependencyLifecycle = "Unsatisfied",
): Dependency => ({
  dependencyId,
  consumerWorkId,
  producerBinding,
  revision: REV(0),
  expectedDeliverable: expectedOf("report", ["summary"]),
  state,
  satisfiedByDeliverableId: null,
  satisfiedAtDependencyRevision: null,
});

const pureWork = (
  workId: WorkId,
  workspaceId: WorkspaceId,
  lifecycle: WorkLifecycle = "Open",
): WaitGraphWork => ({ workId, workspaceId, lifecycle });

const waitOn = (
  workId: WorkId,
  ...dependencyIds: DependencyId[]
): WaitGraphWait => ({
  workId,
  conditions: dependencyIds.map(depChanged),
  active: true,
});

const idle = (workspaceId: WorkspaceId): ClassifyOutputForGate => ({
  workspaceId,
  current: Option.none(),
  runnable: [],
});

const allIdle = (...workspaces: WorkspaceId[]) =>
  workspaces.map((workspaceId) => idle(workspaceId));

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
};

const evaluateOverDb = (now: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const works = yield* WorkRepository;
    const dependencies = yield* DependencyRepository;
    const waits = yield* WorkWaitStore;
    const source = yield* RunnableWorkSource;
    return yield* evaluateDeadlock(
      {
        projectId: p7Project,
        listWorkspaceIds: () =>
          Effect.gen(function* () {
            const rows = yield* sql.unsafe<{
              readonly workspace_id: WorkspaceId;
            }>(
              "SELECT workspace_id FROM workspaces WHERE project_id = ? ORDER BY workspace_id",
              [p7Project],
            );
            return rows.map((row) => row.workspace_id);
          }).pipe(
            Effect.mapError((cause) => ({
              _tag: "WaitGraphReadFailure" as const,
              cause,
            })),
          ),
        works,
        dependencies,
        waits,
        classify: source.classify,
      },
      now,
    );
  });

const snapshotCanonical = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const works = yield* sql.unsafe("SELECT * FROM works ORDER BY work_id");
  const dependencies = yield* sql.unsafe(
    "SELECT * FROM dependencies ORDER BY dependency_id",
  );
  const workWaits = yield* sql.unsafe(
    "SELECT * FROM work_waits ORDER BY work_id",
  );
  return { works, dependencies, workWaits };
});

const appendToJournal = (events: ReadonlyArray<PendingDomainEvent>) =>
  Effect.gen(function* () {
    const journal = yield* DomainEventJournal;
    const tx = yield* TransactionPort;
    yield* tx.transact(journal.append(events));
  });

export const storyESecondWorkCompletesMutualCycle = async (): Promise<void> => {
  const { app } = makeStoryApp();
  await runStory(
    app,
    Effect.gen(function* () {
      yield* runMigrations(P7_MIGRATIONS);
      yield* p7SeedProject;
      yield* seedWorks([
        [WORK_E1, cmd("89e0000000e1")],
        [WORK_E2, cmd("89e0000000e2")],
      ]);
      const declaredFirst = yield* submitDeclare(cmd("89e0000000e3"), {
        dependencyId: DEP_E1,
        consumerWorkId: WORK_E1,
        producerBinding: workBound(WORK_E2),
        expectedDeliverable: expectedOf("report", ["summary"]),
        expectedConsumerWorkRevision: parse(WorkRevision)(0),
        revision: REV(0),
      });
      expect(declaredFirst.resolution._tag).toBe("Committed");
      const declaredSecond = yield* submitDeclare(cmd("89e0000000e4"), {
        dependencyId: DEP_E2,
        consumerWorkId: WORK_E2,
        producerBinding: workBound(WORK_E1),
        expectedDeliverable: expectedOf("report", ["summary"]),
        expectedConsumerWorkRevision: parse(WorkRevision)(0),
        revision: REV(0),
      });
      expect(declaredSecond.resolution._tag).toBe("Committed");

      yield* insertWait(WORK_E1, [depChanged(DEP_E1)]);
      const firstCheck = yield* evaluateOverDb(NOW_E);
      expect(Option.isNone(firstCheck)).toBe(true);

      yield* insertWait(WORK_E2, [depChanged(DEP_E2)]);
      const before = yield* snapshotCanonical;
      const detected = yield* evaluateOverDb(NOW_E);
      expect(Option.isSome(detected)).toBe(true);
      if (Option.isSome(detected)) {
        const { fact, event } = detected.value;
        expect([...fact.cycleWorkIds]).toEqual([WORK_E1, WORK_E2]);
        expect([...fact.dependencyIds]).toEqual([DEP_E1, DEP_E2]);
        expect(event.eventType).toBe("DeadlockAttentionRequested");
        expect(event.aggregateRef).toBe(`deadlock:${WORK_E1}+${WORK_E2}`);
        expect(event.payload).toEqual({
          _tag: "DeadlockAttentionRequested",
          cycleWorkIds: [WORK_E1, WORK_E2],
          dependencyIds: [DEP_E1, DEP_E2],
          detectedAt: NOW_E,
        });
        yield* appendToJournal([event]);
      }
      const afterDetect = yield* snapshotCanonical;
      expect(afterDetect).toEqual(before);
      expect(yield* countEvents("DeadlockAttentionRequested")).toBe(1);

      const withdrawn = yield* submitWithdraw(cmd("89e0000000e5"), {
        dependencyId: DEP_E1,
        targetDependencyRevision: REV(0),
        reason: "resolve the mutual wait",
      });
      expect(withdrawn.resolution._tag).toBe("Committed");
      const rechecked = yield* evaluateOverDb(NOW_E);
      expect(Option.isNone(rechecked)).toBe(true);
      expect(yield* countEvents("DeadlockAttentionRequested")).toBe(1);
    }),
  );
};

export const storyEDetectionZeroMutation = (): void => {
  const works = deepFreeze([pureWork(WE1, WS_EA), pureWork(WE2, WS_EA)]);
  const waits = deepFreeze([waitOn(WE1, ED1), waitOn(WE2, ED2)]);
  const dependencies = deepFreeze([
    pureDep(ED1, WE1, workBound(WE2)),
    pureDep(ED2, WE2, workBound(WE1)),
  ]);
  const before = JSON.stringify({ works, waits, dependencies });
  const graph = buildWaitGraph({ works, waits, dependencies });
  const fact = detectDeadlock(graph, {
    classifyOutputs: allIdle(WS_EA),
    now: NOW_E,
  });
  expect(fact).not.toBeNull();
  expect(JSON.stringify({ works, waits, dependencies })).toBe(before);
};

export const storyEWithdrawBreaksCycle = (): void => {
  const graph = buildWaitGraph({
    works: [pureWork(WE1, WS_EA), pureWork(WE2, WS_EA)],
    waits: [waitOn(WE1, ED1), waitOn(WE2, ED2)],
    dependencies: [
      pureDep(ED1, WE1, workBound(WE2)),
      pureDep(ED2, WE2, workBound(WE1), "Withdrawn"),
    ],
  });
  expect(
    detectDeadlock(graph, { classifyOutputs: allIdle(WS_EA), now: NOW_E }),
  ).toBeNull();
  expect(hasDeadlock(graph, allIdle(WS_EA))).toBe(false);
};

export const storyEWorkspaceBoundDegeneration = (): void => {
  const degenerate = buildWaitGraph({
    works: [pureWork(WE1, WS_EA), pureWork(WE2, WS_EB)],
    waits: [waitOn(WE1, ED1), waitOn(WE2, ED2)],
    dependencies: [
      pureDep(ED1, WE1, workspaceBound(WS_EB)),
      pureDep(ED2, WE2, workspaceBound(WS_EA)),
    ],
  });
  expect(
    detectDeadlock(degenerate, {
      classifyOutputs: allIdle(WS_EA, WS_EB),
      now: NOW_E,
    }),
  ).toEqual({
    cycleWorkIds: [WE1, WE2],
    dependencyIds: [ED1, ED2],
    detectedAt: NOW_E,
  });

  const orOpen = buildWaitGraph({
    works: [
      pureWork(WE1, WS_EA),
      pureWork(WE3, WS_EA),
      pureWork(WE2, WS_EB),
      pureWork(WE9, WS_EB),
    ],
    waits: [waitOn(WE1, ED1), waitOn(WE2, ED2)],
    dependencies: [
      pureDep(ED1, WE1, workspaceBound(WS_EB)),
      pureDep(ED2, WE2, workspaceBound(WS_EA)),
    ],
  });
  expect(
    detectDeadlock(orOpen, {
      classifyOutputs: allIdle(WS_EA, WS_EB),
      now: NOW_E,
    }),
  ).toBeNull();

  const vacant = buildWaitGraph({
    works: [pureWork(WE1, WS_EA)],
    waits: [waitOn(WE1, ED1)],
    dependencies: [pureDep(ED1, WE1, workspaceBound(WS_EC))],
  });
  expect(
    detectDeadlock(vacant, {
      classifyOutputs: allIdle(WS_EA, WS_EC),
      now: NOW_E,
    }),
  ).toBeNull();
};

export const storyEEligibleSetLifecycle = (): void => {
  const dependencies = [
    pureDep(ED1, WE1, workspaceBound(WS_EB)),
    pureDep(ED2, WE2, workBound(WE1)),
  ];
  const waits = [waitOn(WE1, ED1), waitOn(WE2, ED2)];
  const gate = allIdle(WS_EA, WS_EB);

  const vacant = buildWaitGraph({
    works: [pureWork(WE1, WS_EA)],
    waits,
    dependencies,
  });
  expect(
    detectDeadlock(vacant, { classifyOutputs: gate, now: NOW_E }),
  ).toBeNull();

  const one = buildWaitGraph({
    works: [pureWork(WE1, WS_EA), pureWork(WE2, WS_EB)],
    waits,
    dependencies,
  });
  expect(detectDeadlock(one, { classifyOutputs: gate, now: NOW_E })).toEqual({
    cycleWorkIds: [WE1, WE2],
    dependencyIds: [ED1, ED2],
    detectedAt: NOW_E,
  });

  const two = buildWaitGraph({
    works: [pureWork(WE1, WS_EA), pureWork(WE2, WS_EB), pureWork(WE3, WS_EB)],
    waits,
    dependencies,
  });
  expect(detectDeadlock(two, { classifyOutputs: gate, now: NOW_E })).toBeNull();

  const producerCancelled = buildWaitGraph({
    works: [pureWork(WE1, WS_EA), pureWork(WE2, WS_EB, "Cancelled")],
    waits,
    dependencies,
  });
  expect(
    detectDeadlock(producerCancelled, { classifyOutputs: gate, now: NOW_E }),
  ).toBeNull();

  const producerCompleted = buildWaitGraph({
    works: [pureWork(WE1, WS_EA), pureWork(WE2, WS_EB, "Completed")],
    waits,
    dependencies,
  });
  expect(
    detectDeadlock(producerCompleted, { classifyOutputs: gate, now: NOW_E }),
  ).toBeNull();
};

export const storyEGhostEdge = (): void => {
  const graph = buildWaitGraph({
    works: [pureWork(WE1, WS_EA), pureWork(WE2, WS_EA)],
    waits: [waitOn(WE1, ED1), waitOn(WE2, ED2)],
    dependencies: [
      pureDep(ED1, WE1, workBound(WE2), "Satisfied"),
      pureDep(ED2, WE2, workBound(WE1)),
    ],
  });
  expect(
    detectDeadlock(graph, { classifyOutputs: allIdle(WS_EA), now: NOW_E }),
  ).toBeNull();
};
