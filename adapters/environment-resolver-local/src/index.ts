import { readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type {
  CanonicalResourceRegion,
  ProjectId,
  ResourceAddress,
} from "@arbor/domain";
import {
  canonicalRegionString,
  type SnapshotProbe,
  type SnapshotRegionEntry,
} from "@arbor/domain";
import {
  type EnvironmentError,
  type EnvironmentResolverError,
  EnvironmentResolverPort,
  fingerprintOf,
  ProjectEnvironmentPort,
  type ResolvedEnvironment,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

/**
 * P11 `04` (GQ2/GQ3') — the REAL local environment resolver.
 *
 * Observation-only by construction (CI-1):
 *  - fs probe only (stat / .git HEAD read); no mutation of anything probed;
 *  - the anchor counter is read with a bare SELECT (no transaction scope —
 *    observation needs none; the store port's `current` is not used because
 *    it drags a transaction requirement along);
 *  - this file reaches NO environment write seam of any kind (asserted
 *    mechanically in tests/p11-resolver.test.ts).
 *
 * Sibling of the fake `ProjectEnvironmentPortLive` in
 * adapters/environment-local (kept; not replaced).
 */

/** ENOENT is a valid observation (exists:false) — encoded on the SUCCESS
 * side; every other fs failure is a typed ProbeFailed, never swallowed. */
type Io<A> =
  | { readonly _tag: "Ok"; readonly value: A }
  | { readonly _tag: "Absent" };

const attemptIo = <A>(
  thunk: () => A,
): Effect.Effect<Io<A>, EnvironmentResolverError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed<Io<A>>({ _tag: "Ok", value: thunk() });
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        (cause as { readonly code?: unknown }).code === "ENOENT"
      ) {
        return Effect.succeed<Io<A>>({ _tag: "Absent" });
      }
      return Effect.fail<EnvironmentResolverError>({
        _tag: "ProbeFailed",
        cause,
      });
    }
  });

const probeFileTree = (
  path: string,
): Effect.Effect<SnapshotProbe, EnvironmentResolverError> =>
  Effect.map(
    attemptIo(() => statSync(path)),
    (io): SnapshotProbe => {
      if (io._tag === "Absent") {
        return { kind: "FileTree", exists: false };
      }
      return {
        kind: "FileTree",
        exists: true,
        mtime: io.value.mtime.toISOString(),
      };
    },
  );

const probeGitWorktree = (
  path: string,
): Effect.Effect<SnapshotProbe, EnvironmentResolverError> =>
  Effect.flatMap(
    attemptIo(() => statSync(path)),
    (dirIo) => {
      if (dirIo._tag === "Absent") {
        return Effect.succeed<SnapshotProbe>({
          kind: "GitWorktree",
          exists: false,
        });
      }
      // .git/HEAD missing => worktree exists without git metadata (head
      // undefined — an observation, not a failure). Unreadable for other
      // reasons (EACCES, ...) => typed ProbeFailed.
      return Effect.map(
        attemptIo(() =>
          readFileSync(resolvePath(path, ".git", "HEAD"), "utf8"),
        ),
        (headIo): SnapshotProbe => {
          // dirty: conservatively false (empirical — real dirty detection via
          // `git status --porcelain` is deferred; a false "clean" can only
          // miss semantic change at THIS probe granularity, and any content
          // change under the worktree still moves mtime/HEAD facts).
          const head =
            headIo._tag === "Ok" && headIo.value.trim() !== ""
              ? headIo.value.trim()
              : undefined;
          return { kind: "GitWorktree", exists: true, head, dirty: false };
        },
      );
    },
  );

class UnsupportedResourceFamily extends Error {
  public readonly _tag = "UnsupportedResourceFamily" as const;
  constructor(family: string) {
    super(
      `resource family "${family}" has no v1 probe representation (P11 04 §3: ExternalResource resolves to itself — deferred)`,
    );
  }
}

const probeAddress = (
  address: ResourceAddress,
): Effect.Effect<SnapshotProbe, EnvironmentResolverError> => {
  switch (address._tag) {
    case "FileTree":
      return probeFileTree(address.path);
    case "GitWorktree":
      return probeGitWorktree(address.path);
    default:
      return Effect.fail({
        _tag: "CanonicalizationFailed" as const,
        cause: new UnsupportedResourceFamily(address._tag),
      });
  }
};

/** C8 (DID §12.9 / P11 `04` §1): a GitWorktree aliases to a filesystem
 * subtree in the SAME backing space — FileTree and GitWorktree both
 * canonicalize to resourceSpaceId "filesystem" with an object
 * `normalizedRegion` (`{ kind, path }`). The canonical stringifier collapses
 * the two kinds onto one key, so cross-kind aliases dedup to the FileTree
 * region at the same path (P12 `09` §1/§5). */
const canonicalRegion = (address: ResourceAddress): CanonicalResourceRegion => {
  switch (address._tag) {
    case "FileTree":
    case "GitWorktree":
      return {
        resourceSpaceId: "filesystem",
        normalizedRegion: {
          kind: address._tag,
          path: resolvePath(address.path),
        },
      };
    default:
      throw new UnsupportedResourceFamily(address._tag);
  }
};

const regionKey = (entry: SnapshotRegionEntry): string =>
  canonicalRegionString(entry.resolved);

/** Deterministic alias collapse, independent of caller order: one entry per
 * canonical region; on collision the smallest (family, primary-field)
 * tie-key wins (key-order-free — never JSON.stringify of caller objects). */
const tieKey = (entry: SnapshotRegionEntry): string => {
  const address = entry.address;
  const primary =
    address._tag === "FileTree" || address._tag === "GitWorktree"
      ? address.path
      : address._tag === "DatabaseNamespace"
        ? address.namespace
        : address.address;
  return `${address._tag}\u0000${primary}`;
};

const canonicalize = (
  probed: ReadonlyArray<{
    readonly address: ResourceAddress;
    readonly probe: SnapshotProbe;
  }>,
): ReadonlyArray<SnapshotRegionEntry> => {
  const byRegion = new Map<string, SnapshotRegionEntry>();
  for (const { address, probe } of probed) {
    const entry: SnapshotRegionEntry = {
      address,
      resolved: canonicalRegion(address),
      probe,
    };
    const key = regionKey(entry);
    const existing = byRegion.get(key);
    if (existing === undefined || tieKey(entry) < tieKey(existing)) {
      byRegion.set(key, entry);
    }
  }
  return [...byRegion.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, entry]) => entry);
};

export const EnvironmentResolverLocalLive: Layer.Layer<
  EnvironmentResolverPort,
  never,
  SqlClient
> = Layer.effect(
  EnvironmentResolverPort,
  Effect.gen(function* () {
    const sql = yield* SqlClient;

    // Read-only observation of the anchor counter (CI-1: never advances).
    // No anchor row => "0" (observation semantics: anchor not initialized —
    // the lazy anchor write itself belongs to the ownership write path).
    const observedRevision = (projectId: ProjectId) =>
      Effect.map(
        Effect.mapError(
          sql.unsafe<{ revision: string | null }>(
            "SELECT revision FROM environment_revisions WHERE project_id = ?",
            [projectId],
          ),
          (cause): EnvironmentResolverError => ({ _tag: "ProbeFailed", cause }),
        ),
        (rows) => rows[0]?.revision ?? "0",
      );

    return EnvironmentResolverPort.of({
      observe: (projectId, addresses) =>
        Effect.gen(function* () {
          const probed: Array<{
            address: ResourceAddress;
            probe: SnapshotProbe;
          }> = [];
          for (const address of addresses) {
            probed.push({
              address,
              probe: yield* probeAddress(address),
            });
          }

          // Region canonicalization (C8) — typed, never silently empty.
          const entries = yield* Effect.try({
            try: () => canonicalize(probed),
            catch: (cause): EnvironmentResolverError => ({
              _tag: "CanonicalizationFailed",
              cause,
            }),
          });

          // Fingerprint via the P11-002 construction path (domain owns the
          // canonical recipe; ports owns the digest — P12 `01` §7).
          const fingerprint = yield* Effect.try({
            try: () => fingerprintOf(projectId, entries),
            catch: (cause): EnvironmentResolverError => ({
              _tag: "CanonicalizationFailed",
              cause,
            }),
          });

          // Blob: canonical bytes ARE the blob content; the resolver emits
          // only the ref VALUE (`blob:<digest>`) — persistence to the blob
          // store is REC's consumer side, not here.
          const snapshotBlobRef = yield* Effect.try({
            try: () => `blob:${fingerprint.digest}`,
            catch: (cause): EnvironmentResolverError => ({
              _tag: "BlobFailure",
              cause,
            }),
          });

          return {
            projectId,
            observedRevision: yield* observedRevision(projectId),
            fingerprint,
            snapshotBlobRef,
            changedRegions: entries.map((entry) => entry.resolved),
            entries,
          };
        }),
    });
  }),
);

/**
 * P12 `09` §5 (RG-12): the legacy `ProjectEnvironmentPort` projection over the
 * REAL resolver. Ownership writes / tool admission consume `resolve`; the
 * resolver observation is the single canonical source, so production no
 * longer wires the fake `ProjectEnvironmentPortLive`
 * (`adapters/environment-local`, retained for tests only). The projection is
 * error-mapped to the frozen `EnvironmentError` shape; the canonical regions
 * are the resolver's object-encoded regions unchanged.
 */
export const ProjectEnvironmentPortFromResolverLive: Layer.Layer<
  ProjectEnvironmentPort,
  never,
  EnvironmentResolverPort
> = Layer.effect(
  ProjectEnvironmentPort,
  Effect.gen(function* () {
    const resolver = yield* EnvironmentResolverPort;
    return ProjectEnvironmentPort.of({
      resolve: (projectId: ProjectId, addresses) =>
        Effect.map(
          Effect.mapError(
            resolver.observe(projectId, addresses),
            (cause): EnvironmentError => ({ _tag: "EnvironmentError", cause }),
          ),
          (observation): ResolvedEnvironment => ({
            regions: observation.changedRegions,
            observedEnvironmentRevision: observation.observedRevision,
          }),
        ),
    });
  }),
);
