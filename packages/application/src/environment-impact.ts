import type {
  CanonicalResourceRegion,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import { regionsOverlap } from "@arbor/domain";
import { resourceRegionComparator } from "@arbor/ports";

/** P11 `06` §1 NARROW: impact = f(changedRegions, resolved-boundary
 * snapshots). Overlap is judged on canonical regions (never raw
 * addresses — round-1 fix) via the domain `regionsOverlap` and the
 * frozen `normalizedRegion` comparator. Deterministic pure function:
 * no IO, no model calls, no auto-Steer (governance stays human/parent).
 * Consumed by the `07` stale overlay + Inbox notification + Attention
 * rows. */

export interface WorkspaceImpactSnapshot {
  readonly workspaceId: WorkspaceId;
  readonly boundaryRegions: ReadonlyArray<CanonicalResourceRegion>;
}

export interface WorkImpactSnapshot {
  readonly workId: WorkId;
  readonly workspaceId: WorkspaceId;
  readonly boundaryRegions: ReadonlyArray<CanonicalResourceRegion>;
}

export interface ActiveClaimImpactSnapshot {
  readonly claimId: string;
  readonly workspaceId: WorkspaceId;
  readonly regions: ReadonlyArray<CanonicalResourceRegion>;
}

export interface ImpactEvaluationInput {
  readonly changedRegions: ReadonlyArray<CanonicalResourceRegion>;
  readonly workspaces: ReadonlyArray<WorkspaceImpactSnapshot>;
  readonly works: ReadonlyArray<WorkImpactSnapshot>;
  readonly activeClaims: ReadonlyArray<ActiveClaimImpactSnapshot>;
}

export interface ImpactReport {
  readonly affectedWorkspaceIds: ReadonlyArray<WorkspaceId>;
  readonly affectedWorkIds: ReadonlyArray<WorkId>;
  readonly affectedClaimIds: ReadonlyArray<string>;
}

const overlapsAnyChanged = (
  candidate: CanonicalResourceRegion,
  changedRegions: ReadonlyArray<CanonicalResourceRegion>,
): boolean =>
  changedRegions.some((changed) =>
    regionsOverlap(candidate, changed, resourceRegionComparator),
  );

/** The narrowing funnel's narrow step. A Workspace is affected when any
 * of its resolved boundary regions overlaps a changed region; an
 * affected Workspace cascades to its Works and active claims (their
 * whole responsibility context is potentially stale). Works and claims
 * are additionally affected by their own resolved regions overlapping.
 * Output preserves input order, deduplicated; empty changedRegions
 * yields the empty report. */
export const evaluateEnvironmentImpact = (
  input: ImpactEvaluationInput,
): ImpactReport => {
  const affectedWorkspaceIds: WorkspaceId[] = [];
  const affectedWorkspaces = new Set<WorkspaceId>();
  for (const workspace of input.workspaces) {
    if (
      workspace.boundaryRegions.some((boundary) =>
        overlapsAnyChanged(boundary, input.changedRegions),
      )
    ) {
      affectedWorkspaces.add(workspace.workspaceId);
      affectedWorkspaceIds.push(workspace.workspaceId);
    }
  }

  const affectedWorkIds: WorkId[] = [];
  const seenWorks = new Set<WorkId>();
  for (const work of input.works) {
    if (seenWorks.has(work.workId)) {
      continue;
    }
    if (
      affectedWorkspaces.has(work.workspaceId) ||
      work.boundaryRegions.some((boundary) =>
        overlapsAnyChanged(boundary, input.changedRegions),
      )
    ) {
      seenWorks.add(work.workId);
      affectedWorkIds.push(work.workId);
    }
  }

  const affectedClaimIds: string[] = [];
  const seenClaims = new Set<string>();
  for (const claim of input.activeClaims) {
    if (seenClaims.has(claim.claimId)) {
      continue;
    }
    if (
      affectedWorkspaces.has(claim.workspaceId) ||
      claim.regions.some((region) =>
        overlapsAnyChanged(region, input.changedRegions),
      )
    ) {
      seenClaims.add(claim.claimId);
      affectedClaimIds.push(claim.claimId);
    }
  }

  return { affectedWorkspaceIds, affectedWorkIds, affectedClaimIds };
};
