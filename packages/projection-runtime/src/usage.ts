import type { ProjectId, WorkspaceId } from "@arbor/domain";
import { Effect } from "effect";
import type { ProjectionReadError } from "./errors.js";
import { projectionReadError } from "./errors.js";

// --- P10 `01` §1 Usage (SD §12.1, §7.7 invariant 45; P10 `05` §1 cores) --
//
// OBSERVE-ONLY (invariant 45): the aggregation never influences budget or
// any mutation — the derive reads provider_turns.usage_json and returns
// rows, nothing else. Single aggregation source: the Tree view's
// usageSummary is populated from this same aggregate (tree.ts calls
// aggregateUsageByWorkspace — no second derivation exists).

/** Mirrors the frozen UsageRow core (P10 `05` §1). */
export interface UsageRowView {
  readonly workspaceId: WorkspaceId;
  readonly tokens: number;
  readonly cost: number;
  readonly turns: number;
}

export type UsageGroupBy = "workspace" | "subtree" | "project";

export interface UsageRequest {
  readonly projectId: ProjectId;
  readonly groupBy: UsageGroupBy;
}

/** One provider_turns usage fact, workspace-attributed (the persistence
 * adapter joins executions for attribution; usageJson is raw). */
export interface UsageTurnFact {
  readonly workspaceId: WorkspaceId;
  readonly usageJson: string | null;
  readonly settledAt: string | null;
}

export interface UsageDeps {
  readonly listUsageTurns: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<UsageTurnFact>, ProjectionReadError>;
  /** Workspace parent chain of the project (for subtree aggregation). */
  readonly listWorkspacesByProject: (projectId: ProjectId) => Effect.Effect<
    ReadonlyArray<{
      readonly workspaceId: WorkspaceId;
      readonly parentWorkspaceId: WorkspaceId | null;
    }>,
    ProjectionReadError
  >;
}

/** Parsed UsageReported facts (one settled turn). tokens = the sum of
 * every token count the provider reported (input + output + cache read
 * + cache write); turns = 1 per settled turn. cost: usage events carry
 * no canonical pricing source — the row renders 0 (rendering/pricing is
 * P12 transport detail; invariant 45 forbids any budget coupling). */
export interface ParsedUsageTurn {
  readonly tokens: number;
  readonly cost: number;
  readonly settled: boolean;
}

const numeric = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export const parseUsageJson = (
  usageJson: string | null,
  settledAt: string | null,
): ParsedUsageTurn => {
  if (usageJson === null || settledAt === null) {
    return { tokens: 0, cost: 0, settled: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(usageJson);
  } catch {
    return { tokens: 0, cost: 0, settled: true };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { tokens: 0, cost: 0, settled: true };
  }
  const record = parsed as Record<string, unknown>;
  if (record._tag !== undefined && record._tag !== "UsageReported") {
    return { tokens: 0, cost: 0, settled: true };
  }
  return {
    tokens:
      numeric(record.inputTokens) +
      numeric(record.outputTokens) +
      numeric(record.cacheReadTokens) +
      numeric(record.cacheWriteTokens),
    cost: 0,
    settled: true,
  };
};

/** The single aggregation: per-workspace sums over settled turns. The
 * Tree view consumes this same function (no second derivation). */
export const aggregateUsageByWorkspace = (
  turns: ReadonlyArray<UsageTurnFact>,
): ReadonlyMap<
  WorkspaceId,
  { tokens: number; cost: number; turns: number }
> => {
  const sums = new Map<
    WorkspaceId,
    {
      tokens: number;
      cost: number;
      turns: number;
    }
  >();
  for (const turn of turns) {
    const parsed = parseUsageJson(turn.usageJson, turn.settledAt);
    if (!parsed.settled) {
      continue;
    }
    const current = sums.get(turn.workspaceId) ?? {
      tokens: 0,
      cost: 0,
      turns: 0,
    };
    sums.set(turn.workspaceId, {
      tokens: current.tokens + parsed.tokens,
      cost: current.cost + parsed.cost,
      turns: current.turns + 1,
    });
  }
  return sums;
};

const subtreeSums = (
  own: ReadonlyMap<
    WorkspaceId,
    { tokens: number; cost: number; turns: number }
  >,
  workspaces: ReadonlyArray<{
    readonly workspaceId: WorkspaceId;
    readonly parentWorkspaceId: WorkspaceId | null;
  }>,
): ReadonlyMap<
  WorkspaceId,
  { tokens: number; cost: number; turns: number }
> => {
  const byId = new Map(
    workspaces.map((workspace) => [workspace.workspaceId, workspace]),
  );
  const childrenOf = new Map<WorkspaceId, Array<WorkspaceId>>();
  for (const workspace of workspaces) {
    if (
      workspace.parentWorkspaceId === null ||
      !byId.has(workspace.parentWorkspaceId)
    ) {
      continue;
    }
    const siblings = childrenOf.get(workspace.parentWorkspaceId) ?? [];
    siblings.push(workspace.workspaceId);
    childrenOf.set(workspace.parentWorkspaceId, siblings);
  }
  const memo = new Map<
    WorkspaceId,
    { tokens: number; cost: number; turns: number }
  >();
  const walk = (
    workspaceId: WorkspaceId,
    seen: Set<WorkspaceId>,
  ): { tokens: number; cost: number; turns: number } => {
    const cached = memo.get(workspaceId);
    if (cached !== undefined) {
      return cached;
    }
    if (seen.has(workspaceId)) {
      // Cycles are impossible in canonical data (workspace DAG); this
      // guard is defensive only.
      return { tokens: 0, cost: 0, turns: 0 };
    }
    const nextSeen = new Set(seen);
    nextSeen.add(workspaceId);
    let total = own.get(workspaceId) ?? { tokens: 0, cost: 0, turns: 0 };
    for (const child of childrenOf.get(workspaceId) ?? []) {
      const childSum = walk(child, nextSeen);
      total = {
        tokens: total.tokens + childSum.tokens,
        cost: total.cost + childSum.cost,
        turns: total.turns + childSum.turns,
      };
    }
    memo.set(workspaceId, total);
    return total;
  };
  for (const workspace of workspaces) {
    walk(workspace.workspaceId, new Set());
  }
  return memo;
};

/** UsageRes core derive — observe-only, read-only. groupBy semantics
 * (mechanical, frozen core): `workspace` → one row per workspace with
 * own sums; `subtree` → one row per workspace with own + descendant sums;
 * `project` → a single row keyed by the project root workspace carrying
 * the project total. */
export const deriveUsageRows = (
  request: UsageRequest,
  deps: UsageDeps,
): Effect.Effect<ReadonlyArray<UsageRowView>, ProjectionReadError> =>
  Effect.gen(function* () {
    const turns = yield* deps.listUsageTurns(request.projectId);
    const own = aggregateUsageByWorkspace(turns);
    const workspaces = yield* deps.listWorkspacesByProject(request.projectId);

    if (request.groupBy === "workspace") {
      return workspaces
        .map(
          (workspace): UsageRowView => ({
            workspaceId: workspace.workspaceId,
            ...(own.get(workspace.workspaceId) ?? {
              tokens: 0,
              cost: 0,
              turns: 0,
            }),
          }),
        )
        .sort((a, b) => (a.workspaceId < b.workspaceId ? -1 : 1));
    }

    if (request.groupBy === "subtree") {
      const sums = subtreeSums(own, workspaces);
      return workspaces
        .map(
          (workspace): UsageRowView => ({
            workspaceId: workspace.workspaceId,
            ...(sums.get(workspace.workspaceId) ?? {
              tokens: 0,
              cost: 0,
              turns: 0,
            }),
          }),
        )
        .sort((a, b) => (a.workspaceId < b.workspaceId ? -1 : 1));
    }

    const root = workspaces.find(
      (workspace) => workspace.parentWorkspaceId === null,
    );
    if (root === undefined) {
      return yield* Effect.fail(
        projectionReadError(
          `project ${request.projectId} has no root workspace`,
        ),
      );
    }
    let tokens = 0;
    let cost = 0;
    let turnCount = 0;
    for (const sum of own.values()) {
      tokens += sum.tokens;
      cost += sum.cost;
      turnCount += sum.turns;
    }
    return [{ workspaceId: root.workspaceId, tokens, cost, turns: turnCount }];
  });
