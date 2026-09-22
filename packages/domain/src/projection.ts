// --- P10 projection vocabulary (P10 `01` §1/§2; DID v1.13 G1) ---

/** ViewId union = the authoritative must-set (Search deferred — P10 `01` §1). */
export type ViewId =
  | "responsibility-tree"
  | "attention"
  | "workspace-detail"
  | "current-work"
  | "verification"
  | "dependency-view"
  | "transcript"
  | "usage"
  | "inbox-view";

export const VIEW_IDS: ReadonlyArray<ViewId> = [
  "responsibility-tree",
  "attention",
  "workspace-detail",
  "current-work",
  "verification",
  "dependency-view",
  "transcript",
  "usage",
  "inbox-view",
];

/** WorkspaceStatus labels frozen from SD §12.2 text (+ retired terminal);
 * attention-flagged is a composable overlay, not a base state. */
export type WorkspaceStatusLabel =
  | "executing"
  | "waiting-runnable"
  | "waiting-blocked"
  | "idle"
  | "retired"
  | "attention-flagged";

export const WORKSPACE_STATUS_LABELS: ReadonlyArray<WorkspaceStatusLabel> = [
  "executing",
  "waiting-runnable",
  "waiting-blocked",
  "idle",
  "retired",
  "attention-flagged",
];

/** HumanInterventionApplied kind union (P10 `06` §1). */
export type HumanInterventionKind =
  | "Steer"
  | "CriticalSteer"
  | "Stop"
  | "GovernanceDecision";

// --- P12 `04` §3.2 UsageCost (E-15) ---
//
// A derived operational value (never canonical state): `Known` requires both
// non-empty usage facts and a versioned price sheet; unknown cost must remain
// `Unknown`, never `0`. Declared here (with the projection vocabulary) because
// it is shared by the `api-contracts` UsageReq DTO and the P12 observability
// derivation; it does not make cost authoritative (DID §10.4.1 unchanged).

export type UsageUnknownReason =
  | "PricingUnavailable"
  | "UsageUnavailable"
  | "PartialUsage";

export type UsageCost =
  | {
      readonly _tag: "Known";
      readonly amount: number;
      readonly currency: string;
      readonly priceSheetVersion: string;
    }
  | { readonly _tag: "Unknown"; readonly reason: UsageUnknownReason };

// --- P10 freshness barrier + query envelope (P10 `03` §2, `05` §1; GQ5) ---

/** Projection-boundary freshness barrier. {minWatermark} is the GQ5 frozen
 * form; maxLag is a contract-level extension of the same mechanism (a
 * watermark expressed as acceptable lag — no new semantics). Reuses the
 * DID §8.19 FreshnessRequirement vocabulary at the projection boundary;
 * P3/P4 action-admission semantics untouched. */
export interface FreshnessRequirement {
  readonly minWatermark?: number | undefined;
  readonly maxLag?: number | undefined;
}

/** GQ5 — every query response carries the journal watermark it reflects and
 * the observable lag against canonical lastSequence (lag = L − w). */
export interface QueryResult<T> {
  readonly value: T;
  readonly watermark: number;
  readonly lag: number;
}
