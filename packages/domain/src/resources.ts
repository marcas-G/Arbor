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

/** P1/P4 effective canonical ownership set. */
export interface OwnershipRegion {
  readonly allow: CanonicalResourceRegion;
  readonly exclusions: ReadonlyArray<CanonicalResourceRegion>;
}

export type OwnershipRegionRelation =
  | "Contained"
  | "NotContained"
  | "Overlap"
  | "Disjoint";

export type OwnershipRegionMutation =
  | { readonly _tag: "Contained"; readonly region: OwnershipRegion }
  | { readonly _tag: "NotContained" }
  | { readonly _tag: "Overlap" }
  | { readonly _tag: "Disjoint" }
  | { readonly _tag: "Invalid" };

const sameCanonicalRegion = (
  a: CanonicalResourceRegion,
  b: CanonicalResourceRegion,
): boolean => canonicalRegionString(a) === canonicalRegionString(b);

const ownershipRegionKind = (
  region: CanonicalResourceRegion,
): string | null => {
  const normalized = region.normalizedRegion as
    | { readonly kind?: unknown; readonly _tag?: unknown }
    | null
    | undefined;
  const kind = normalized?.kind ?? normalized?._tag;
  if (
    kind === "FileTree" ||
    kind === "GitWorktree" ||
    kind === "DatabaseNamespace" ||
    kind === "ExternalResource"
  ) {
    return kind === "GitWorktree" ? "FileTree" : kind;
  }
  return null;
};

/** Kinds supported only by equality transfer, never by proper carve-outs. */
export const isEqualityOnlyCanonicalRegion = (
  region: CanonicalResourceRegion,
): boolean => ownershipRegionKind(region) === "ExternalResource";

const validCanonicalOwnershipRegion = (
  region: CanonicalResourceRegion,
): boolean => {
  if (
    typeof region !== "object" ||
    region === null ||
    typeof region.resourceSpaceId !== "string" ||
    region.resourceSpaceId.length === 0 ||
    typeof region.normalizedRegion !== "object" ||
    region.normalizedRegion === null
  ) {
    return false;
  }
  const normalized = region.normalizedRegion as Record<string, unknown>;
  const kind = ownershipRegionKind(region);
  if (kind === "FileTree") {
    return typeof normalized.path === "string" && normalized.path.length > 0;
  }
  if (kind === "DatabaseNamespace") {
    return (
      typeof normalized.namespace === "string" &&
      normalized.namespace.length > 0
    );
  }
  return (
    kind === "ExternalResource" &&
    typeof normalized.address === "string" &&
    normalized.address.length > 0
  );
};

export const isValidOwnershipRegion = (
  value: OwnershipRegion,
  comparator: RegionComparator<unknown>,
): boolean => {
  const exclusions = value.exclusions;
  if (
    !validCanonicalOwnershipRegion(value.allow) ||
    !Array.isArray(exclusions)
  ) {
    return false;
  }
  const allowKind = ownershipRegionKind(value.allow);
  for (let i = 0; i < exclusions.length; i += 1) {
    const exclusion = exclusions[i];
    if (
      exclusion === undefined ||
      !validCanonicalOwnershipRegion(exclusion) ||
      ownershipRegionKind(exclusion) !== allowKind ||
      !regionsOverlap(value.allow, exclusion, comparator) ||
      !regionContains(value.allow, exclusion, comparator) ||
      sameCanonicalRegion(value.allow, exclusion)
    )
      return false;
    for (let j = 0; j < i; j += 1) {
      const prior = exclusions[j];
      if (
        prior === undefined ||
        regionsOverlap(prior, exclusion, comparator) ||
        canonicalRegionString(prior).localeCompare(
          canonicalRegionString(exclusion),
        ) >= 0
      )
        return false;
    }
  }
  return true;
};

/** Tests whether the complete requested canonical region is effectively owned. */
export const ownershipRegionRelation = (
  owner: OwnershipRegion,
  requested: CanonicalResourceRegion,
  comparator: RegionComparator<unknown>,
): OwnershipRegionRelation => {
  if (!isValidOwnershipRegion(owner, comparator)) return "NotContained";
  if (!regionContains(owner.allow, requested, comparator))
    return "NotContained";
  return owner.exclusions.some((exclusion) =>
    regionsOverlap(exclusion, requested, comparator),
  )
    ? "NotContained"
    : "Contained";
};

/** Whether two effective canonical claims overlap, including finite carve-outs. */
export const ownershipRegionsOverlap = (
  a: OwnershipRegion,
  b: OwnershipRegion,
  comparator: RegionComparator<unknown>,
): boolean => {
  if (
    !isValidOwnershipRegion(a, comparator) ||
    !isValidOwnershipRegion(b, comparator)
  )
    return true;
  if (!regionsOverlap(a.allow, b.allow, comparator)) return false;
  const intersection = regionContains(a.allow, b.allow, comparator)
    ? b.allow
    : a.allow;
  return (
    !a.exclusions.some((exclusion) =>
      regionContains(exclusion, intersection, comparator),
    ) &&
    !b.exclusions.some((exclusion) =>
      regionContains(exclusion, intersection, comparator),
    )
  );
};

export const addOwnershipExclusion = (
  owner: OwnershipRegion,
  exclusion: CanonicalResourceRegion,
  comparator: RegionComparator<unknown>,
): OwnershipRegionMutation => {
  if (!isValidOwnershipRegion(owner, comparator)) return { _tag: "Invalid" };
  if (
    isEqualityOnlyCanonicalRegion(owner.allow) ||
    isEqualityOnlyCanonicalRegion(exclusion)
  ) {
    return { _tag: "NotContained" };
  }
  if (ownershipRegionRelation(owner, exclusion, comparator) !== "Contained")
    return { _tag: "NotContained" };
  const exclusions = [...owner.exclusions, exclusion].sort((a, b) =>
    canonicalRegionString(a).localeCompare(canonicalRegionString(b)),
  );
  return { _tag: "Contained", region: { allow: owner.allow, exclusions } };
};

export const removeOwnershipExclusion = (
  owner: OwnershipRegion,
  exclusion: CanonicalResourceRegion,
  comparator: RegionComparator<unknown>,
): OwnershipRegionMutation => {
  if (!isValidOwnershipRegion(owner, comparator)) return { _tag: "Invalid" };
  const index = owner.exclusions.findIndex((candidate) =>
    sameCanonicalRegion(candidate, exclusion),
  );
  if (index < 0) return { _tag: "NotContained" };
  return {
    _tag: "Contained",
    region: {
      allow: owner.allow,
      exclusions: owner.exclusions.filter((_, i) => i !== index),
    },
  };
};

export const claimWithinBoundary = <R>(
  claimRegion: SpatialRegion<R>,
  boundaryRegions: ReadonlyArray<SpatialRegion<R>>,
  comparator: RegionComparator<R>,
): boolean =>
  boundaryRegions.some((boundaryRegion) =>
    regionContains(boundaryRegion, claimRegion, comparator),
  );
