import { describe, expect, it } from "vitest";
import type { RegionComparator } from "../src/index.js";
import {
  CanonicalResourceRegion,
  claimWithinBoundary,
  DatabaseNamespace,
  ExternalResource,
  encode,
  FileTree,
  GitWorktree,
  parse,
  ResourceAddress,
  ResourceBoundary,
  ResponsibilityDefinition,
  ResponsibilityRevision,
  regionContains,
  regionsOverlap,
  sameSpaceConflict,
} from "../src/index.js";

type Interval = { readonly start: number; readonly end: number };

const isInterval = (value: unknown): value is Interval => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.start === "number" && typeof record.end === "number";
};

const intervalComparator: RegionComparator<unknown> = {
  contains: (a, b) =>
    isInterval(a) && isInterval(b) && a.start <= b.start && b.end <= a.end,
  overlaps: (a, b) =>
    isInterval(a) && isInterval(b) && a.start < b.end && b.start < a.end,
};

const region = (
  space: string,
  start: number,
  end: number,
): CanonicalResourceRegion => ({
  resourceSpaceId: space,
  normalizedRegion: { start, end },
});

const responsibilityDefinition = {
  purpose: "own arbor domain",
  ownedResponsibilities: ["domain"],
  obligations: ["keep purity"],
  includes: ["packages/domain"],
  excludes: ["adapters"],
  interfaces: ["@arbor/domain"],
};

const resourceBoundary = {
  basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
  addresses: [
    { _tag: "FileTree", path: "/data/arbor" },
    { _tag: "DatabaseNamespace", namespace: "arbor" },
  ],
};

describe("resource value objects", () => {
  it("round-trips ResponsibilityDefinition", () => {
    const parsed = parse(ResponsibilityDefinition)(responsibilityDefinition);
    expect(encode(ResponsibilityDefinition)(parsed)).toEqual(
      responsibilityDefinition,
    );
  });

  it("round-trips all four ResourceAddress variants", () => {
    const variants = [
      { _tag: "FileTree", path: "/a" },
      { _tag: "GitWorktree", path: "/b" },
      { _tag: "DatabaseNamespace", namespace: "c" },
      { _tag: "ExternalResource", address: "https://example.com" },
    ];
    for (const variant of variants) {
      const parsed = parse(ResourceAddress)(variant);
      expect(encode(ResourceAddress)(parsed)).toEqual(variant);
    }
    expect(FileTree).toBeDefined();
    expect(GitWorktree).toBeDefined();
    expect(DatabaseNamespace).toBeDefined();
    expect(ExternalResource).toBeDefined();
  });

  it("round-trips ResourceBoundary and CanonicalResourceRegion", () => {
    const parsedBoundary = parse(ResourceBoundary)(resourceBoundary);
    expect(encode(ResourceBoundary)(parsedBoundary)).toEqual(resourceBoundary);

    const parsedRegion = parse(CanonicalResourceRegion)(
      region("space-1", 0, 10),
    );
    expect(encode(CanonicalResourceRegion)(parsedRegion)).toEqual(
      region("space-1", 0, 10),
    );
  });
});

describe("region algebra", () => {
  it("different resourceSpaceId yields no overlap and no containment", () => {
    const a = region("space-1", 0, 10);
    const b = region("space-2", 0, 10);
    expect(regionsOverlap(a, b, intervalComparator)).toBe(false);
    expect(regionContains(a, b, intervalComparator)).toBe(false);
    expect(sameSpaceConflict(a, b, intervalComparator)).toBe(false);
  });

  it("holds the frozen algebra laws within one space", () => {
    const a = region("s", 0, 10);
    const b = region("s", 2, 8);
    const c = region("s", 3, 5);
    const d = region("s", 20, 30);

    expect(regionsOverlap(a, b, intervalComparator)).toBe(
      regionsOverlap(b, a, intervalComparator),
    );
    expect(regionContains(a, a, intervalComparator)).toBe(true);
    expect(
      regionContains(a, b, intervalComparator) &&
        regionContains(b, c, intervalComparator),
    ).toBe(regionContains(a, c, intervalComparator));
    expect(
      regionContains(a, b, intervalComparator) &&
        regionsOverlap(a, b, intervalComparator),
    ).toBe(true);
    expect(regionsOverlap(a, d, intervalComparator)).toBe(false);
    expect(sameSpaceConflict(a, d, intervalComparator)).toBe(false);
  });

  it("treats exclusive-write conflict as sameSpaceConflict only", () => {
    const a = region("s", 0, 10);
    const b = region("s", 5, 15);
    expect(sameSpaceConflict(a, b, intervalComparator)).toBe(true);
  });

  it("expresses ResourceOwnershipClaim ⊆ ResourceBoundary as a pure predicate", () => {
    const boundaryRegions = [region("s", 0, 10), region("s", 100, 200)];
    expect(
      claimWithinBoundary(
        region("s", 2, 4),
        boundaryRegions,
        intervalComparator,
      ),
    ).toBe(true);
    expect(
      claimWithinBoundary(
        region("s", 50, 60),
        boundaryRegions,
        intervalComparator,
      ),
    ).toBe(false);
    expect(
      claimWithinBoundary(
        region("other", 2, 4),
        boundaryRegions,
        intervalComparator,
      ),
    ).toBe(false);
  });
});
