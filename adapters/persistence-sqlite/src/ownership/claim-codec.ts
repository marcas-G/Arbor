import {
  type CanonicalResourceRegion,
  type ProjectId,
  parse,
  type ResourceAddress,
  type ResourceBoundaryRevision,
  type WorkspaceId,
} from "@arbor/domain";
import {
  type ResourceOwnershipClaimRecord,
} from "@arbor/ports";

export interface ClaimRow {
  readonly claim_id: string;
  readonly workspace_id: string;
  readonly resource_space_id: string;
  readonly canonical_region: string;
  readonly source_address_snapshot: string;
  readonly resource_boundary_revision: number;
  readonly resolved_at_environment_revision: string;
  readonly created_at: string;
  readonly released_at: string | null;
  readonly exclusions_json?: string | null;
  readonly delegating_workspace_id?: string | null;
  readonly delegation_source_id?: string | null;
  readonly claim_revision?: number | null;
}

export interface WorkspaceResourceActivationQualificationEvent {
  readonly boundary: "P11BeforeActivationCommit" | "P11AfterActivationCommit";
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly resourceBoundaryRevision: ResourceBoundaryRevision;
}

/** Process-local test seam for the two durable activation boundaries. */
export type WorkspaceResourceActivationQualificationProbe = (
  event: WorkspaceResourceActivationQualificationEvent,
) => Promise<void>;

export const toClaim = (row: ClaimRow): ResourceOwnershipClaimRecord => ({
  claimId: row.claim_id,
  workspaceId: row.workspace_id as WorkspaceId,
  region: JSON.parse(row.canonical_region) as CanonicalResourceRegion,
  sourceAddressSnapshot: JSON.parse(
    row.source_address_snapshot,
  ) as ResourceAddress,
  resourceBoundaryRevision: Number(
    row.resource_boundary_revision,
  ) as ResourceBoundaryRevision,
  resolvedAtEnvironmentRevision: row.resolved_at_environment_revision,
  createdAt: row.created_at,
  releasedAt: row.released_at,
  exclusions: JSON.parse(
    row.exclusions_json ?? "[]",
  ) as ReadonlyArray<CanonicalResourceRegion>,
  delegatingWorkspaceId: (row.delegating_workspace_id ??
    null) as WorkspaceId | null,
  delegationSourceId: row.delegation_source_id ?? null,
  claimRevision: Number(row.claim_revision ?? 0),
});

export const sourceAddressForRegion = (
  region: CanonicalResourceRegion,
  addresses: ReadonlyArray<ResourceAddress>,
): ResourceAddress | undefined => {
  const normalized = region.normalizedRegion as {
    readonly kind?: unknown;
    readonly _tag?: unknown;
    readonly path?: unknown;
    readonly namespace?: unknown;
    readonly address?: unknown;
  };
  const kind = normalized.kind ?? normalized._tag;
  return addresses.find((address) => {
    if (
      (kind === "FileTree" || kind === "GitWorktree") &&
      (address._tag === "FileTree" || address._tag === "GitWorktree")
    ) {
      return (
        address.path.replaceAll("\\", "/").toLowerCase() ===
        String(normalized.path).replaceAll("\\", "/").toLowerCase()
      );
    }
    if (kind === "DatabaseNamespace" && address._tag === "DatabaseNamespace") {
      return address.namespace === normalized.namespace;
    }
    return (
      kind === "ExternalResource" &&
      address._tag === "ExternalResource" &&
      address.address === normalized.address
    );
  });
};

