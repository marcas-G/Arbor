import {
  EnvironmentFingerprint,
  type EnvironmentSnapshot,
} from "./environment.js";
import type { CanonicalResourceRegion, ResourceAddress } from "./resources.js";

/**
 * P11 `02` §1 (GQ3'): deterministic snapshot identity.
 *
 * The fingerprint hashes the CANONICAL BYTES of the snapshot's semantic
 * content only. Observation metadata (capturedAt, scan order, runtime ids,
 * serialization artifact order) never enters the digest. The canonical
 * representation is produced HERE — callers never need to pre-sort.
 */

// -- canonical primitive encoders (stable, insertion-order independent) --

const canonicalString = (value: string): string => JSON.stringify(value);

const canonicalAddress = (address: ResourceAddress): string => {
  const parts = [canonicalString(address._tag)];
  switch (address._tag) {
    case "FileTree":
      parts.push(canonicalString(address.path));
      break;
    case "GitWorktree":
      parts.push(canonicalString(address.path));
      break;
    case "DatabaseNamespace":
      parts.push(canonicalString(address.namespace));
      break;
    case "ExternalResource":
      parts.push(canonicalString(address.address));
      break;
  }
  return parts.join(":");
};

const canonicalRegion = (region: CanonicalResourceRegion): string =>
  [
    canonicalString(region.resourceSpaceId),
    canonicalString(region.normalizedRegion as string),
  ].join(":");

export type SnapshotProbe =
  | {
      readonly kind: "FileTree";
      readonly exists: boolean;
      readonly mtime?: string | undefined;
    }
  | {
      readonly kind: "GitWorktree";
      readonly exists: boolean;
      readonly head?: string | undefined;
      readonly dirty?: boolean | undefined;
    };

const canonicalProbe = (probe: SnapshotProbe): string => {
  const parts = [
    canonicalString(probe.kind),
    canonicalString(String(probe.exists)),
  ];
  if (probe.kind === "FileTree") {
    parts.push(canonicalString(probe.mtime ?? ""));
  } else {
    parts.push(canonicalString(probe.head ?? ""));
    parts.push(canonicalString(String(probe.dirty ?? false)));
  }
  return parts.join(":");
};

/** One snapshot region entry as it participates in identity. */
export interface SnapshotRegionEntry {
  readonly address: ResourceAddress;
  readonly resolved: CanonicalResourceRegion;
  readonly probe: SnapshotProbe;
}

/**
 * Canonical region ordering, defined INSIDE the snapshot representation
 * (P11 `02` §1: "canonicalization order frozen: sorted by
 * (resourceSpaceId, normalizedRegion)"): region order in the input array,
 * object key order, and DB row retrieval order are all irrelevant.
 */
const regionSortKey = (entry: SnapshotRegionEntry): string =>
  `${entry.resolved.resourceSpaceId}\u0000${String(
    entry.resolved.normalizedRegion,
  )}`;

/** Canonical region ordering (frozen): copy then sort — deterministic
 * regardless of input order; equal keys are disambiguated by the full
 * canonical encoding (stable total order). Shared by the fingerprint recipe
 * and the snapshot blob encoding so both see the same region order. */
const sortSnapshotEntries = (
  regions: ReadonlyArray<SnapshotRegionEntry>,
): SnapshotRegionEntry[] =>
  [...regions].sort((a, b) => {
    const ka = regionSortKey(a);
    const kb = regionSortKey(b);
    if (ka !== kb) {
      return ka < kb ? -1 : 1;
    }
    const ca = `${canonicalAddress(a.address)}|${canonicalProbe(a.probe)}`;
    const cb = `${canonicalAddress(b.address)}|${canonicalProbe(b.probe)}`;
    return ca === cb ? 0 : ca < cb ? -1 : 1;
  });

const canonicalRegions = (
  regions: ReadonlyArray<SnapshotRegionEntry>,
): string[] =>
  sortSnapshotEntries(regions).map(
    (entry) =>
      `${canonicalRegion(entry.resolved)}|${canonicalAddress(
        entry.address,
      )}|${canonicalProbe(entry.probe)}`,
  );

/** The canonical semantic bytes a fingerprint hashes (frozen recipe). */
export const canonicalSnapshotBytes = (
  projectId: string,
  regions: ReadonlyArray<SnapshotRegionEntry>,
): string =>
  [
    `p11-snapshot-v1`,
    canonicalString(projectId),
    ...canonicalRegions(regions),
  ].join("\n");

/**
 * Fingerprint derivation input: the canonical bytes (computed here, pure).
 * The digest step itself lives in the application layer (node:crypto) —
 * the domain stays runtime-free while owning the canonical recipe.
 * `revision` and `capturedAt` are deliberately NOT hashed — they are
 * observation metadata, not semantic content (P11 `02` §1 / task §1).
 */
export const fingerprintInputBytes = (
  projectId: string,
  regions: ReadonlyArray<SnapshotRegionEntry>,
): string => canonicalSnapshotBytes(projectId, regions);

/**
 * The canonical blob content for persistence (P11 `02` §1). P12 `05` §5.2
 * (TR-2): the blob uses a **collision-free structured encoding** — one
 * explicit JSON object per region entry — so ISO-8601 mtimes containing `:`
 * round-trip exactly (the old delimiter-based line encoding could not). The
 * region order is the same canonical order the fingerprint recipe uses.
 * Round-tripping the blob through `parseSnapshotBlob` + `fingerprintOf`
 * reproduces the same fingerprint (no A-representation/B-representation
 * split), even though the blob bytes are no longer identical to the
 * fingerprint's canonical input bytes.
 */
export const snapshotBlobContent = (
  projectId: string,
  regions: ReadonlyArray<SnapshotRegionEntry>,
): string =>
  [
    "p11-snapshot-v1",
    canonicalString(projectId),
    ...sortSnapshotEntries(regions).map((entry) =>
      JSON.stringify({
        resolved: entry.resolved,
        address: entry.address,
        probe: entry.probe,
      }),
    ),
  ].join("\n");

interface EncodedSnapshotEntry {
  readonly resolved: CanonicalResourceRegion;
  readonly address: ResourceAddress;
  readonly probe: SnapshotProbe;
}

const decodeSnapshotEntry = (
  line: string,
  blob: string,
): SnapshotRegionEntry => {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new SnapshotBlobFormatError(blob);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new SnapshotBlobFormatError(blob);
  }
  const entry = raw as Partial<EncodedSnapshotEntry>;
  if (
    entry.resolved === undefined ||
    entry.address === undefined ||
    entry.probe === undefined
  ) {
    throw new SnapshotBlobFormatError(blob);
  }
  return {
    resolved: entry.resolved,
    address: entry.address,
    probe: entry.probe,
  };
};

export const parseSnapshotBlob = (
  blob: string,
): { projectId: string; regions: ReadonlyArray<SnapshotRegionEntry> } => {
  const lines = blob.split("\n");
  if (lines.length < 3 || lines[0] !== "p11-snapshot-v1") {
    throw new SnapshotBlobFormatError(blob);
  }
  let projectId: unknown;
  try {
    projectId = JSON.parse(lines[1] as string);
  } catch {
    throw new SnapshotBlobFormatError(blob);
  }
  if (typeof projectId !== "string") {
    throw new SnapshotBlobFormatError(blob);
  }
  const regions = lines
    .slice(2)
    .map((line) => decodeSnapshotEntry(line as string, blob));
  return { projectId, regions };
};

/** Typed malformed-blob failure (task §10: no silent re-canonicalization). */
export class SnapshotBlobFormatError extends Error {
  public readonly _tag = "SnapshotBlobFormatError" as const;
  constructor(blob: string) {
    super(`malformed snapshot blob (${String(blob).slice(0, 60)}…)`);
  }
}

/** Witness-building helper: snapshot + fingerprint derived from the same
 * canonical bytes (single source — no double encoding). */
export const buildSnapshotWitness = (
  fingerprintDigest: string,
  projectId: string,
  regions: ReadonlyArray<SnapshotRegionEntry>,
  revision: string,
  capturedAt: string,
): {
  snapshot: typeof import("./environment.js").EnvironmentSnapshot.Type;
  fingerprint: EnvironmentFingerprint;
  blobContent: string;
} => {
  const fingerprint = EnvironmentFingerprint.of(fingerprintDigest);
  const blobContent = snapshotBlobContent(projectId, regions);
  const snapshot = {
    projectId,
    revision,
    fingerprint: fingerprintDigest,
    regions: regions.map((entry) => ({
      address: entry.address as never,
      resolved: entry.resolved as never,
      probe: entry.probe as never,
    })),
    capturedAt,
  };
  return { snapshot, fingerprint, blobContent };
};
