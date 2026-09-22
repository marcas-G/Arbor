import type {
  CanonicalResourceRegion,
  ProjectId,
  ResourceAddress,
} from "@arbor/domain";
import {
  canonicalRegionString,
  EnvironmentFingerprint,
  parseSnapshotBlob,
  type SnapshotProbe,
  type SnapshotRegionEntry,
} from "@arbor/domain";
import type {
  EnvironmentChangeRecord,
  EnvironmentResolverError,
  EnvironmentResolverService,
} from "@arbor/ports";
import { Effect, Option } from "effect";

/**
 * P11 `05` (GQ2) — drift detection v1: EXPLICIT snapshot-diff.
 *
 * probeDrift is observation-only by contract:
 *  - it probes (resolver observe over the full address set), reads the
 *    anchored basis (latest change record / revision store), and COMPARES;
 *  - it never calls RecordEnvironmentChange and never advances the anchor
 *    (CI-1) — a DriftReport is a PROPOSAL; convergence (CI-4) requires a
 *    governed REC submission after confirmation (see the startup seam in
 *    environment-drift-startup.ts, default autoSubmit = false).
 */

export type DriftError =
  | EnvironmentResolverError
  | { readonly _tag: "ChangeReadFailure"; readonly cause: unknown }
  | { readonly _tag: "RevisionReadFailure"; readonly cause: unknown }
  | { readonly _tag: "AnchoredSnapshotReadFailure"; readonly cause: unknown };

/** How changedRegions was derived: a true region-level diff against the
 * parsed anchored snapshot, or the conservative fallback (all candidate
 * regions) when the anchored snapshot is not resolvable. */
export type DriftRegionDiffMode = "RegionDiff" | "Conservative";

export type DriftReport =
  | { readonly _tag: "NoDrift"; readonly atRevision: string }
  | {
      readonly _tag: "Drift";
      readonly anchoredFingerprint: EnvironmentFingerprint;
      readonly candidateFingerprint: EnvironmentFingerprint;
      readonly candidateSnapshotBlobRef: string;
      readonly changedRegions: ReadonlyArray<CanonicalResourceRegion>;
      readonly candidateRevision: string;
      readonly regionDiffMode: DriftRegionDiffMode;
    }
  | {
      /** No environment_changes row exists for the project — the anchored
       * fingerprint is unknown, so the report is conservative by
       * definition (all candidate regions changed). Not a probe failure. */
      readonly _tag: "BasisUninitialized";
      readonly candidateFingerprint: EnvironmentFingerprint;
      readonly candidateSnapshotBlobRef: string;
      readonly changedRegions: ReadonlyArray<CanonicalResourceRegion>;
      readonly candidateRevision: string;
      readonly storeRevision: string | undefined;
    };

/** The `latestChange` face of RecordEnvironmentChange, transaction
 * requirement already satisfied by the wiring (probeDrift itself is
 * R = never by contract). */
export interface DriftAnchorChangeReader {
  readonly latestChange: (
    projectId: ProjectId,
  ) => Effect.Effect<
    Option.Option<EnvironmentChangeRecord>,
    { readonly _tag: "ChangeReadFailure"; readonly cause: unknown },
    never
  >;
}

/** The `current` face of EnvironmentRevisionStore (read anchored basis;
 * never advances — CI-1). Transaction requirement handled by the wiring. */
export interface DriftRevisionReader {
  readonly current: (
    projectId: ProjectId,
  ) => Effect.Effect<
    Option.Option<string>,
    { readonly _tag: "RevisionReadFailure"; readonly cause: unknown },
    never
  >;
}

/** Optional anchored-snapshot reader (blob store read face): given the
 * latest change record's snapshotBlobRef, returns the blob's canonical
 * bytes — or undefined when the blob is not available, which degrades
 * changedRegions to the conservative fallback. */
export interface DriftAnchoredSnapshotReader {
  readonly readBlob: (
    blobRef: string,
  ) => Effect.Effect<
    string | undefined,
    { readonly _tag: "AnchoredSnapshotReadFailure"; readonly cause: unknown },
    never
  >;
}

export interface EnvironmentDriftDeps {
  readonly resolver: EnvironmentResolverService;
  readonly changes: DriftAnchorChangeReader;
  readonly revisions: DriftRevisionReader;
  readonly anchoredSnapshot?: DriftAnchoredSnapshotReader;
}

const regionKey = (region: CanonicalResourceRegion): string =>
  canonicalRegionString(region);

/** Probe equality exactly as the fingerprint's canonical recipe sees it
 * (P11 `02`: mtime "" == undefined, dirty defaults to false). */
const probeEqual = (a: SnapshotProbe, b: SnapshotProbe): boolean => {
  if (a.kind !== b.kind || a.exists !== b.exists) {
    return false;
  }
  if (a.kind === "FileTree" && b.kind === "FileTree") {
    return (a.mtime ?? "") === (b.mtime ?? "");
  }
  if (a.kind === "GitWorktree" && b.kind === "GitWorktree") {
    return (
      (a.head ?? "") === (b.head ?? "") &&
      (a.dirty ?? false) === (b.dirty ?? false)
    );
  }
  return false;
};

const addressEqual = (a: ResourceAddress, b: ResourceAddress): boolean => {
  if (a._tag !== b._tag) {
    return false;
  }
  if (a._tag === "FileTree" && b._tag === "FileTree") {
    return a.path === b.path;
  }
  if (a._tag === "GitWorktree" && b._tag === "GitWorktree") {
    return a.path === b.path;
  }
  if (a._tag === "DatabaseNamespace" && b._tag === "DatabaseNamespace") {
    return a.namespace === b.namespace;
  }
  if (a._tag === "ExternalResource" && b._tag === "ExternalResource") {
    return a.address === b.address;
  }
  return false;
};

const entryEqual = (a: SnapshotRegionEntry, b: SnapshotRegionEntry): boolean =>
  probeEqual(a.probe, b.probe) && addressEqual(a.address, b.address);

/** Region-level diff: a candidate region is changed when its region key is
 * absent from the anchored snapshot or its entry (address/probe) differs;
 * an anchored region absent from the candidate is changed (removed).
 * Deterministic output order (sorted by region key), deduplicated by key. */
const diffAnchoredVsCandidate = (
  anchored: ReadonlyArray<SnapshotRegionEntry>,
  candidate: ReadonlyArray<SnapshotRegionEntry>,
): ReadonlyArray<CanonicalResourceRegion> => {
  const anchoredByKey = new Map(
    anchored.map((entry) => [regionKey(entry.resolved), entry]),
  );
  const candidateKeys = new Set(
    candidate.map((entry) => regionKey(entry.resolved)),
  );
  const changed = new Map<string, CanonicalResourceRegion>();
  for (const entry of candidate) {
    const key = regionKey(entry.resolved);
    const anchoredEntry = anchoredByKey.get(key);
    if (anchoredEntry === undefined || !entryEqual(anchoredEntry, entry)) {
      changed.set(key, entry.resolved);
    }
  }
  for (const entry of anchored) {
    const key = regionKey(entry.resolved);
    if (!candidateKeys.has(key)) {
      changed.set(key, entry.resolved);
    }
  }
  return [...changed.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, region]) => region);
};

const parseAnchoredBlob = (
  content: string,
): ReadonlyArray<SnapshotRegionEntry> | undefined => {
  try {
    return parseSnapshotBlob(content).regions;
  } catch {
    // Malformed anchored blob is not a probe failure: the report degrades
    // to the conservative fallback with the mode marker (P11 `05` v1).
    return undefined;
  }
};

/** P11 `05` §1 (frozen): capture = full-region probe -> candidate
 * fingerprint + snapshot; anchored = latest change record bound to the
 * anchor revision. Equal fingerprints -> NoDrift; else Drift with a
 * region-level diff when the anchored snapshot is parseable, otherwise a
 * conservative all-candidate-regions report. */
export const probeDrift = (
  projectId: ProjectId,
  addresses: ReadonlyArray<ResourceAddress>,
  deps: EnvironmentDriftDeps,
): Effect.Effect<DriftReport, DriftError, never> =>
  Effect.gen(function* () {
    const candidate = yield* deps.resolver.observe(projectId, addresses);
    const latest = yield* deps.changes.latestChange(projectId);
    const basis = yield* deps.revisions.current(projectId);

    if (Option.isNone(latest)) {
      return {
        _tag: "BasisUninitialized",
        candidateFingerprint: candidate.fingerprint,
        candidateSnapshotBlobRef: candidate.snapshotBlobRef,
        changedRegions: candidate.entries.map((entry) => entry.resolved),
        candidateRevision: candidate.observedRevision,
        storeRevision: Option.getOrElse(basis, () => undefined),
      };
    }

    const anchored = latest.value;
    const atRevision = Option.getOrElse(basis, () => anchored.toRevision);

    if (anchored.nextFingerprint === candidate.fingerprint.digest) {
      return { _tag: "NoDrift", atRevision };
    }

    let regionDiffMode: DriftRegionDiffMode = "Conservative";
    let changedRegions: ReadonlyArray<CanonicalResourceRegion> =
      candidate.entries.map((entry) => entry.resolved);
    if (deps.anchoredSnapshot !== undefined) {
      const content = yield* deps.anchoredSnapshot.readBlob(
        anchored.snapshotBlobRef,
      );
      const anchoredEntries =
        content === undefined ? undefined : parseAnchoredBlob(content);
      if (anchoredEntries !== undefined) {
        regionDiffMode = "RegionDiff";
        changedRegions = diffAnchoredVsCandidate(
          anchoredEntries,
          candidate.entries,
        );
      }
    }

    return {
      _tag: "Drift",
      anchoredFingerprint: EnvironmentFingerprint.of(anchored.nextFingerprint),
      candidateFingerprint: candidate.fingerprint,
      candidateSnapshotBlobRef: candidate.snapshotBlobRef,
      changedRegions,
      candidateRevision: candidate.observedRevision,
      regionDiffMode,
    };
  });
