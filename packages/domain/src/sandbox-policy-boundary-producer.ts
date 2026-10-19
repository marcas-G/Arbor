import type { WorkspaceId } from "./ids.js";
import type {
  CanonicalResourceRegion,
  ResourceAddress,
  ResourceBoundary,
} from "./resources.js";
import { canonicalRegionString } from "./resources.js";
import type { SandboxProfile } from "./sandbox-policy.js";
import {
  canonicalSandboxMountsV1,
  compareUtf8BytesV1,
  deriveSandboxMountIdV1,
  resourceBoundaryDigestFromRegionsV1,
  type SandboxPolicyMountV1,
  type SandboxTargetRefV1,
  type Sha256Hex,
  sandboxHandleBindingDigestOfV1,
  sandboxTargetRefOfRegionV1,
  targetIdentityDigestOfV1,
} from "./sandbox-policy-producers.js";

export interface SandboxBoundaryOwnershipClaimInputV1 {
  readonly workspaceId: WorkspaceId;
  readonly region: CanonicalResourceRegion;
  readonly resourceBoundaryRevision: number;
  readonly releasedAt: string | null;
}

export interface SandboxBoundaryProductionInputV1 {
  readonly workspaceId: WorkspaceId;
  readonly resourceBoundaryRevision: number;
  readonly responsibilityRevision: number;
  readonly boundary: ResourceBoundary;
  /** Complete resolver output for every address in boundary, in request order. */
  readonly resolvedRegions: ReadonlyArray<CanonicalResourceRegion>;
  /** Exact active P11 Worktree binding selected as the primary mount. */
  readonly primaryManagedGitWorktreeRegion: CanonicalResourceRegion;
  /** Current Workspace ownership records; stale/released claims never elevate. */
  readonly ownershipClaims: ReadonlyArray<SandboxBoundaryOwnershipClaimInputV1>;
  readonly policyKind: "OsEnforced" | "TrustedLocalUnconfinedV1";
  readonly profile: SandboxProfile;
}

export interface SandboxBoundaryProductionV1 {
  readonly basisResponsibilityRevision: number;
  readonly resourceBoundaryRevision: number;
  readonly resourceBoundaryDigest: string;
  /** Full admitted boundary, including non-filesystem policy-target metadata. */
  readonly targetRefs: ReadonlyArray<SandboxTargetRefV1>;
  /** Only filesystem regions become process mounts. */
  readonly mounts: ReadonlyArray<SandboxPolicyMountV1>;
  readonly sandboxHandleBindingDigest: string;
}

const exactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
): boolean =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));

const hasOnlyScalarValues = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
};

type ResolvedRegionKind =
  | "FileTree"
  | "GitWorktree"
  | "DatabaseNamespace"
  | "ExternalResource";

const resolvedRegionKind = (
  region: CanonicalResourceRegion,
): ResolvedRegionKind | undefined => {
  if (
    typeof region !== "object" ||
    region === null ||
    !exactKeys(region as unknown as Record<string, unknown>, [
      "resourceSpaceId",
      "normalizedRegion",
    ]) ||
    typeof region.resourceSpaceId !== "string" ||
    typeof region.normalizedRegion !== "object" ||
    region.normalizedRegion === null ||
    Array.isArray(region.normalizedRegion)
  )
    return undefined;
  const normalized = region.normalizedRegion as Record<string, unknown>;
  if (typeof normalized.kind !== "string") return undefined;
  const kind = normalized.kind as ResolvedRegionKind;
  const keys =
    kind === "FileTree" || kind === "GitWorktree"
      ? ["kind", "path"]
      : kind === "DatabaseNamespace"
        ? ["kind", "namespace"]
        : kind === "ExternalResource"
          ? ["kind", "address"]
          : undefined;
  if (
    keys === undefined ||
    !exactKeys(normalized, keys) ||
    !keys.slice(1).every((key) => typeof normalized[key] === "string") ||
    !Object.values(normalized).every(
      (value) => typeof value !== "string" || hasOnlyScalarValues(value),
    )
  )
    return undefined;
  const expectedSpace =
    kind === "FileTree" || kind === "GitWorktree"
      ? "filesystem"
      : kind === "DatabaseNamespace"
        ? "database"
        : "external";
  return region.resourceSpaceId === expectedSpace ? kind : undefined;
};

const canonicalAddressRegion = (
  address: ResourceAddress,
): CanonicalResourceRegion | undefined => {
  if (typeof address !== "object" || address === null) return undefined;
  const row = address as unknown as Record<string, unknown>;
  switch (row._tag) {
    case "FileTree":
      return exactKeys(row, ["_tag", "path"]) &&
        typeof row.path === "string" &&
        hasOnlyScalarValues(row.path)
        ? {
            resourceSpaceId: "filesystem",
            normalizedRegion: { kind: "FileTree", path: row.path },
          }
        : undefined;
    case "GitWorktree": {
      const keys = ["_tag", "path"];
      if (Object.hasOwn(row, "repositoryRef")) keys.push("repositoryRef");
      if (Object.hasOwn(row, "branch")) keys.push("branch");
      if (
        !exactKeys(row, keys) ||
        typeof row.path !== "string" ||
        !hasOnlyScalarValues(row.path) ||
        (row.repositoryRef !== undefined &&
          (typeof row.repositoryRef !== "string" ||
            !hasOnlyScalarValues(row.repositoryRef))) ||
        (row.branch !== undefined &&
          (typeof row.branch !== "string" || !hasOnlyScalarValues(row.branch)))
      )
        return undefined;
      return {
        resourceSpaceId: "filesystem",
        normalizedRegion: { kind: "GitWorktree", path: row.path },
      };
    }
    case "DatabaseNamespace":
      return exactKeys(row, ["_tag", "namespace"]) &&
        typeof row.namespace === "string" &&
        hasOnlyScalarValues(row.namespace)
        ? {
            resourceSpaceId: "database",
            normalizedRegion: {
              kind: "DatabaseNamespace",
              namespace: row.namespace,
            },
          }
        : undefined;
    case "ExternalResource":
      return exactKeys(row, ["_tag", "address"]) &&
        typeof row.address === "string" &&
        hasOnlyScalarValues(row.address)
        ? {
            resourceSpaceId: "external",
            normalizedRegion: {
              kind: "ExternalResource",
              address: row.address,
            },
          }
        : undefined;
    default:
      return undefined;
  }
};

const boundaryCanonicalSetV1 = (
  addresses: ReadonlyArray<ResourceAddress>,
): Map<string, ResourceAddress> | undefined => {
  const result = new Map<string, ResourceAddress>();
  for (const address of addresses) {
    const region = canonicalAddressRegion(address);
    if (region === undefined) return undefined;
    const canonical = canonicalRegionString(region);
    const prior = result.get(canonical);
    if (prior !== undefined) {
      if (prior._tag === "GitWorktree" && address._tag === "GitWorktree") {
        const priorMetadata = JSON.stringify([
          prior.repositoryRef ?? null,
          prior.branch ?? null,
        ]);
        const currentMetadata = JSON.stringify([
          address.repositoryRef ?? null,
          address.branch ?? null,
        ]);
        if (priorMetadata !== currentMetadata) return undefined;
      }
    } else {
      result.set(canonical, address);
    }
  }
  return result;
};

const resolvedCanonicalSetV1 = (
  regions: ReadonlyArray<CanonicalResourceRegion>,
): Map<string, CanonicalResourceRegion> | undefined => {
  const result = new Map<string, CanonicalResourceRegion>();
  for (const region of regions) {
    if (resolvedRegionKind(region) === undefined) return undefined;
    const canonical = canonicalRegionString(region);
    if (!hasOnlyScalarValues(canonical)) return undefined;
    if (!result.has(canonical)) result.set(canonical, region);
  }
  return result;
};

/** Pure P11→P4 complete-boundary producer. All environment resolution and
 * repository reads happen before this call; no subset, path or model field is
 * accepted as a substitute for the current complete boundary. */
export const produceSandboxBoundaryV1 = (
  input: SandboxBoundaryProductionInputV1,
  sha256Hex: Sha256Hex,
): SandboxBoundaryProductionV1 | undefined => {
  if (
    !Number.isSafeInteger(input.resourceBoundaryRevision) ||
    input.resourceBoundaryRevision < 0 ||
    !Number.isSafeInteger(input.boundary.basisResponsibilityRevision) ||
    input.boundary.basisResponsibilityRevision < 0 ||
    !Number.isSafeInteger(input.responsibilityRevision) ||
    input.responsibilityRevision !==
      input.boundary.basisResponsibilityRevision ||
    (input.policyKind === "OsEnforced" && input.profile === "FullAccess") ||
    (input.policyKind === "TrustedLocalUnconfinedV1" &&
      input.profile !== "FullAccess")
  )
    return undefined;

  const boundarySet = boundaryCanonicalSetV1(input.boundary.addresses);
  const resolvedSet = resolvedCanonicalSetV1(input.resolvedRegions);
  if (
    boundarySet === undefined ||
    resolvedSet === undefined ||
    boundarySet.size !== resolvedSet.size ||
    [...boundarySet.keys()].some((canonical) => !resolvedSet.has(canonical))
  )
    return undefined;

  const primaryKind = resolvedRegionKind(input.primaryManagedGitWorktreeRegion);
  if (primaryKind !== "GitWorktree") return undefined;
  const primaryCanonical = canonicalRegionString(
    input.primaryManagedGitWorktreeRegion,
  );

  const uniqueRegions = resolvedSet;
  if (uniqueRegions === undefined) return undefined;
  if (!uniqueRegions.has(primaryCanonical)) return undefined;
  const primaryResolvedRegion = uniqueRegions.get(primaryCanonical);
  if (
    primaryResolvedRegion === undefined ||
    resolvedRegionKind(primaryResolvedRegion) !== "GitWorktree"
  )
    return undefined;

  const digestToCanonical = new Map<string, string>();
  const orderedEntries = [...uniqueRegions.entries()].sort(([left], [right]) =>
    compareUtf8BytesV1(left, right),
  );
  const targetRefs: SandboxTargetRefV1[] = [];
  const regions: CanonicalResourceRegion[] = [];
  for (const [canonical, region] of orderedEntries) {
    const targetRef = sandboxTargetRefOfRegionV1(region, sha256Hex);
    if (targetRef === undefined) return undefined;
    const previous = digestToCanonical.get(targetRef.regionIdentityDigest);
    if (previous !== undefined && previous !== canonical) return undefined;
    digestToCanonical.set(targetRef.regionIdentityDigest, canonical);
    targetRefs.push(targetRef);
    regions.push(region);
  }

  const resourceBoundaryDigest = resourceBoundaryDigestFromRegionsV1(
    input.boundary.basisResponsibilityRevision,
    regions,
    sha256Hex,
  );
  if (resourceBoundaryDigest === undefined) return undefined;

  const activeClaims = new Set<string>();
  for (const claim of input.ownershipClaims) {
    if (
      typeof claim.workspaceId !== "string" ||
      !Number.isSafeInteger(claim.resourceBoundaryRevision) ||
      claim.resourceBoundaryRevision < 0 ||
      (claim.releasedAt !== null && typeof claim.releasedAt !== "string") ||
      resolvedRegionKind(claim.region) === undefined
    )
      return undefined;
    if (
      claim.workspaceId === input.workspaceId &&
      claim.resourceBoundaryRevision === input.resourceBoundaryRevision &&
      claim.releasedAt === null
    ) {
      const canonical = canonicalRegionString(claim.region);
      if (!uniqueRegions.has(canonical)) return undefined;
      activeClaims.add(canonical);
    }
  }

  const mounts: SandboxPolicyMountV1[] = [];
  for (const [canonical, region] of orderedEntries) {
    const targetRef = sandboxTargetRefOfRegionV1(region, sha256Hex);
    if (targetRef === undefined) return undefined;
    if (targetRef.resourceSpace !== "filesystem") continue;
    const primary = canonical === primaryCanonical;
    const mountId = deriveSandboxMountIdV1(targetRef, primary);
    const access: SandboxPolicyMountV1["access"] =
      input.profile === "ReadOnly"
        ? "ReadOnly"
        : input.profile === "FullAccess" || activeClaims.has(canonical)
          ? "ReadWrite"
          : "ReadOnly";
    mounts.push({
      mountId,
      targetRef,
      targetIdentityDigest: targetIdentityDigestOfV1(
        {
          workspaceId: input.workspaceId,
          mountId,
          targetRef,
          resourceBoundaryRevision: input.resourceBoundaryRevision,
          access,
        },
        sha256Hex,
      ),
      access,
    });
  }
  const orderedMounts = canonicalSandboxMountsV1(mounts);
  if (
    orderedMounts.length !== mounts.length ||
    orderedMounts.some(
      (mount, index) =>
        index > 0 &&
        orderedMounts[index - 1]?.mountId === mount.mountId &&
        orderedMounts[index - 1]?.targetRef.regionIdentityDigest !==
          mount.targetRef.regionIdentityDigest,
    )
  )
    return undefined;
  const sandboxHandleBindingDigest = sandboxHandleBindingDigestOfV1(
    {
      workspaceId: input.workspaceId,
      resourceBoundaryRevision: input.resourceBoundaryRevision,
      mounts: orderedMounts,
    },
    sha256Hex,
  );
  if (!/^[0-9a-f]{64}$/u.test(sandboxHandleBindingDigest)) return undefined;
  return {
    basisResponsibilityRevision: input.boundary.basisResponsibilityRevision,
    resourceBoundaryRevision: input.resourceBoundaryRevision,
    resourceBoundaryDigest,
    targetRefs,
    mounts: orderedMounts,
    sandboxHandleBindingDigest,
  };
};
