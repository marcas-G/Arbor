import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { parse, WorkId, WorkspaceId } from "../packages/domain/dist/index.js";
import type {
  TreeViewNode,
  WorkspaceStatusFacts,
} from "../packages/projection-runtime/src/index.js";
import {
  applyAttentionOverlay,
  buildTreeView,
  deriveBaseWorkspaceStatus,
  deriveWorkspaceStatus,
  renderProjectOverview,
  renderWorkspaceSummary,
} from "../packages/projection-runtime/src/index.js";
import {
  insertDependencyRow,
  insertEventRow,
  insertExecutionRow,
  insertProjectRootRow,
  insertWaitRow,
  insertWorkRow,
  insertWorkspaceRow,
  makeP10App,
  makeP10Deps,
  migrate,
  p10Child,
  p10Flagged,
  p10Leaf,
  p10Project,
  p10Retired,
  p10Root,
  runP10,
  seedCanonical,
  setCurrentWork,
  snapshotDatabase,
} from "./support/p10-fixture.js";

const facts = (
  overrides: Partial<WorkspaceStatusFacts> = {},
): WorkspaceStatusFacts => ({
  lifecycle: "Active",
  activeMain: false,
  runnableCount: 0,
  hasWaitOrBlocking: false,
  openVerification: false,
  attentionFacts: 0,
  ...overrides,
});

/** The frozen map restated from P10 `01` §2 — the spec the cartesian
 * matrix is asserted against. */
const specBase = (
  f: Omit<WorkspaceStatusFacts, "attentionFacts">,
): ReturnType<typeof deriveBaseWorkspaceStatus> =>
  f.lifecycle === "Retired"
    ? "retired"
    : f.activeMain
      ? "executing"
      : f.runnableCount > 0
        ? "waiting-runnable"
        : f.hasWaitOrBlocking || f.openVerification
          ? "waiting-blocked"
          : "idle";

describe("P10-003 WorkspaceStatus label map (01 §2 — exhaustive, frozen)", () => {
  it("anchor cases: one literal assertion per frozen label", () => {
    expect(deriveWorkspaceStatus(facts({ activeMain: true }))).toBe(
      "executing",
    );
    expect(deriveWorkspaceStatus(facts({ runnableCount: 2 }))).toBe(
      "waiting-runnable",
    );
    expect(deriveWorkspaceStatus(facts({ hasWaitOrBlocking: true }))).toBe(
      "waiting-blocked",
    );
    expect(deriveWorkspaceStatus(facts({ openVerification: true }))).toBe(
      "waiting-blocked",
    );
    expect(deriveWorkspaceStatus(facts())).toBe("idle");
    expect(deriveWorkspaceStatus(facts({ lifecycle: "Retired" }))).toBe(
      "retired",
    );
    expect(
      deriveWorkspaceStatus(facts({ activeMain: true, attentionFacts: 1 })),
    ).toBe("attention-flagged");
  });

  it("cartesian matrix over lifecycle × activeMain × runnable × wait/block × verification matches the frozen map", () => {
    for (const lifecycle of ["Active", "Retired"] as const) {
      for (const activeMain of [false, true]) {
        for (const runnableCount of [0, 2]) {
          for (const hasWaitOrBlocking of [false, true]) {
            for (const openVerification of [false, true]) {
              const base = {
                lifecycle,
                activeMain,
                runnableCount,
                hasWaitOrBlocking,
                openVerification,
              };
              expect(deriveBaseWorkspaceStatus(base)).toEqual(specBase(base));
            }
          }
        }
      }
    }
  });

  it("retired is terminal — it wins over every other fact combination, including the attention overlay", () => {
    expect(
      deriveWorkspaceStatus(
        facts({ lifecycle: "Retired", activeMain: true, attentionFacts: 5 }),
      ),
    ).toBe("retired");
    expect(applyAttentionOverlay("retired", true)).toBe("retired");
  });

  it("attention-flagged is a composable overlay over every non-terminal base label", () => {
    for (const base of [
      "executing",
      "waiting-runnable",
      "waiting-blocked",
      "idle",
    ] as const) {
      expect(applyAttentionOverlay(base, true)).toBe("attention-flagged");
      expect(applyAttentionOverlay(base, false)).toBe(base);
    }
    // attentionFacts > 0 is the trigger; zero facts leave the base label.
    expect(deriveWorkspaceStatus(facts({ attentionFacts: 3 }))).toBe(
      "attention-flagged",
    );
    expect(deriveWorkspaceStatus(facts({ runnableCount: 1 }))).toBe(
      "waiting-runnable",
    );
  });
});

// --- canonical fixture: root(executing) → child(waiting-blocked) →
// leaf(idle), plus retired + attention-flagged siblings under root ---

const W_ROOT = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000001");
const W_CHILD = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000002");
const W_FLAG = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000005");
const OTHER_WS = parse(WorkspaceId)("ws_00000000-0000-7000-8000-0000000000f1");
const DEP_CHILD = "dep_00000000-0000-7000-8000-000000000001";

const seedTree = seedCanonical(
  Effect.gen(function* () {
    yield* insertProjectRootRow(p10Root, p10Project);
    yield* insertWorkspaceRow(
      { workspaceId: p10Root, parentWorkspaceId: null, name: "root" },
      p10Project,
    );
    yield* insertWorkspaceRow(
      { workspaceId: p10Child, parentWorkspaceId: p10Root, name: "child" },
      p10Project,
    );
    yield* insertWorkspaceRow(
      { workspaceId: p10Leaf, parentWorkspaceId: p10Child, name: "leaf" },
      p10Project,
    );
    yield* insertWorkspaceRow(
      {
        workspaceId: p10Retired,
        parentWorkspaceId: p10Root,
        name: "gone",
        lifecycle: "Retired",
      },
      p10Project,
    );
    yield* insertWorkspaceRow(
      { workspaceId: p10Flagged, parentWorkspaceId: p10Root, name: "flagged" },
      p10Project,
    );

    // root: current work + active main execution → executing
    yield* insertWorkRow(
      { workId: W_ROOT, workspaceId: p10Root, objective: "root objective" },
      p10Project,
    );
    yield* setCurrentWork(p10Root, W_ROOT);
    yield* insertExecutionRow(
      {
        executionId: "exe_00000000-0000-7000-8000-000000000001",
        workspaceId: p10Root,
        focusWorkId: W_ROOT,
      },
      p10Project,
    );

    // child: open work blocked by a WorkspaceBound dependency + an active
    // WorkWait referencing it (P7-frozen blocking predicate) → waiting-blocked
    yield* insertWorkRow(
      { workId: W_CHILD, workspaceId: p10Child, objective: "child objective" },
      p10Project,
    );
    yield* insertDependencyRow({
      dependencyId: DEP_CHILD,
      consumerWorkId: W_CHILD,
      producerWorkspaceId: OTHER_WS,
    });
    yield* insertWaitRow(W_CHILD, [
      {
        _tag: "DependencyChanged",
        dependencyId: DEP_CHILD,
        observedRevision: 0,
      },
    ]);

    // leaf: no works → idle
    // retired: lifecycle terminal, no works
    // flagged: clean open work (waiting-runnable base) + a deadlock
    // attention fact targeting it → attention-flagged overlay
    yield* insertWorkRow(
      { workId: W_FLAG, workspaceId: p10Flagged, objective: "flag objective" },
      p10Project,
    );
    yield* insertEventRow({
      eventId: "evt_00000000-0000-7000-8000-000000000001",
      projectId: p10Project,
      eventType: "DeadlockAttentionRequested",
      payload: {
        cycleWorkIds: [W_FLAG],
        dependencyIds: [],
        detectedAt: "t9",
      },
      occurredAt: "t9",
    });
  }),
);

describe("P10-003 Tree view (S2.4.1: the tree answers without per-node drill-in)", () => {
  it("three-level fixture renders every frozen label, currentWork, subtree attention bubbling, zero usage", async () => {
    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedTree;
        const deps = yield* makeP10Deps();
        const before = yield* snapshotDatabase();

        const tree = yield* buildTreeView({ projectId: p10Project }, deps.tree);

        // responsibility chain: root → {child → leaf, retired, flagged}
        expect(tree.workspaceId).toBe(p10Root);
        expect(tree.name).toBe("root");
        expect(tree.status).toBe("executing");
        expect(tree.currentWork).toEqual({
          workId: W_ROOT,
          objective: "root objective",
        });
        expect(tree.usageSummary).toEqual({
          tokens: 0,
          cost: { _tag: "Unknown", reason: "UsageUnavailable" },
          turns: 0,
        });

        const flatten = (node: TreeViewNode): ReadonlyArray<TreeViewNode> => [
          node,
          ...node.children.flatMap(flatten),
        ];
        const byId = new Map(
          flatten(tree).map((node) => [node.workspaceId, node]),
        );
        expect(byId.size).toBe(5);
        expect(byId.get(p10Child)?.status).toBe("waiting-blocked");
        expect(byId.get(p10Leaf)?.status).toBe("idle");
        expect(byId.get(p10Retired)?.status).toBe("retired");
        expect(byId.get(p10Flagged)?.status).toBe("attention-flagged");

        // bubbling: the deadlock fact is ActionRequired at the flagged
        // node and bubbles to the root as counts only — context is never
        // copied upward (SD §12.3).
        expect(byId.get(p10Flagged)?.subtreeAttention).toEqual({
          attention: 0,
          actionRequired: 1,
        });
        expect(tree.subtreeAttention).toEqual({
          attention: 0,
          actionRequired: 1,
        });
        expect(byId.get(p10Child)?.subtreeAttention).toEqual({
          attention: 0,
          actionRequired: 0,
        });

        // S2.4.1 reading: one tree read answers responsible/doing/waiting/
        // blocked/needs-attention without opening every workspace.
        const statuses = new Set(
          [tree, ...tree.children].map((node) => node.status),
        );
        expect(statuses.has("executing")).toBe(true);
        expect(statuses.has("waiting-blocked")).toBe(true);
        expect(statuses.has("attention-flagged")).toBe(true);

        // Workspace Summary / Project Overview are aggregated renderings
        // of the Tree view — no separate model (P10 `01` §1).
        expect(renderWorkspaceSummary(byId.get(p10Child) ?? tree)).toEqual({
          workspaceId: p10Child,
          name: "child",
          status: "waiting-blocked",
          subtreeAttention: { attention: 0, actionRequired: 0 },
        });
        expect(renderProjectOverview(tree)).toEqual({
          totalWorkspaces: 5,
          byStatus: {
            executing: 1,
            "waiting-runnable": 0,
            "waiting-blocked": 1,
            idle: 1,
            retired: 1,
            "attention-flagged": 1,
          },
          subtreeAttention: { attention: 0, actionRequired: 1 },
        });

        // zero mutation: canonical snapshot identical after the read
        const after = yield* snapshotDatabase();
        expect(after).toBe(before);
      }),
      makeP10App(),
    );
  });

  it("depth prunes the rendered chain without changing node payloads", async () => {
    await runP10(
      Effect.gen(function* () {
        yield* migrate;
        yield* seedTree;
        const deps = yield* makeP10Deps();

        const depth1 = yield* buildTreeView(
          { projectId: p10Project, depth: 1 },
          deps.tree,
        );
        expect(depth1.children).toEqual([]);

        const depth2 = yield* buildTreeView(
          { projectId: p10Project, depth: 2 },
          deps.tree,
        );
        expect(depth2.children.map((child) => child.workspaceId)).toEqual([
          p10Child,
          p10Retired,
          p10Flagged,
        ]);
        expect(depth2.children[0]?.children).toEqual([]);
        // summaries still aggregate the pruned subtree (counts are
        // computed over the workspace hierarchy, not the rendered nodes)
        expect(depth2.subtreeAttention).toEqual({
          attention: 0,
          actionRequired: 1,
        });
      }),
      makeP10App(),
    );
  });
});
