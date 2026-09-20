import type { CacheClass, RetentionClass } from "./prompt.js";

/** DID v1.7 §8.8–§8.10; P3 `02` §5. */
export type ContextLayer = "C0" | "C1" | "C2" | "C3" | "C4" | "C5" | "C6";

export interface ContextFragment {
  readonly ref: string;
  readonly layer: ContextLayer;
  readonly retention: RetentionClass;
  readonly cacheClass: CacheClass;
  readonly tokens: number;
}

export interface ContextBudget {
  readonly modelWindow: number;
  readonly outputReserve: number;
  readonly protocolReserve: number;
  readonly toolReserve: number;
}

export const contextBudget = (budget: ContextBudget): number =>
  budget.modelWindow -
  budget.outputReserve -
  budget.protocolReserve -
  budget.toolReserve;

export interface ContextUnsatisfiable {
  readonly _tag: "ContextUnsatisfiable";
  readonly requiredTokens: number;
  readonly availableTokens: number;
}

export interface ContextPlanResult {
  readonly selected: ReadonlyArray<ContextFragment>;
  readonly evicted: ReadonlyArray<ContextFragment>;
  readonly unsatisfiable: boolean;
}

const RETENTION_RANK: Record<RetentionClass, number> = {
  Evictable: 0,
  Compressible: 1,
  Protected: 2,
  Pinned: 3,
};

const evictionRank = (fragment: ContextFragment): number =>
  RETENTION_RANK[fragment.retention] * 10 + Number(fragment.layer.slice(1));

const isHardControl = (fragment: ContextFragment): boolean =>
  fragment.retention === "Pinned" || fragment.retention === "Protected";

/**
 * Deterministic context planning (DID v1.7 §8.9/§8.10). Output is reserved
 * before input (`contextBudget`). Pinned/Protected fragments are never
 * silently dropped; if they cannot fit the result is unsatisfiable.
 */
export const planContext = (
  fragments: ReadonlyArray<ContextFragment>,
  budget: ContextBudget,
): ContextPlanResult => {
  const limit = contextBudget(budget);
  const hard = fragments.filter(isHardControl);
  const hardTokens = hard.reduce((sum, f) => sum + f.tokens, 0);
  if (hardTokens > limit) {
    return { selected: [], evicted: fragments, unsatisfiable: true };
  }

  const selected: ContextFragment[] = [...hard];
  const evicted: ContextFragment[] = [];
  let remaining = limit - hardTokens;

  const optional = fragments
    .filter((fragment) => !isHardControl(fragment))
    .sort((a, b) => evictionRank(b) - evictionRank(a));

  for (const fragment of optional) {
    if (fragment.tokens <= remaining) {
      selected.push(fragment);
      remaining -= fragment.tokens;
    } else {
      evicted.push(fragment);
    }
  }

  return { selected, evicted, unsatisfiable: false };
};
