/**
 * P13-006 render cache: (viewId, requestKey) → entry. Server views are the
 * ONLY projection state source — this store is a disposable render cache, not
 * derived state. Invalidation only marks entries stale (dto retained); fresh
 * data arrives exclusively from fetchView responses, which REPLACE the entry
 * wholesale (I4: frames carry no payload, they never update cache content).
 * getEntries() returns an immutable snapshot reference that only changes on a
 * real mutation (useSyncExternalStore compatible).
 */
import type { Problem, ViewId, ViewResponseMap } from "@arbor/api-contracts";
import type { ViewOutcome } from "./client.js";

/**
 * fresh   = last fetch resolved OK (dto is server-confirmed current)
 * stale   = invalidation-marked, or last fetch failed (prior dto retained)
 * loading = refetch in flight (prior dto retained for display)
 */
export type ViewEntryState = "fresh" | "stale" | "loading";

export interface ViewEntry<V extends ViewId = ViewId> {
  readonly viewId: V;
  readonly requestKey: string;
  readonly state: ViewEntryState;
  readonly dto?: ViewResponseMap[V] | undefined;
  readonly problem?: Problem | undefined;
  readonly watermark?: number | undefined;
}

export interface ViewStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getEntries: () => ReadonlyArray<ViewEntry>;
  readonly getEntry: (entryKey: string) => ViewEntry | undefined;
  readonly invalidate: (viewId: ViewId, watermark?: number) => void;
  readonly resolve: (entryKey: string, outcome: ViewOutcome<ViewId>) => void;
  readonly beginRefetch: (entryKey: string) => void;
}

/** requestKey is JSON.stringify(request) — JSON escapes raw newlines, so the
 * first "\n" separates viewId from requestKey unambiguously. */
export const entryKeyOf = (viewId: ViewId, requestKey: string): string =>
  `${viewId}\n${requestKey}`;

const splitEntryKey = (
  entryKey: string,
): { viewId: ViewId; requestKey: string } => {
  const separator = entryKey.indexOf("\n");
  return {
    viewId: entryKey.slice(0, separator) as ViewId,
    requestKey: entryKey.slice(separator + 1),
  };
};

export function createViewStore(): ViewStore {
  const entries = new Map<string, ViewEntry>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyArray<ViewEntry> = [];

  const commit = (): void => {
    snapshot = [...entries.values()];
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const getEntries = (): ReadonlyArray<ViewEntry> => snapshot;

  const getEntry = (entryKey: string): ViewEntry | undefined =>
    snapshot.find(
      (entry) => entryKeyOf(entry.viewId, entry.requestKey) === entryKey,
    );

  const invalidate = (viewId: ViewId, watermark?: number): void => {
    let changed = false;
    for (const [key, entry] of entries) {
      if (entry.viewId !== viewId) {
        continue;
      }
      const nextWatermark = watermark ?? entry.watermark;
      if (entry.state === "stale" && entry.watermark === nextWatermark) {
        continue;
      }
      entries.set(key, {
        ...entry,
        state: "stale",
        watermark: nextWatermark,
      });
      changed = true;
    }
    if (changed) {
      commit();
    }
  };

  const beginRefetch = (entryKey: string): void => {
    const existing = entries.get(entryKey);
    if (existing === undefined) {
      const { viewId, requestKey } = splitEntryKey(entryKey);
      entries.set(entryKey, { viewId, requestKey, state: "loading" });
      commit();
      return;
    }
    if (existing.state === "loading" && existing.problem === undefined) {
      return;
    }
    entries.set(entryKey, {
      ...existing,
      state: "loading",
      problem: undefined,
    });
    commit();
  };

  const resolve = (entryKey: string, outcome: ViewOutcome<ViewId>): void => {
    const existing = entries.get(entryKey);
    let viewId: ViewId;
    let requestKey: string;
    let watermark: number | undefined;
    let dto: ViewResponseMap[ViewId] | undefined;
    if (existing === undefined) {
      const split = splitEntryKey(entryKey);
      viewId = split.viewId;
      requestKey = split.requestKey;
    } else {
      viewId = existing.viewId;
      requestKey = existing.requestKey;
      watermark = existing.watermark;
      dto = existing.dto;
    }
    if (outcome.ok) {
      entries.set(entryKey, {
        viewId,
        requestKey,
        state: "fresh",
        dto: outcome.dto,
        watermark,
      });
    } else {
      entries.set(entryKey, {
        viewId,
        requestKey,
        state: "stale",
        dto,
        problem: outcome.problem,
        watermark,
      });
    }
    commit();
  };

  return {
    subscribe,
    getEntries,
    getEntry,
    invalidate,
    resolve,
    beginRefetch,
  };
}
