import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalRegionString,
  parse,
  produceSandboxBoundaryV1,
  resourceBoundaryDigestFromRegionsV1,
  sandboxTargetRefOfRegionV1,
  WorkspaceId,
} from "../src/index.js";
import type {
  CanonicalResourceRegion,
  ResourceAddress,
  ResourceBoundary,
} from "../src/resources.js";
import type { SandboxBoundaryProductionInputV1 } from "../src/sandbox-policy-boundary-producer.js";

const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const otherWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a2",
);

const fileTree = (path: string): CanonicalResourceRegion => ({
  resourceSpaceId: "filesystem",
  normalizedRegion: { kind: "FileTree", path },
});
const gitWorktree = (path: string): CanonicalResourceRegion => ({
  resourceSpaceId: "filesystem",
  normalizedRegion: { kind: "GitWorktree", path },
});
const database = (namespace: string): CanonicalResourceRegion => ({
  resourceSpaceId: "database",
  normalizedRegion: { kind: "DatabaseNamespace", namespace },
});
const external = (address: string): CanonicalResourceRegion => ({
  resourceSpaceId: "external",
  normalizedRegion: { kind: "ExternalResource", address },
});

const boundary = (addresses: ReadonlyArray<ResourceAddress>) =>
  ({ basisResponsibilityRevision: 0, addresses }) as ResourceBoundary;
const input = (
  addresses: ReadonlyArray<ResourceAddress>,
  resolvedRegions: ReadonlyArray<CanonicalResourceRegion>,
  overrides: Partial<SandboxBoundaryProductionInputV1> = {},
): SandboxBoundaryProductionInputV1 => ({
  workspaceId,
  resourceBoundaryRevision: 4,
  responsibilityRevision: 0,
  boundary: boundary(addresses),
  resolvedRegions,
  primaryManagedGitWorktreeRegion: gitWorktree("/repo/workspace"),
  ownershipClaims: [],
  policyKind: "OsEnforced",
  profile: "WorkspaceWrite",
  ...overrides,
});

describe("P11 complete sandbox ResourceBoundary producer", () => {
  it("hashes the complete boundary and materializes deterministic filesystem-only mounts", () => {
    const primary = gitWorktree("/repo/workspace");
    const primaryAlias = fileTree("/repo/workspace");
    const extra = fileTree("/repo/extra");
    const databaseTarget = database("tenant:one");
    const externalTarget = external("https://example.test");
    const addresses: ResourceAddress[] = [
      { _tag: "GitWorktree", path: "/repo/workspace" },
      { _tag: "FileTree", path: "/repo/workspace" },
      { _tag: "FileTree", path: "/repo/extra" },
      { _tag: "DatabaseNamespace", namespace: "tenant:one" },
      { _tag: "ExternalResource", address: "https://example.test" },
    ];
    const claims = [
      {
        workspaceId,
        region: extra,
        resourceBoundaryRevision: 4,
        releasedAt: null,
      },
      {
        workspaceId,
        region: primary,
        resourceBoundaryRevision: 3,
        releasedAt: null,
      },
      {
        workspaceId: otherWorkspaceId,
        region: primary,
        resourceBoundaryRevision: 4,
        releasedAt: null,
      },
      {
        workspaceId,
        region: primaryAlias,
        resourceBoundaryRevision: 4,
        releasedAt: "2026-10-18T00:00:00.000Z",
      },
    ];
    const result = produceSandboxBoundaryV1(
      input(addresses, [primary, extra, databaseTarget, externalTarget], {
        ownershipClaims: claims,
      }),
      hash,
    );

    expect(result).toBeDefined();
    expect(result?.targetRefs).toHaveLength(4);
    expect(
      result?.targetRefs.map((target) => target.resourceSpace).sort(),
    ).toEqual(["database", "external", "filesystem", "filesystem"]);
    expect(result?.mounts).toHaveLength(2);
    expect(result?.mounts[0]).toMatchObject({
      mountId: `resource-${hash(canonicalRegionString(extra))}`,
      access: "ReadWrite",
      targetRef: {
        version: 1,
        kind: "RegionDigest",
        resourceSpace: "filesystem",
      },
    });
    expect(result?.mounts[1]).toMatchObject({
      mountId: "workspace",
      access: "ReadOnly",
    });
    expect(result?.resourceBoundaryDigest).toBe(
      hash(
        `{"version":1,"basisResponsibilityRevision":0,"regions":[${[
          canonicalRegionString(extra),
          canonicalRegionString(primary),
          canonicalRegionString(databaseTarget),
          canonicalRegionString(externalTarget),
        ]
          .sort()
          .map((region) => JSON.stringify(region))
          .join(",")}]}`,
      ),
    );
    expect(result?.sandboxHandleBindingDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(result)).not.toContain("/repo/");
    const reordered = produceSandboxBoundaryV1(
      input(
        [...addresses].reverse(),
        [primary, extra, databaseTarget, externalTarget].reverse(),
        { ownershipClaims: claims },
      ),
      hash,
    );
    expect(reordered).toEqual(result);
  });

  it("matches accepted revision-zero boundary and V21 target-reference KATs", () => {
    const fixture = gitWorktree("/fixture/a");
    expect(sandboxTargetRefOfRegionV1(fixture, hash)).toBeDefined();
    expect(resourceBoundaryDigestFromRegionsV1(0, [fixture], hash)).toBe(
      "429afbb35ca0bd989c5d0bfeebd60887c240f9ddeb1acdf29ab52f5564e10f6c",
    );
    const boundaryDigest = produceSandboxBoundaryV1(
      input([{ _tag: "GitWorktree", path: "/fixture/a" }], [fixture], {
        resourceBoundaryRevision: 0,
        primaryManagedGitWorktreeRegion: fixture,
      }),
      hash,
    );
    // Retain the exact boundary's basis revision while varying the handle
    // revision independently.
    expect(boundaryDigest?.resourceBoundaryDigest).toBe(
      "429afbb35ca0bd989c5d0bfeebd60887c240f9ddeb1acdf29ab52f5564e10f6c",
    );

    const knownTarget = gitWorktree("C:\\v17-fixture\\workspace");
    const targetResult = produceSandboxBoundaryV1(
      input(
        [{ _tag: "GitWorktree", path: "C:\\v17-fixture\\workspace" }],
        [knownTarget],
        { primaryManagedGitWorktreeRegion: knownTarget },
      ),
      hash,
    );
    expect(targetResult?.mounts[0]).toMatchObject({
      mountId: "workspace",
      targetRef: {
        version: 1,
        kind: "RegionDigest",
        resourceSpace: "filesystem",
        regionIdentityDigest:
          "3156810bbb81123146cfaa091838168edefd1e7ffe1306e2e414368d4afa86db",
      },
    });
  });

  it("uses exact active current ownership and closed profile/access combinations", () => {
    const primary = gitWorktree("/repo/workspace");
    const addresses: ResourceAddress[] = [
      { _tag: "GitWorktree", path: "/repo/workspace" },
    ];
    const claim = {
      workspaceId,
      region: primary,
      resourceBoundaryRevision: 4,
      releasedAt: null,
    };
    const workspaceWrite = produceSandboxBoundaryV1(
      input(addresses, [primary], { ownershipClaims: [claim] }),
      hash,
    );
    expect(workspaceWrite?.mounts[0]?.access).toBe("ReadWrite");
    const readOnly = produceSandboxBoundaryV1(
      input(addresses, [primary], {
        policyKind: "OsEnforced",
        profile: "ReadOnly",
        ownershipClaims: [claim],
      }),
      hash,
    );
    expect(readOnly?.mounts[0]?.access).toBe("ReadOnly");
    const fullAccess = produceSandboxBoundaryV1(
      input(addresses, [primary], {
        policyKind: "TrustedLocalUnconfinedV1",
        profile: "FullAccess",
        ownershipClaims: [],
      }),
      hash,
    );
    expect(fullAccess?.mounts[0]?.access).toBe("ReadWrite");
    expect(
      produceSandboxBoundaryV1(
        input(addresses, [primary], { profile: "FullAccess" }),
        hash,
      ),
    ).toBeUndefined();
    expect(
      produceSandboxBoundaryV1(
        input(addresses, [primary], {
          policyKind: "TrustedLocalUnconfinedV1",
          profile: "WorkspaceWrite",
        }),
        hash,
      ),
    ).toBeUndefined();
  });

  it("requires a complete, space-consistent boundary and exact primary worktree", () => {
    const primary = gitWorktree("/repo/workspace");
    const validAddress: ResourceAddress[] = [
      { _tag: "GitWorktree", path: "/repo/workspace" },
    ];
    expect(
      produceSandboxBoundaryV1(input(validAddress, []), hash),
    ).toBeUndefined();
    expect(
      produceSandboxBoundaryV1(
        input(validAddress, [primary], {
          primaryManagedGitWorktreeRegion: fileTree("/repo/workspace"),
        }),
        hash,
      ),
    ).toBeUndefined();
    expect(
      produceSandboxBoundaryV1(
        input(validAddress, [primary], { responsibilityRevision: 1 }),
        hash,
      ),
    ).toBeUndefined();
    expect(
      produceSandboxBoundaryV1(
        input(validAddress, [database("tenant:one")]),
        hash,
      ),
    ).toBeUndefined();
    expect(
      produceSandboxBoundaryV1(
        input(validAddress, [primary], {
          primaryManagedGitWorktreeRegion: gitWorktree("/repo/elsewhere"),
        }),
        hash,
      ),
    ).toBeUndefined();
  });

  it("fails closed on region digest collisions and malformed ownership facts", () => {
    const first = gitWorktree("/repo/workspace");
    const second = fileTree("/repo/other");
    const addresses: ResourceAddress[] = [
      { _tag: "GitWorktree", path: "/repo/workspace" },
      { _tag: "FileTree", path: "/repo/other" },
    ];
    expect(
      produceSandboxBoundaryV1(input(addresses, [first, second]), () =>
        "a".repeat(64),
      ),
    ).toBeUndefined();
    expect(
      produceSandboxBoundaryV1(
        input([{ _tag: "GitWorktree", path: "/repo/workspace" }], [first], {
          ownershipClaims: [
            {
              workspaceId,
              region: fileTree("/outside"),
              resourceBoundaryRevision: 4,
              releasedAt: null,
            },
          ],
        }),
        hash,
      ),
    ).toBeUndefined();
  });

  it("rejects conflicting GitWorktree metadata hidden by canonical aliasing", () => {
    const primary = {
      _tag: "GitWorktree" as const,
      path: "/repo/workspace",
      repositoryRef: "repo:one",
    };
    const conflicting = {
      _tag: "GitWorktree" as const,
      path: "/repo/workspace",
      repositoryRef: "repo:two",
    };
    const region = gitWorktree("/repo/workspace");
    expect(
      produceSandboxBoundaryV1(
        input(
          [{ _tag: "FileTree", path: "/repo/workspace" }, primary, conflicting],
          [fileTree("/repo/workspace")],
          {
            primaryManagedGitWorktreeRegion: region,
          },
        ),
        hash,
      ),
    ).toBeUndefined();
  });

  it("accepts P11 resolver-normalized relative paths and a FileTree alias representative for primary", () => {
    const resolvedPrimary = gitWorktree("C:\\resolved\\workspace");
    const result = produceSandboxBoundaryV1(
      input(
        [
          { _tag: "FileTree", path: "./relative/workspace" },
          { _tag: "GitWorktree", path: "./relative/workspace" },
        ],
        [fileTree("C:\\resolved\\workspace")],
        { primaryManagedGitWorktreeRegion: resolvedPrimary },
      ),
      hash,
    );
    expect(result?.mounts).toHaveLength(1);
    expect(result?.mounts[0]).toMatchObject({
      mountId: "workspace",
      targetRef: {
        resourceSpace: "filesystem",
        regionIdentityDigest: hash(canonicalRegionString(resolvedPrimary)),
      },
    });
  });
});
