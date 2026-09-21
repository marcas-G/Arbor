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
  buildWaitGraph,
  type ClassifyOutputForGate,
  conservativeDetector,
  DEADLOCK_RECHECK_TRIGGERS,
  type DeadlockDetector,
  detectDeadlock,
  evaluateDeadlock,
  hasDeadlock,
  type ParticipatingEdge,
  type WaitGraphReadError,
  type WaitGraphWait,
  type WaitGraphWork,
} from "../packages/application/src/wait-graph.js";
import {
  CommandId,
  type DeliverableKind,
  type Dependency,
  DependencyId,
  type DependencyLifecycle,
  DependencyRevision,
  declareDependency,
  type ProducerBinding,
  parse,
  Revision,
  type WakeCondition,
  WorkId,
  type WorkLifecycle,
  WorkspaceId,
  withdrawDependency,
  workBound,
  workspaceBound,
} from "../packages/domain/dist/index.js";
import {
  DependencyRepository,
  RunnableWorkSource,
  TransactionPort,
  WorkRepository,
  WorkWaitStore,
} from "../packages/ports/src/index.js";
import {
  makeP7App,
  p7Project,
  p7SeedProject,
  p7SeedWork,
  runP7,
} from "./support/p7-app.js";

// --- pure-layer fixtures (no DB; ids sort deterministically) ---

const WS_A = parse(WorkspaceId)("ws_00000000-0000-7000-8000-000000000001");
const WS_B = parse(WorkspaceId)("ws_00000000-0000-7000-8000-000000000002");
const WS_C = parse(WorkspaceId)("ws_00000000-0000-7000-8000-000000000003");
const W1 = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000001");
const W2 = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000002");
const W3 = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000003");
const W4 = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000004");
const W9 = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000009");
const D = (n: number) =>
  parse(DependencyId)(`dep_00000000-0000-7000-8000-00000000000${n}`);
const D1 = D(1);
const D2 = D(2);
const D3 = D(3);
const D4 = D(4);
const D9 = D(9);
const NOW = "2026-09-21T00:00:00.000Z";

const KIND = "report" as never as DeliverableKind;
const ROLES = ["summary" as never];

const dep = (
  dependencyId: DependencyId,
  consumerWorkId: WorkId,
  producerBinding: ProducerBinding,
  state: DependencyLifecycle = "Unsatisfied",
): Dependency => ({
  dependencyId,
  consumerWorkId,
  producerBinding,
  revision: parse(DependencyRevision)(0),
  expectedDeliverable: { kind: KIND, requiredArtifactRoles: ROLES },
  state,
  satisfiedByDeliverableId: null,
  satisfiedAtDependencyRevision: null,
});

const work = (
  workId: WorkId,
  workspaceId: WorkspaceId,
  lifecycle: WorkLifecycle = "Open",
): WaitGraphWork => ({ workId, workspaceId, lifecycle });

const depChanged = (dependencyId: DependencyId): WakeCondition => ({
  _tag: "DependencyChanged",
  dependencyId,
  observedRevision: parse(Revision)(0),
});

const timeReached: WakeCondition = {
  _tag: "TimeReached",
  instant: "2099-01-01T00:00:00.000Z",
};

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

// --- integration fixtures (p7-classification seed pattern) ---

const W_INT1 = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789e1");
const W_INT2 = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789e2");
const CMD_INT1 = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789e1");
const CMD_INT2 = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789e2");
const DEP_INT1 = parse(DependencyId)(
  "dep_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
const DEP_INT2 = parse(DependencyId)(
  "dep_018f2b3c-4d5e-7abc-8def-0123456789e2",
);

const makeDeadlockApp = () => {
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

const insertWait = (workId: WorkId, conditions: ReadonlyArray<unknown>) =>
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
  producerBinding: ProducerBinding,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const dependencies = yield* DependencyRepository;
    yield* tx.transact(
      dependencies.insert(
        declareDependency({
          dependencyId,
          consumerWorkId,
          producerBinding,
          revision: parse(DependencyRevision)(0),
          expectedDeliverable: { kind: KIND, requiredArtifactRoles: ROLES },
        }),
        p7Project,
      ),
    );
  });

const withdrawSeeded = (dependencyId: DependencyId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const dependencies = yield* DependencyRepository;
    const found = yield* tx.transact(dependencies.findById(dependencyId));
    expect(Option.isSome(found)).toBe(true);
    if (Option.isNone(found)) {
      return;
    }
    const withdrawn = withdrawDependency(found.value);
    expect(withdrawn.ok).toBe(true);
    if (withdrawn.ok) {
      yield* tx.transact(
        dependencies.transitionIfUnsatisfiedRevision(
          dependencyId,
          found.value.revision,
          withdrawn.value,
        ),
      );
    }
  });

const snapshotCanonicalState = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const works = yield* sql.unsafe("SELECT * FROM works ORDER BY work_id");
  const dependencies = yield* sql.unsafe(
    "SELECT * FROM dependencies ORDER BY dependency_id",
  );
  const workWaits = yield* sql.unsafe(
    "SELECT * FROM work_waits ORDER BY work_id",
  );
  const events = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM domain_events",
  );
  return {
    works,
    dependencies,
    workWaits,
    eventCount: Number(events[0]?.count ?? 0),
  };
});

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
            const rows = yield* sql.unsafe<{ workspace_id: WorkspaceId }>(
              "SELECT workspace_id FROM workspaces WHERE project_id = ? ORDER BY workspace_id",
              [p7Project],
            );
            return rows.map((row) => row.workspace_id);
          }).pipe(
            Effect.mapError(
              (cause): WaitGraphReadError => ({
                _tag: "WaitGraphReadFailure",
                cause,
              }),
            ),
          ),
        works,
        dependencies,
        waits,
        classify: source.classify,
      },
      now,
    );
  });

const seedIntegrationCycle = Effect.gen(function* () {
  yield* runMigrations(P7_MIGRATIONS);
  yield* p7SeedProject;
  for (const [workId, commandId] of [
    [W_INT1, CMD_INT1],
    [W_INT2, CMD_INT2],
  ] as const) {
    const receipt = yield* p7SeedWork(workId, commandId);
    expect(receipt.resolution._tag).toBe("Committed");
  }
  yield* insertDependency(DEP_INT1, W_INT1, workBound(W_INT2));
  yield* insertDependency(DEP_INT2, W_INT2, workBound(W_INT1));
  yield* insertWait(W_INT1, [depChanged(DEP_INT1)]);
  yield* insertWait(W_INT2, [depChanged(DEP_INT2)]);
});

describe("p7-deadlock", () => {
  describe("wait-for graph construction (05 §1, 03 §3 valid-edge predicate)", () => {
    it("valid edge = Unsatisfied ∧ consumer Open ∧ active wait referencing the dependency; AnyProducer yields no edge", () => {
      const graph = buildWaitGraph({
        works: [work(W1, WS_A), work(W2, WS_A)],
        waits: [
          waitOn(W1, D1, D2),
          { workId: W2, conditions: [timeReached], active: true },
        ],
        dependencies: [
          dep(D1, W1, workBound(W2)), // full conjunct → edge
          dep(D2, W1, { _tag: "AnyProducer" }), // AnyProducer → no edge
          dep(D3, W2, workBound(W1)), // wait does not reference D3 → no edge
          dep(D4, W1, workBound(W2), "Satisfied"), // terminal → no edge
        ],
      });
      expect(graph.edges).toEqual([
        {
          consumerWorkId: W1,
          dependencyId: D1,
          target: { kind: "Work", workId: W2 },
          exclusion: null,
        },
      ]);
    });

    it("ghost edges: terminal dependency with uncleared consumer wait is not a valid edge (07 §5.7)", () => {
      const graph = buildWaitGraph({
        works: [work(W1, WS_A), work(W2, WS_A)],
        waits: [waitOn(W1, D1), waitOn(W2, D2)],
        dependencies: [
          dep(D1, W1, workBound(W2), "Satisfied"),
          dep(D2, W2, workBound(W1), "Withdrawn"),
        ],
      });
      expect(graph.edges).toEqual([]);
    });

    it("terminal consumer is not a node: Cancelled work emits no edge", () => {
      const graph = buildWaitGraph({
        works: [work(W1, WS_A, "Cancelled"), work(W2, WS_A)],
        waits: [waitOn(W1, D1)],
        dependencies: [dep(D1, W1, workBound(W2))],
      });
      expect(graph.edges).toEqual([]);
    });

    it("WorkspaceBound conservative degeneration: 1 candidate participates, 0 → VacantWorkspace, ≥2 → ChoiceNotDegenerate", () => {
      const graph = buildWaitGraph({
        works: [work(W1, WS_A), work(W2, WS_A), work(W4, WS_B), work(W9, WS_B)],
        waits: [waitOn(W1, D1), waitOn(W1, D2), waitOn(W1, D3)],
        dependencies: [
          dep(D1, W1, workspaceBound(WS_B)), // |Open(WS_B)| = 2
          dep(D2, W1, workspaceBound(WS_C)), // vacant
          dep(D3, W1, workspaceBound(WS_A)), // |Open(WS_A)| = 2
        ],
      });
      expect(graph.edges).toEqual([
        {
          consumerWorkId: W1,
          dependencyId: D1,
          target: { kind: "Choice", candidates: [W4, W9] },
          exclusion: "ChoiceNotDegenerate",
        },
        {
          consumerWorkId: W1,
          dependencyId: D2,
          target: { kind: "Choice", candidates: [] },
          exclusion: "VacantWorkspace",
        },
        {
          consumerWorkId: W1,
          dependencyId: D3,
          target: { kind: "Choice", candidates: [W1, W2] },
          exclusion: "ChoiceNotDegenerate",
        },
      ]);
    });
  });

  describe("detectDeadlock (05 §2, 07 §5 Story E)", () => {
    it("E.1: mutual WorkBound wait cycle + Project 全称 Idle → fact with cycle members and dependency list", () => {
      const graph = buildWaitGraph({
        works: [work(W1, WS_A), work(W2, WS_A)],
        waits: [waitOn(W1, D1), waitOn(W2, D2)],
        dependencies: [dep(D1, W1, workBound(W2)), dep(D2, W2, workBound(W1))],
      });
      const fact = detectDeadlock(graph, {
        classifyOutputs: allIdle(WS_A, WS_B),
        now: NOW,
      });
      expect(fact).toEqual({
        cycleWorkIds: [W1, W2],
        dependencyIds: [D1, D2],
        detectedAt: NOW,
      });
    });

    it("E.1 declare-then-yield ordering: first WorkWait alone is no cycle; the second upsert completes it", () => {
      const works = [work(W1, WS_A), work(W2, WS_A)];
      const dependencies = [
        dep(D1, W1, workBound(W2)),
        dep(D2, W2, workBound(W1)),
      ];
      const firstOnly = buildWaitGraph({
        works,
        waits: [waitOn(W1, D1)],
        dependencies,
      });
      expect(
        detectDeadlock(firstOnly, { classifyOutputs: allIdle(WS_A), now: NOW }),
      ).toBeNull();
      const both = buildWaitGraph({
        works,
        waits: [waitOn(W1, D1), waitOn(W2, D2)],
        dependencies,
      });
      expect(
        detectDeadlock(both, { classifyOutputs: allIdle(WS_A), now: NOW }),
      ).toEqual({
        cycleWorkIds: [W1, W2],
        dependencyIds: [D1, D2],
        detectedAt: NOW,
      });
    });

    it("E.2: zero mutation — detection leaves inputs byte-identical (frozen inputs, no throw)", () => {
      const works = deepFreeze([work(W1, WS_A), work(W2, WS_A)]);
      const waits = deepFreeze([waitOn(W1, D1), waitOn(W2, D2)]);
      const dependencies = deepFreeze([
        dep(D1, W1, workBound(W2)),
        dep(D2, W2, workBound(W1)),
      ]);
      const before = JSON.stringify({ works, waits, dependencies });
      const graph = buildWaitGraph({ works, waits, dependencies });
      const fact = detectDeadlock(graph, {
        classifyOutputs: allIdle(WS_A),
        now: NOW,
      });
      expect(fact).not.toBeNull();
      expect(JSON.stringify({ works, waits, dependencies })).toBe(before);
    });

    it("E.3: Withdraw breaks the cycle even with the consumer wait uncleared → hasDeadlock=false", () => {
      const graph = buildWaitGraph({
        works: [work(W1, WS_A), work(W2, WS_A)],
        waits: [waitOn(W1, D1), waitOn(W2, D2)], // wake-latency window: D2 wait stays
        dependencies: [
          dep(D1, W1, workBound(W2)),
          dep(D2, W2, workBound(W1), "Withdrawn"),
        ],
      });
      expect(
        detectDeadlock(graph, { classifyOutputs: allIdle(WS_A), now: NOW }),
      ).toBeNull();
      expect(hasDeadlock(graph, allIdle(WS_A))).toBe(false);
    });

    it("E.4: WorkspaceBound with exactly 1 candidate degenerates and participates; ≥2 declines (SCC false-positive counterexample); 0 declines (P7-GAP-01)", () => {
      // exactly one eligible producer on each side — degenerate edges form the cycle
      const degenerate = buildWaitGraph({
        works: [work(W1, WS_A), work(W2, WS_B)],
        waits: [waitOn(W1, D1), waitOn(W2, D2)],
        dependencies: [
          dep(D1, W1, workspaceBound(WS_B)),
          dep(D2, W2, workspaceBound(WS_A)),
        ],
      });
      expect(
        detectDeadlock(degenerate, {
          classifyOutputs: allIdle(WS_A, WS_B),
          now: NOW,
        }),
      ).toEqual({
        cycleWorkIds: [W1, W2],
        dependencyIds: [D1, D2],
        detectedAt: NOW,
      });

      // ≥2 eligible producers per side: naive fan-out SCC would report a
      // cycle — OR selectivity means it is not a hard deadlock → no fact
      const orOpen = buildWaitGraph({
        works: [work(W1, WS_A), work(W4, WS_A), work(W2, WS_B), work(W9, WS_B)],
        waits: [waitOn(W1, D1), waitOn(W2, D2)],
        dependencies: [
          dep(D1, W1, workspaceBound(WS_B)),
          dep(D2, W2, workspaceBound(WS_A)),
        ],
      });
      expect(
        detectDeadlock(orOpen, {
          classifyOutputs: allIdle(WS_A, WS_B),
          now: NOW,
        }),
      ).toBeNull();

      // zero candidates: vacant target workspace, not retired — known
      // limitation, detection declines (P7-GAP-01, honest no-fact)
      const vacant = buildWaitGraph({
        works: [work(W1, WS_A)],
        waits: [waitOn(W1, D1)],
        dependencies: [dep(D1, W1, workspaceBound(WS_C))],
      });
      expect(
        detectDeadlock(vacant, {
          classifyOutputs: allIdle(WS_A, WS_C),
          now: NOW,
        }),
      ).toBeNull();
    });

    it("E.6: eligible-set lifecycle — 0→1 begins participating, 1→2 exits determination", () => {
      const dependencies = [
        dep(D1, W1, workspaceBound(WS_B)),
        dep(D2, W2, workBound(W1)),
      ];
      const waits = [waitOn(W1, D1), waitOn(W2, D2)];
      const gate = allIdle(WS_A, WS_B);

      // 0 candidates: W2 not yet a node → no cycle
      const vacant = buildWaitGraph({
        works: [work(W1, WS_A)],
        waits,
        dependencies,
      });
      expect(
        detectDeadlock(vacant, { classifyOutputs: gate, now: NOW }),
      ).toBeNull();

      // 0→1: the degenerate edge + return edge close the cycle
      const one = buildWaitGraph({
        works: [work(W1, WS_A), work(W2, WS_B)],
        waits,
        dependencies,
      });
      expect(detectDeadlock(one, { classifyOutputs: gate, now: NOW })).toEqual({
        cycleWorkIds: [W1, W2],
        dependencyIds: [D1, D2],
        detectedAt: NOW,
      });

      // 1→2: new Open Work in WS_B widens the choice → exits determination
      const two = buildWaitGraph({
        works: [work(W1, WS_A), work(W2, WS_B), work(W3, WS_B)],
        waits,
        dependencies,
      });
      expect(
        detectDeadlock(two, { classifyOutputs: gate, now: NOW }),
      ).toBeNull();
    });

    it("E.7: ghost-edge window (Satisfied + uncleared wait) emits no fact", () => {
      const graph = buildWaitGraph({
        works: [work(W1, WS_A), work(W2, WS_A)],
        waits: [waitOn(W1, D1), waitOn(W2, D2)],
        dependencies: [
          dep(D1, W1, workBound(W2), "Satisfied"),
          dep(D2, W2, workBound(W1)),
        ],
      });
      expect(
        detectDeadlock(graph, { classifyOutputs: allIdle(WS_A), now: NOW }),
      ).toBeNull();
    });

    it("self-loop: a work waiting on its own dependency is a one-node cycle", () => {
      const graph = buildWaitGraph({
        works: [work(W1, WS_A)],
        waits: [waitOn(W1, D1)],
        dependencies: [dep(D1, W1, workBound(W1))],
      });
      expect(
        detectDeadlock(graph, { classifyOutputs: allIdle(WS_A), now: NOW }),
      ).toEqual({ cycleWorkIds: [W1], dependencyIds: [D1], detectedAt: NOW });
    });

    it("Project Idle gate (No.20 project-scoped): any workspace with runnable work or a current work declines", () => {
      const graph = buildWaitGraph({
        works: [work(W1, WS_A), work(W2, WS_A), work(W3, WS_B)],
        waits: [waitOn(W1, D1), waitOn(W2, D2)],
        dependencies: [dep(D1, W1, workBound(W2)), dep(D2, W2, workBound(W1))],
      });
      const withRunnable: ReadonlyArray<ClassifyOutputForGate> = [
        idle(WS_A),
        { workspaceId: WS_B, current: Option.none(), runnable: [W3] },
      ];
      expect(
        detectDeadlock(graph, { classifyOutputs: withRunnable, now: NOW }),
      ).toBeNull();
      const withCurrent: ReadonlyArray<ClassifyOutputForGate> = [
        idle(WS_A),
        { workspaceId: WS_B, current: Option.some(W3), runnable: [] },
      ];
      expect(
        detectDeadlock(graph, { classifyOutputs: withCurrent, now: NOW }),
      ).toBeNull();
    });

    it("detector seam: participating plain edges are handed to the replaceable detector (OR-aware upgrade, 05 §2)", () => {
      const graph = buildWaitGraph({
        works: [work(W1, WS_A), work(W2, WS_B)],
        waits: [waitOn(W1, D1), waitOn(W2, D2)],
        dependencies: [
          dep(D1, W1, workspaceBound(WS_B)), // degenerate choice → plain edge to W2
          dep(D2, W2, workBound(W1)),
        ],
      });
      let seen: ReadonlyArray<ParticipatingEdge> = [];
      const recorder: DeadlockDetector = {
        findCycle: (edges) => {
          seen = edges;
          return conservativeDetector.findCycle(edges);
        },
      };
      const fact = detectDeadlock(
        graph,
        { classifyOutputs: allIdle(WS_A, WS_B), now: NOW },
        recorder,
      );
      expect(seen).toEqual([
        { from: W1, to: W2, dependencyId: D1 },
        { from: W2, to: W1, dependencyId: D2 },
      ]);
      expect(fact).toEqual({
        cycleWorkIds: [W1, W2],
        dependencyIds: [D1, D2],
        detectedAt: NOW,
      });
      // a replaced detector's result passes through untouched (seam purity)
      const fabricator: DeadlockDetector = {
        findCycle: () => ({ cycleWorkIds: [W9], dependencyIds: [D9] }),
      };
      expect(
        detectDeadlock(
          graph,
          { classifyOutputs: allIdle(WS_A, WS_B), now: NOW },
          fabricator,
        ),
      ).toEqual({ cycleWorkIds: [W9], dependencyIds: [D9], detectedAt: NOW });
    });

    it("re-check trigger set matches the current derivation of the frozen principle (illustrative)", () => {
      expect([...DEADLOCK_RECHECK_TRIGGERS]).toEqual([
        "DependencyDeclared",
        "DependencySatisfied",
        "DependencyWithdrawn",
        "DependencyMarkedUnfulfillable",
        "DependencyContractRevised",
        "DeliverableProduced",
        "WorkWaitUpsert",
        "WorkWaitCleared",
        "WorkAssigned",
        "WorkCancelled",
        "WorkCompleted",
        "WorkspaceRetired",
      ]);
    });
  });

  describe("evaluateDeadlock integration (same DB seed pattern as p7-classification)", () => {
    it("mutual WorkBound cycle over the real reads emits fact + event with zero canonical mutation; withdraw → none", async () => {
      await runP7(
        Effect.gen(function* () {
          yield* seedIntegrationCycle;
          const before = yield* snapshotCanonicalState;

          const detected = yield* evaluateOverDb(NOW);
          expect(Option.isSome(detected)).toBe(true);
          if (Option.isSome(detected)) {
            const { fact, event } = detected.value;
            expect([...fact.cycleWorkIds]).toEqual([W_INT1, W_INT2]);
            expect([...fact.dependencyIds]).toEqual([DEP_INT1, DEP_INT2]);
            expect(fact.detectedAt).toBe(NOW);
            expect(event.projectId).toBe(p7Project);
            expect(event.eventType).toBe("DeadlockAttentionRequested");
            expect(event.eventVersion).toBe(1);
            expect(event.occurredAt).toBe(NOW);
            expect(event.actor).toBe("runtime:deadlock-detector");
            expect(event.aggregateRef).toBe(
              `deadlock:${[W_INT1, W_INT2].join("+")}`,
            );
            expect(event.payload).toEqual({
              _tag: "DeadlockAttentionRequested",
              cycleWorkIds: [W_INT1, W_INT2],
              dependencyIds: [DEP_INT1, DEP_INT2],
              detectedAt: NOW,
            });
          }

          // zero mutation: canonical rows and journal are byte-identical
          const after = yield* snapshotCanonicalState;
          expect(after).toEqual(before);

          // resolution is a fresh fact never a rewrite: withdraw one side,
          // re-check declines (wait row intentionally left in place)
          yield* withdrawSeeded(DEP_INT1);
          const resolved = yield* evaluateOverDb(NOW);
          expect(Option.isNone(resolved)).toBe(true);
        }),
        makeDeadlockApp(),
      );
    });
  });
});
