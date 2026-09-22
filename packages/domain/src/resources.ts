import { Schema } from "effect";
import type { WorkspaceId } from "./ids.js";
import { ResponsibilityRevision } from "./ordinals.js";

export const ResponsibilityDefinition = Schema.Struct({
  purpose: Schema.String,
  ownedResponsibilities: Schema.Array(Schema.String),
  obligations: Schema.Array(Schema.String),
  includes: Schema.Array(Schema.String),
  excludes: Schema.Array(Schema.String),
  interfaces: Schema.Array(Schema.String),
});

export type ResponsibilityDefinition = Schema.Schema.Type<
  typeof ResponsibilityDefinition
>;

export const FileTree = Schema.TaggedStruct("FileTree", {
  path: Schema.String,
});

export const GitWorktree = Schema.TaggedStruct("GitWorktree", {
  path: Schema.String,
  repositoryRef: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
});

export const DatabaseNamespace = Schema.TaggedStruct("DatabaseNamespace", {
  namespace: Schema.String,
});

export const ExternalResource = Schema.TaggedStruct("ExternalResource", {
  address: Schema.String,
});

export const ResourceAddress = Schema.Union([
  FileTree,
  GitWorktree,
  DatabaseNamespace,
  ExternalResource,
]);

export type ResourceAddress = Schema.Schema.Type<typeof ResourceAddress>;

export const ResourceBoundary = Schema.Struct({
  basisResponsibilityRevision: ResponsibilityRevision,
  addresses: Schema.Array(ResourceAddress),
});

export type ResourceBoundary = Schema.Schema.Type<typeof ResourceBoundary>;

export const CanonicalResourceRegion = Schema.Struct({
  resourceSpaceId: Schema.String,
  normalizedRegion: Schema.Unknown,
});

export type CanonicalResourceRegion = Schema.Schema.Type<
  typeof CanonicalResourceRegion
>;

/**
 * P12 `09` §4 (E-07): the ONE canonical stringifier for
 * `CanonicalResourceRegion`, with a fixed key order. FileTree and
 * GitWorktree collapse to the same `kind: "FileTree"` key (kind is
 * descriptive, not identity), so filesystem aliases dedup. Every keyed site
 * (drift region keys, snapshot region ordering, resolver dedup) MUST use this
 * rather than `String(normalizedRegion)` (which collapses objects to
 * `"[object Object]"`).
 */
export const canonicalRegionString = (
  region: CanonicalResourceRegion,
): string => {
  const normalized = region.normalizedRegion as
    | {
        readonly kind?: unknown;
        readonly path?: unknown;
        readonly namespace?: unknown;
        readonly address?: unknown;
      }
    | null
    | undefined;
  const kind =
    normalized !== null && typeof normalized === "object"
      ? normalized.kind
      : undefined;
  if (kind === "FileTree" || kind === "GitWorktree") {
    return JSON.stringify({
      resourceSpaceId: region.resourceSpaceId,
      kind: "FileTree",
      path: normalized?.path,
    });
  }
  if (kind === "DatabaseNamespace") {
    return JSON.stringify({
      resourceSpaceId: region.resourceSpaceId,
      kind: "DatabaseNamespace",
      namespace: normalized?.namespace,
    });
  }
  return JSON.stringify({
    resourceSpaceId: region.resourceSpaceId,
    kind: "ExternalResource",
    address: normalized?.address,
  });
};

export interface SpatialRegion<R> {
  readonly resourceSpaceId: string;
  readonly normalizedRegion: R;
}

export interface RegionComparator<R> {
  readonly contains: (a: R, b: R) => boolean;
  readonly overlaps: (a: R, b: R) => boolean;
}

export const regionsOverlap = <R>(
  a: SpatialRegion<R>,
  b: SpatialRegion<R>,
  comparator: RegionComparator<R>,
): boolean =>
  a.resourceSpaceId === b.resourceSpaceId &&
  comparator.overlaps(a.normalizedRegion, b.normalizedRegion);

export const regionContains = <R>(
  a: SpatialRegion<R>,
  b: SpatialRegion<R>,
  comparator: RegionComparator<R>,
): boolean =>
  a.resourceSpaceId === b.resourceSpaceId &&
  comparator.contains(a.normalizedRegion, b.normalizedRegion);

export const sameSpaceConflict = regionsOverlap;

export interface ResourceOwnershipClaim {
  readonly workspaceId: WorkspaceId;
  readonly region: CanonicalResourceRegion;
}

export const claimWithinBoundary = <R>(
  claimRegion: SpatialRegion<R>,
  boundaryRegions: ReadonlyArray<SpatialRegion<R>>,
  comparator: RegionComparator<R>,
): boolean =>
  boundaryRegions.some((boundaryRegion) =>
    regionContains(boundaryRegion, claimRegion, comparator),
  );
