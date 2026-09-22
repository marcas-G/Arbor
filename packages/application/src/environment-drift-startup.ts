import type { ProjectId, ResourceAddress } from "@arbor/domain";
import type {
  EnvironmentChangeCause,
  EnvironmentObservation,
  RecordEnvironmentChangeOutcome,
} from "@arbor/ports";
import { Effect } from "effect";
import type {
  DriftError,
  DriftReport,
  EnvironmentDriftDeps,
} from "./environment-drift.js";
import { probeDrift } from "./environment-drift.js";

/**
 * P11 `11` §1 (GQ2) — the STARTUP drift probe seam.
 *
 * Wiring point (frozen contract): the P9 `startupRecovery` pass appends
 * this probe AFTER the canonical settle (step 6) and BEFORE the
 * runnable-set rebuild (step 7), so an auto-submitted change wakes
 * candidates within the same pass. This module provides the function
 * ONLY — recovery-drive.ts is not modified here (wiring belongs to
 * P11-012 acceptance / main-session wiring).
 *
 * Auto-submit of RecordEnvironmentChange happens ONLY under explicit
 * configuration (default OFF — P11 `05` §1); with autoSubmit off the
 * DriftReport is returned for Inbox/Attention surfacing (P10 face) and
 * convergence stays with governance (CI-4).
 */

export type DriftSubmissionError =
  | { readonly _tag: "ChangePersistenceFailure"; readonly cause: unknown }
  | { readonly _tag: "ReProbeFailed"; readonly cause: unknown };

/** The `record` face of RecordEnvironmentChange, transaction requirement
 * already satisfied by the wiring. */
export interface DriftSubmissionFace {
  readonly record: (
    observation: EnvironmentObservation,
    cause: EnvironmentChangeCause,
  ) => Effect.Effect<
    RecordEnvironmentChangeOutcome,
    DriftSubmissionError,
    never
  >;
}

export interface StartupDriftDeps extends EnvironmentDriftDeps {
  /** The governed submission channel; absent => autoSubmit degrades to
   * report-only (typed outcome, never a silent failure). */
  readonly rec?: DriftSubmissionFace;
}

export interface StartupDriftOptions {
  /** Default false (P11 `05`: no auto-submit by default). */
  readonly autoSubmit?: boolean;
}

export type DriftSubmission =
  | { readonly _tag: "NotRequired" }
  | { readonly _tag: "SkippedNoSubmissionService" }
  | {
      readonly _tag: "Submitted";
      readonly outcome: RecordEnvironmentChangeOutcome;
    };

export interface StartupDriftOutcome {
  readonly report: DriftReport;
  readonly submission: DriftSubmission;
}

/** Probe once at startup; on Drift, optionally submit the governed
 * RecordEnvironmentChange (cause "ExternalDrift", expectedRevision =
 * candidateRevision via the observation's observedRevision — the anchor
 * CAS check inside REC is the concurrency fence, not this probe). */
export const startupDriftProbe = (
  projectId: ProjectId,
  addresses: ReadonlyArray<ResourceAddress>,
  deps: StartupDriftDeps,
  options?: StartupDriftOptions,
): Effect.Effect<
  StartupDriftOutcome,
  DriftError | DriftSubmissionError,
  never
> =>
  Effect.gen(function* () {
    const report = yield* probeDrift(projectId, addresses, deps);

    if (options?.autoSubmit !== true || report._tag !== "Drift") {
      return { report, submission: { _tag: "NotRequired" } };
    }

    const rec = deps.rec;
    if (rec === undefined) {
      return { report, submission: { _tag: "SkippedNoSubmissionService" } };
    }

    const outcome = yield* rec.record(
      {
        projectId,
        observedRevision: report.candidateRevision,
        fingerprint: report.candidateFingerprint,
        snapshotBlobRef: report.candidateSnapshotBlobRef,
        changedRegions: report.changedRegions,
      },
      "ExternalDrift",
    );

    return { report, submission: { _tag: "Submitted", outcome } };
  });
