/**
 * P12 `05` §5.3 — environment snapshot pruning / retention.
 *
 * Environment snapshots (`EnvironmentSnapshotRef` blobs) and their
 * retention/pruning are an ops concern (P11 `02` §3 defers it to P12/ops).
 * Pruning is an explicit ops action — it is never inline in a canonical
 * transaction — and a snapshot referenced by a still-live change record is
 * refused (typed) rather than silently dropped. Canonical records are never
 * touched by pruning.
 */

import { Effect } from "effect";
import { parseDuration } from "./durability.js";

export interface RetentionPolicy {
  /** Keep at least the N most-recent snapshots. */
  readonly keepLastN: number;
  /** Prune unreferenced snapshots older than this ISO-8601 duration. */
  readonly maxAge: string;
}

export interface SnapshotCatalogEntry {
  readonly ref: string;
  readonly capturedAt: string;
}

export interface SnapshotRetentionPlan {
  readonly prune: ReadonlyArray<string>;
  readonly keep: ReadonlyArray<string>;
}

export interface SnapshotPrunedButReferenced {
  readonly _tag: "SnapshotPrunedButReferenced";
  readonly ref: string;
}

export type SnapshotRetentionError = SnapshotPrunedButReferenced;

/** The narrow ops surface pruning needs. It exposes no canonical write and no
 * transaction scope, so pruning can never run inline in a canonical
 * transaction. */
export interface SnapshotPruningDeps {
  readonly listSnapshots: () => ReadonlyArray<SnapshotCatalogEntry>;
  readonly listReferencedRefs: () => ReadonlySet<string>;
  readonly deleteSnapshot: (ref: string) => void;
}

/**
 * Pure retention plan: an unreferenced snapshot is pruned when it is older
 * than `maxAge` **or** beyond the `keepLastN` most-recent snapshots.
 * Referenced snapshots are always kept, so a still-live change record can
 * never lose its snapshot.
 */
export const planSnapshotRetention = (
  entries: ReadonlyArray<SnapshotCatalogEntry>,
  policy: RetentionPolicy,
  now: string,
  referencedRefs: ReadonlySet<string>,
): SnapshotRetentionPlan => {
  const maxAgeMs = parseDuration(policy.maxAge);
  const nowMs = Date.parse(now);
  const keepLastN = Math.max(0, policy.keepLastN);
  const mostRecent = [...entries]
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))
    .slice(0, keepLastN)
    .map((entry) => entry.ref);
  const withinKeepWindow = new Set(mostRecent);
  const prune: string[] = [];
  const keep: string[] = [];
  for (const entry of entries) {
    if (referencedRefs.has(entry.ref)) {
      keep.push(entry.ref);
      continue;
    }
    const age = nowMs - Date.parse(entry.capturedAt);
    if (age > maxAgeMs || !withinKeepWindow.has(entry.ref)) {
      prune.push(entry.ref);
    } else {
      keep.push(entry.ref);
    }
  }
  return { prune, keep };
};

export interface SnapshotPruningResult {
  readonly pruned: ReadonlyArray<string>;
  readonly retained: ReadonlyArray<string>;
}

/**
 * The explicit ops action. Prunes unreferenced snapshots per the policy. It
 * refuses (typed) if any planned ref is still referenced — never a silent
 * drop. Canonical records are untouched: the deps surface has no canonical
 * write.
 */
export const pruneSnapshots = (
  deps: SnapshotPruningDeps,
  policy: RetentionPolicy,
  now: string,
): Effect.Effect<SnapshotPruningResult, SnapshotRetentionError> =>
  Effect.gen(function* () {
    const referenced = deps.listReferencedRefs();
    const plan = planSnapshotRetention(
      deps.listSnapshots(),
      policy,
      now,
      referenced,
    );
    for (const ref of plan.prune) {
      if (referenced.has(ref)) {
        return yield* Effect.fail<SnapshotRetentionError>({
          _tag: "SnapshotPrunedButReferenced",
          ref,
        });
      }
    }
    for (const ref of plan.prune) {
      deps.deleteSnapshot(ref);
    }
    return { pruned: plan.prune, retained: plan.keep };
  });

/** Explicit single-ref pruning: refuses a referenced snapshot (typed). */
export const pruneSnapshotRef = (
  deps: SnapshotPruningDeps,
  ref: string,
): Effect.Effect<void, SnapshotRetentionError> =>
  Effect.gen(function* () {
    if (deps.listReferencedRefs().has(ref)) {
      return yield* Effect.fail<SnapshotRetentionError>({
        _tag: "SnapshotPrunedButReferenced",
        ref,
      });
    }
    deps.deleteSnapshot(ref);
  });
