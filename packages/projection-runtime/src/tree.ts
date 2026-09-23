import type {
  Execution,
  ProjectId,
  UsageCost,
  Verification,
  Work,
  WorkId,
  Workspace,
  WorkspaceId,
} from "@arbor/domain";
import type { WorkWait } from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  type AttentionRow,
  attentionCountsByWorkspace,
  type SubtreeAttentionSummary,
  subtreeAttentionAggregate,
  ZERO_SUBTREE_ATTENTION,
} from "./attention.js";
import type { ProjectionReadError } from "./errors.js";
import { deriveWorkspaceStatus } from "./status.js";
import {
  aggregateUsageByWorkspace,
  type UsageTurnFact,
  unknownCostForTurns,
} from "./usage.js";

// --- P10 `05` §1 TreeView response core (watermark/lag envelope is the
// P10-002 QueryResult layer's concern, not this derive) ---

export interface CurrentWorkView {
  readonly workId: WorkId;
  readonly objective: string;
  readonly status: Work["lifecycle"];
  /** Canonical revision carried to command affordances; never browser-owned. */
  readonly revision: Work["revision"];
}

/** Usage summaries are aggregated from provider_turns.usage_json via the
 * SAME single aggregation source as the Usage view (usage.ts — P10-007
 * wiring; no second derivation exists). */
export interface UsageSummaryView {
  readonly tokens: number;
  /** P12 `04` TR-5: `UsageCost` ADT — `Unknown` is preserved, never `0`. */
  readonly cost: UsageCost;
  readonly turns: number;
}

/** Zero-valued usage summary — the rendering of a workspace with no
 * settled provider turns (aggregateUsageByWorkspace default). */
export const ZERO_USAGE_SUMMARY: UsageSummaryView = {
  tokens: 0,
  cost: unknownCostForTurns(0),
  turns: 0,
};

export interface TreeViewNode {
  readonly workspaceId: WorkspaceId;
  readonly parentWorkspaceId: WorkspaceId | null;
  readonly name: string;
  readonly status: import("@arbor/domain").WorkspaceStatusLabel;
  readonly currentWork: CurrentWorkView | null;
  readonly subtreeAttention: SubtreeAttentionSummary;
  readonly usageSummary?: UsageSummaryView;
  readonly children: ReadonlyArray<TreeViewNode>;
}

export interface TreeViewRequest {
  readonly projectId: ProjectId;
  readonly depth?: number;
}

/** Read faces the Tree view derives from (P10 `01` §1 derive inputs:
 * workspaces parent chain, works.current, dependencies (via the P7
 * classification), verifications, attention read-model, usage summary).
 * Injected; read-only; the package owns no storage and never writes. */
export interface TreeViewDeps {
  readonly listWorkspacesByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<Workspace>, ProjectionReadError>;
  readonly findWork: (
    workId: WorkId,
  ) => Effect.Effect<Option.Option<Work>, ProjectionReadError>;
  readonly listWorksByWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<Work>, ProjectionReadError>;
  readonly findActiveMainExecution: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<Option.Option<Execution>, ProjectionReadError>;
  readonly listActiveWaits: () => Effect.Effect<
    ReadonlyArray<WorkWait>,
    ProjectionReadError
  >;
  readonly listOpenVerifications: () => Effect.Effect<
    ReadonlyArray<Verification>,
    ProjectionReadError
  >;
  /** P7-frozen classification (RunnableWorkSource face) — the
   * waiting-blocked disambiguation reuses it, no re-invention. */
  readonly classify: (workspaceId: WorkspaceId) => Effect.Effect<
    {
      readonly current: Option.Option<WorkId>;
      readonly runnable: ReadonlyArray<WorkId>;
    },
    ProjectionReadError
  >;
  readonly readAttentionRows: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<AttentionRow>, ProjectionReadError>;
  /** P10-007: provider_turns usage facts — the Tree usageSummary is the
   * same aggregation the Usage view serves (observe-only, invariant 45). */
  readonly listUsageTurns: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<UsageTurnFact>, ProjectionReadError>;
}

/** The canonical responsibility hierarchy is a single rooted tree. The
 * projection verifies that invariant before it derives a wire tree: malformed
 * persistence must fail visibly rather than be repaired or inferred by a
 * browser consumer. */
const validateResponsibilityHierarchy = (
  workspaces: ReadonlyArray<Workspace>,
): Effect.Effect<
  {
    readonly root: Workspace;
    readonly byId: ReadonlyMap<WorkspaceId, Workspace>;
    readonly childrenOf: ReadonlyMap<WorkspaceId, ReadonlyArray<Workspace>>;
  },
  ProjectionReadError
> =>
  Effect.gen(function* () {
    if (workspaces.length === 0) {
      return yield* Effect.fail({
        _tag: "ProjectionReadFailure" as const,
        cause: "responsibility hierarchy has zero roots: no workspaces",
      });
    }

    const byId = new Map<WorkspaceId, Workspace>();
    for (const workspace of workspaces) {
      if (byId.has(workspace.workspaceId)) {
        return yield* Effect.fail({
          _tag: "ProjectionReadFailure" as const,
          cause: `duplicate workspace ${workspace.workspaceId} in responsibility hierarchy`,
        });
      }
      byId.set(workspace.workspaceId, workspace);
    }

    const roots = workspaces.filter(
      (workspace) => workspace.parentWorkspaceId === null,
    );
    if (roots.length !== 1) {
      return yield* Effect.fail({
        _tag: "ProjectionReadFailure" as const,
        cause: `responsibility hierarchy requires exactly one root; found ${roots.length}`,
      });
    }

    const childrenOf = new Map<WorkspaceId, Array<Workspace>>();
    for (const workspace of workspaces) {
      if (workspace.parentWorkspaceId === null) {
        continue;
      }
      const parent = byId.get(workspace.parentWorkspaceId);
      if (parent === undefined) {
        return yield* Effect.fail({
          _tag: "ProjectionReadFailure" as const,
          cause: `dangling responsibility parent ${workspace.parentWorkspaceId} for workspace ${workspace.workspaceId}`,
        });
      }
      const siblings = childrenOf.get(parent.workspaceId) ?? [];
      siblings.push(workspace);
      childrenOf.set(parent.workspaceId, siblings);
    }

    // Follow every parent chain so a disconnected cycle cannot hide behind
    // the one valid root. Parent existence was already checked above.
    for (const workspace of workspaces) {
      const path = new Set<WorkspaceId>();
      let cursor = workspace;
      while (cursor.parentWorkspaceId !== null) {
        if (path.has(cursor.workspaceId)) {
          return yield* Effect.fail({
            _tag: "ProjectionReadFailure" as const,
            cause: `cycle in responsibility hierarchy at workspace ${cursor.workspaceId}`,
          });
        }
        path.add(cursor.workspaceId);
        cursor = byId.get(cursor.parentWorkspaceId) as Workspace;
      }
    }

    return { root: roots[0] as Workspace, byId, childrenOf };
  });

/** S2.4.1 semantics: the tree answers who is responsible / doing /
 * waiting / blocked / needs attention without per-node drill-in. */
export const buildTreeView = (
  request: TreeViewRequest,
  deps: TreeViewDeps,
): Effect.Effect<TreeViewNode, ProjectionReadError> =>
  Effect.gen(function* () {
    const workspaces = yield* deps.listWorkspacesByProject(request.projectId);
    const { root, byId, childrenOf } =
      yield* validateResponsibilityHierarchy(workspaces);

    const rows = yield* deps.readAttentionRows(request.projectId);
    const subtreeAttention = subtreeAttentionAggregate(rows, (workspaceId) => {
      const self = byId.get(workspaceId);
      const parentId = self?.parentWorkspaceId ?? null;
      return parentId !== null && byId.has(parentId) ? parentId : null;
    });
    const ownAttention = attentionCountsByWorkspace(rows);
    const activeWaits = yield* deps.listActiveWaits();
    const openVerifications = yield* deps.listOpenVerifications();
    const usageByWorkspace = aggregateUsageByWorkspace(
      yield* deps.listUsageTurns(request.projectId),
    );

    const buildNode = (
      workspace: Workspace,
      level: number,
    ): Effect.Effect<TreeViewNode, ProjectionReadError> =>
      Effect.gen(function* () {
        const works = yield* deps.listWorksByWorkspace(workspace.workspaceId);
        const openWorks = works.filter((work) => work.lifecycle === "Open");
        const classified = yield* deps.classify(workspace.workspaceId);
        const activeMain = Option.isSome(
          yield* deps.findActiveMainExecution(workspace.workspaceId),
        );

        // P7-frozen blocking predicate reuse: an Open work is waiting iff
        // the classifier excluded it from current+runnable; plus any
        // active WorkWait on a work this workspace owns.
        const runnableSet = new Set(classified.runnable);
        const hasWaitingOpenWork = openWorks.some(
          (work) =>
            !runnableSet.has(work.workId) &&
            !(
              Option.isSome(classified.current) &&
              classified.current.value === work.workId
            ),
        );
        const ownedWorkIds = new Set(works.map((work) => work.workId));
        const hasWaitOrBlocking =
          hasWaitingOpenWork ||
          activeWaits.some((wait) => ownedWorkIds.has(wait.workId));

        const openVerification = works.some((work) =>
          openVerifications.some(
            (verification) =>
              verification.state.status === "Open" &&
              verification.workId === work.workId &&
              verification.targetWorkRevision === work.revision,
          ),
        );

        const status = deriveWorkspaceStatus({
          lifecycle: workspace.lifecycle,
          activeMain,
          runnableCount: classified.runnable.length,
          hasWaitOrBlocking,
          openVerification,
          attentionFacts: ownAttention.get(workspace.workspaceId) ?? 0,
        });

        // single aggregation source (usage.ts) — observe-only
        const usage = usageByWorkspace.get(workspace.workspaceId) ?? {
          tokens: 0,
          cost: unknownCostForTurns(0),
          turns: 0,
        };

        let currentWork: CurrentWorkView | null = null;
        if (workspace.currentWorkId !== null) {
          const work = yield* deps.findWork(workspace.currentWorkId);
          if (Option.isSome(work)) {
            currentWork = {
              workId: work.value.workId,
              objective: work.value.objective,
              status: work.value.lifecycle,
              revision: work.value.revision,
            };
          }
        }

        const withinDepth =
          request.depth === undefined || level < request.depth;
        const children = withinDepth
          ? yield* Effect.forEach(
              [...(childrenOf.get(workspace.workspaceId) ?? [])].sort((a, b) =>
                a.workspaceId < b.workspaceId ? -1 : 1,
              ),
              (child) => buildNode(child, level + 1),
            )
          : [];

        return {
          workspaceId: workspace.workspaceId,
          parentWorkspaceId: workspace.parentWorkspaceId,
          name: workspace.name,
          status,
          currentWork,
          subtreeAttention:
            subtreeAttention.get(workspace.workspaceId) ??
            ZERO_SUBTREE_ATTENTION,
          usageSummary: usage,
          children,
        };
      });

    return yield* buildNode(root, 1);
  });

// --- Workspace Summary / Project Overview: aggregated renderings of the
// Tree view — no separate model (P10 `01` §1) ---

export interface WorkspaceSummaryRow {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly status: import("@arbor/domain").WorkspaceStatusLabel;
  readonly subtreeAttention: SubtreeAttentionSummary;
}

export const renderWorkspaceSummary = (
  node: TreeViewNode,
): WorkspaceSummaryRow => ({
  workspaceId: node.workspaceId,
  name: node.name,
  status: node.status,
  subtreeAttention: node.subtreeAttention,
});

export interface ProjectOverview {
  readonly totalWorkspaces: number;
  readonly byStatus: Record<
    import("@arbor/domain").WorkspaceStatusLabel,
    number
  >;
  readonly subtreeAttention: SubtreeAttentionSummary;
}

export const renderProjectOverview = (root: TreeViewNode): ProjectOverview => {
  const byStatus: Record<import("@arbor/domain").WorkspaceStatusLabel, number> =
    {
      executing: 0,
      "waiting-runnable": 0,
      "waiting-blocked": 0,
      idle: 0,
      retired: 0,
      "attention-flagged": 0,
    };
  const walk = (node: TreeViewNode): void => {
    byStatus[node.status] += 1;
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);
  return {
    totalWorkspaces:
      byStatus.executing +
      byStatus["waiting-runnable"] +
      byStatus["waiting-blocked"] +
      byStatus.idle +
      byStatus.retired +
      byStatus["attention-flagged"],
    byStatus,
    subtreeAttention: root.subtreeAttention,
  };
};
