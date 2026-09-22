import type { CanonicalResourceRegion, WorkspaceId } from "@arbor/domain";
import { regionsOverlap } from "@arbor/domain";
import { resourceRegionComparator } from "@arbor/ports";

/** P11 `07` §1 (GQ4): Freshness is the derived half of
 * VerificationState = Verdict × Freshness — an overlay, never a
 * mutation. Everything here is a pure function of its arguments: a
 * concluded verdict row is final (CI-5); drift is surfaced as STALE
 * plus an Attention row, and re-verification is a human/policy
 * decision that creates a new Verification identity (P8 `13` §2).
 * This module has no write path of any kind. */

export type VerificationFreshness = "CURRENT" | "STALE";

/** One RecordEnvironmentChange as the overlay consumes it: the anchor
 * revision it advanced to + its narrow canonical changedRegions
 * (P11-005 input shape). */
export interface EnvironmentChangeFact {
  readonly toRevision: string;
  readonly changedRegions: ReadonlyArray<CanonicalResourceRegion>;
}

/** Freshness input for a concluded Verification (P8 `01` binding:
 * `targetEnvironmentRevision`). `boundRegions` are the resolved
 * canonical regions the mission actually reads (P11 `06` narrow
 * input). When the caller cannot resolve them the rule degrades
 * conservatively — any later revision is STALE (a false alarm beats a
 * silent miss); an explicit empty array means "bound to nothing" and
 * stays CURRENT. */
export interface VerificationFreshnessInput {
  readonly targetEnvironmentRevision: string | null;
  readonly boundRegions?: ReadonlyArray<CanonicalResourceRegion>;
}

/** Freshness input for an ownership claim resolved at a revision
 * (P11 `07` §3 — boundary views ride the same overlay pattern;
 * claims always carry their resolved regions). */
export interface OwnershipClaimFreshnessInput {
  readonly resolvedAtEnvironmentRevision: string;
  readonly regions: ReadonlyArray<CanonicalResourceRegion>;
}

/** Anchor counters advance numerically (P11 `01` §1); equality is
 * already-seen, only strictly-later counts. */
const advancedPast = (toRevision: string, boundRevision: string): boolean =>
  Number(toRevision) > Number(boundRevision);

const isStaleOver = (
  boundRevision: string,
  boundRegions: ReadonlyArray<CanonicalResourceRegion> | undefined,
  changes: ReadonlyArray<EnvironmentChangeFact>,
): boolean =>
  changes.some(
    (change) =>
      advancedPast(change.toRevision, boundRevision) &&
      (boundRegions === undefined ||
        boundRegions.some((bound) =>
          change.changedRegions.some((changed) =>
            regionsOverlap(bound, changed, resourceRegionComparator),
          ),
        )),
  );

/** `07` §1: STALE iff some change advanced past the bound revision AND
 * (narrow) its changedRegions overlap the bound regions. A null bound
 * revision is a purely static review (P8 B-7) — nothing can drift it,
 * so it is forever CURRENT. */
export const verificationFreshness = (
  verification: VerificationFreshnessInput,
  environmentChanges: ReadonlyArray<EnvironmentChangeFact>,
): VerificationFreshness => {
  const boundRevision = verification.targetEnvironmentRevision;
  if (boundRevision === null) {
    return "CURRENT";
  }
  return isStaleOver(
    boundRevision,
    verification.boundRegions,
    environmentChanges,
  )
    ? "STALE"
    : "CURRENT";
};

/** `07` §3: ownership claims resolved at older revisions render their
 * boundary views stale-flagged — same rule, regions required. */
export const ownershipClaimFreshness = (
  claim: OwnershipClaimFreshnessInput,
  environmentChanges: ReadonlyArray<EnvironmentChangeFact>,
): VerificationFreshness =>
  isStaleOver(
    claim.resolvedAtEnvironmentRevision,
    claim.regions,
    environmentChanges,
  )
    ? "STALE"
    : "CURRENT";

/** Attention row for one stale surface (`07` §1 drift consequence):
 * source EnvironmentInvalidation, severity Attention. Pure
 * construction — rendering (bubbling, summary) belongs to the P10
 * read-model, which joins this overlay on read (P7-GAP derived-view
 * pattern; no P10 contract change — the overlay rides existing view
 * inputs). */
export interface EnvironmentInvalidationAttentionRow {
  readonly source: "EnvironmentInvalidation";
  readonly severity: "Attention";
  readonly targetWorkspaceId: WorkspaceId;
  readonly dedupKey: string;
}

/** The stale surface the row points at, plus the revision the
 * invalidating change advanced to. The dedup identity is surface
 * identity × that toRevision — re-deriving the same (surface, change)
 * pair yields the same row (read-side dedup precedent P10 `02` §2). */
export type StaleAttentionSource =
  | {
      readonly kind: "verification";
      readonly verificationId: string;
      readonly targetWorkspaceId: WorkspaceId;
      readonly invalidatingToRevision: string;
    }
  | {
      readonly kind: "ownership-claim";
      readonly claimId: string;
      readonly targetWorkspaceId: WorkspaceId;
      readonly invalidatingToRevision: string;
    };

export const staleAttentionRow = (
  source: StaleAttentionSource,
): EnvironmentInvalidationAttentionRow => {
  const identity =
    source.kind === "verification" ? source.verificationId : source.claimId;
  return {
    source: "EnvironmentInvalidation",
    severity: "Attention",
    targetWorkspaceId: source.targetWorkspaceId,
    dedupKey: `environment-invalidation:${source.kind}:${identity}:${source.invalidatingToRevision}`,
  };
};
