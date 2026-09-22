import type { ProjectId, WorkspaceId } from "@arbor/domain";
import { Effect } from "effect";
import type { AttentionRow } from "./attention.js";
import type { ProjectionReadError } from "./errors.js";
import type { InboxReconcileReport } from "./inbox-reconcile.js";

// --- P10 `04` §1 (GQ2 handover from P9): rebuild-at-scale orchestration ----
//
// The orchestrator CONFIGURES AND USES the P9-hardened generic rebuild —
// it changes no generic mechanism. Checkpoints ride the P1 consumer
// offsets face (per-view prefixed consumer ids); the drift rewind
// consumes the P9-closure corrected form `floor−1` (DID v1.12 G2a)
// unchanged. Journal pruning/horizon ownership stays P1 `04` — this
// module holds read faces only (prunedFloor is a read), never a prune.

/** Frozen replay dependency order (P10 `04` §1.3): raw fact views first,
 * EffectiveFacts after them, Attention LAST. Tree/Usage are canonical-
 * state aggregates checkpointed between EffectiveFacts and Attention. */
export const REBUILD_STAGE_ORDER = [
  "raw-facts",
  "effective-facts",
  "tree",
  "usage",
  "attention",
] as const;

export type RebuildStage = (typeof REBUILD_STAGE_ORDER)[number];

/** Triggers (P10 `04` §1.3): startup (after the P2 nine-step pass step 8),
 * explicit operator command, detected drift (watermark < pruned floor ⇒
 * forced reset). */
export type RebuildTrigger =
  | "startup-after-nine-step"
  | "explicit-operator"
  | "drift-detected";

export interface RebuildCatchUpResult {
  readonly fromSequence: number;
  readonly lastSequence: number;
  readonly applied: number;
  readonly quarantined: number;
}

export interface RebuildStageReport {
  readonly stage: RebuildStage;
  readonly fromWatermark: number;
  readonly toWatermark: number;
  readonly prunedFloor: number;
  /** watermark < pruned floor at entry ⇒ forced reset executed. */
  readonly driftReset: boolean;
  /** The P9-closure corrected rewind target (floor−1, clamped ≥ 0) —
   * only meaningful when driftReset. */
  readonly resetRewoundTo: number | null;
  readonly replayed: number;
}

export interface RebuildReport {
  readonly projectId: ProjectId;
  readonly trigger: RebuildTrigger;
  readonly stages: ReadonlyArray<RebuildStageReport>;
  /** P10 `04` §2 Inbox face: state reconciliation (audit pass) per
   * workspace — drift report only, repair is operator-triggered via the
   * P6 admission paths. */
  readonly inboxReconciliation: ReadonlyArray<InboxReconcileReport>;
}

export interface RebuildDriftItem {
  readonly stage: RebuildStage;
  readonly watermark: number;
  readonly prunedFloor: number;
}

/** Injected faces — the orchestration objects. Every write-capable face
 * (catch-up apply-then-advance, forced reset, generic rebuild) is an
 * injected function the host binds to the P9 generic consumer; this
 * package owns no storage and never writes canonical state. */
export interface RebuildOrchestrationDeps {
  /** Pruned floor = MIN(sequence) of retained domain_events (P1 `04`
   * ownership — read-only observation here). */
  readonly prunedFloor: (
    projectId: ProjectId,
  ) => Effect.Effect<number, ProjectionReadError>;
  readonly journalLastSequence: (
    projectId: ProjectId,
  ) => Effect.Effect<number, ProjectionReadError>;
  /** The stage's persisted applied-watermark (per-view prefixed P1
   * consumer offset). */
  readonly readViewCheckpoint: (
    stage: RebuildStage,
    projectId: ProjectId,
  ) => Effect.Effect<number, ProjectionReadError>;
  /** Checkpointed catch-up: apply-then-advance batch (P1 `05` §4) —
   * resumes from checkpoint + 1 (readAfter is exclusive of the offset and
   * starts at the retained floor), never below the pruned floor. */
  readonly catchUpView: (
    stage: RebuildStage,
    projectId: ProjectId,
    batchSize?: number,
  ) => Effect.Effect<RebuildCatchUpResult, ProjectionReadError>;
  /** Drift forced-reset face: reset the stage's materialized rows and
   * rewind the checkpoint to the corrected form floor−1 (clamped ≥ 0 —
   * DID v1.12 G2a; P1 `05` §6 full-replay semantics restored). The full
   * retained replay then rides catchUpView. */
  readonly forceResetView: (
    stage: RebuildStage,
    projectId: ProjectId,
  ) => Effect.Effect<{ readonly rewoundTo: number }, ProjectionReadError>;
  /** The P9-hardened generic rebuild, consumed unchanged: reset + rewind
   * to floor−1 + full retained replay (used for the non-drift explicit /
   * startup full-rebuild paths where offset ≥ floor). */
  readonly rebuildView: (
    stage: RebuildStage,
    projectId: ProjectId,
  ) => Effect.Effect<
    { readonly replayed: number; readonly floor: number },
    ProjectionReadError
  >;
  readonly listWorkspaces: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly workspaceId: WorkspaceId }>,
    ProjectionReadError
  >;
  readonly reconcileInbox: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<InboxReconcileReport, ProjectionReadError>;
}

const DEFAULT_BATCH_SIZE = 100;

/** Detected drift (P10 `04` §1.3): any materialized stage whose persisted
 * watermark sits below the pruned floor. */
export const detectRebuildDrift = (
  deps: RebuildOrchestrationDeps,
  projectId: ProjectId,
): Effect.Effect<ReadonlyArray<RebuildDriftItem>, ProjectionReadError> =>
  Effect.gen(function* () {
    const floor = yield* deps.prunedFloor(projectId);
    const drifted: Array<RebuildDriftItem> = [];
    for (const stage of REBUILD_STAGE_ORDER) {
      const watermark = yield* deps.readViewCheckpoint(stage, projectId);
      if (watermark < floor) {
        drifted.push({ stage, watermark, prunedFloor: floor });
      }
    }
    return drifted;
  });

const drainCatchUp = (
  deps: RebuildOrchestrationDeps,
  stage: RebuildStage,
  projectId: ProjectId,
  fromWatermark: number,
): Effect.Effect<
  { replayed: number; toWatermark: number },
  ProjectionReadError
> =>
  Effect.gen(function* () {
    let replayed = 0;
    let watermark = fromWatermark;
    for (;;) {
      const result = yield* deps.catchUpView(
        stage,
        projectId,
        DEFAULT_BATCH_SIZE,
      );
      replayed += result.applied;
      watermark = result.lastSequence;
      if (result.applied + result.quarantined === 0) {
        break;
      }
    }
    return { replayed, toWatermark: watermark };
  });

/** The rebuild orchestrator (P10 `04` §1.3). Per stage, in the frozen
 * replay dependency order: drift check (watermark < pruned floor ⇒
 * forced reset via the corrected floor−1 rewind, then full retained
 * catch-up); else a full rebuild (startup/explicit triggers) through the
 * P9 generic rebuild, or plain checkpointed catch-up (drift-detected
 * trigger with no drift found). Closes with the Inbox state
 * reconciliation audit over every workspace. */
export const orchestrateRebuild = (
  deps: RebuildOrchestrationDeps,
  input: { readonly projectId: ProjectId; readonly trigger: RebuildTrigger },
): Effect.Effect<RebuildReport, ProjectionReadError> =>
  Effect.gen(function* () {
    const floor = yield* deps.prunedFloor(input.projectId);
    const stageReports: Array<RebuildStageReport> = [];
    for (const stage of REBUILD_STAGE_ORDER) {
      const checkpoint = yield* deps.readViewCheckpoint(stage, input.projectId);
      if (checkpoint < floor) {
        const reset = yield* deps.forceResetView(stage, input.projectId);
        const drained = yield* drainCatchUp(
          deps,
          stage,
          input.projectId,
          reset.rewoundTo,
        );
        stageReports.push({
          stage,
          fromWatermark: checkpoint,
          toWatermark: drained.toWatermark,
          prunedFloor: floor,
          driftReset: true,
          resetRewoundTo: reset.rewoundTo,
          replayed: drained.replayed,
        });
        continue;
      }
      if (input.trigger !== "drift-detected") {
        const rebuilt = yield* deps.rebuildView(stage, input.projectId);
        const toWatermark = yield* deps.readViewCheckpoint(
          stage,
          input.projectId,
        );
        stageReports.push({
          stage,
          fromWatermark: checkpoint,
          toWatermark,
          prunedFloor: floor,
          driftReset: false,
          resetRewoundTo: null,
          replayed: rebuilt.replayed,
        });
        continue;
      }
      const caughtUp = yield* drainCatchUp(
        deps,
        stage,
        input.projectId,
        checkpoint,
      );
      stageReports.push({
        stage,
        fromWatermark: checkpoint,
        toWatermark: caughtUp.toWatermark,
        prunedFloor: floor,
        driftReset: false,
        resetRewoundTo: null,
        replayed: caughtUp.replayed,
      });
    }
    const workspaces = yield* deps.listWorkspaces(input.projectId);
    const inboxReconciliation: Array<InboxReconcileReport> = [];
    for (const workspace of workspaces) {
      inboxReconciliation.push(
        yield* deps.reconcileInbox(workspace.workspaceId),
      );
    }
    return {
      projectId: input.projectId,
      trigger: input.trigger,
      stages: stageReports,
      inboxReconciliation,
    };
  });

/** Startup trigger hook (P10 `04` §1.3): the host wires this AFTER the
 * P2 nine-step recovery pass step 8 — the orchestrator owns no boot
 * sequence, it only declares the attachment point. */
export const makeStartupRebuildHook =
  (deps: RebuildOrchestrationDeps) =>
  (projectId: ProjectId): Effect.Effect<RebuildReport, ProjectionReadError> =>
    orchestrateRebuild(deps, {
      projectId,
      trigger: "startup-after-nine-step",
    });

/** Explicit operator command trigger. */
export const operatorRebuild = (
  deps: RebuildOrchestrationDeps,
  projectId: ProjectId,
): Effect.Effect<RebuildReport, ProjectionReadError> =>
  orchestrateRebuild(deps, { projectId, trigger: "explicit-operator" });

/** Detected-drift trigger: detect first, then orchestrate with the drift
 * trigger (drifted stages take the forced-reset path by construction). */
export const rebuildOnDetectedDrift = (
  deps: RebuildOrchestrationDeps,
  projectId: ProjectId,
): Effect.Effect<
  {
    readonly drift: ReadonlyArray<RebuildDriftItem>;
    readonly report: RebuildReport;
  },
  ProjectionReadError
> =>
  Effect.gen(function* () {
    const drift = yield* detectRebuildDrift(deps, projectId);
    const report = yield* orchestrateRebuild(deps, {
      projectId,
      trigger: "drift-detected",
    });
    return { drift, report };
  });

// --- RB-4 per-view query-correctness assertion helper (P10 `04` §1.4) ------
//
// After any rebuild path the projection must reach the same state as
// incremental application from the same events — asserted per view by
// comparing the rebuild-path derive against the incremental-path derive.

export interface ProjectionStateMismatch {
  readonly view: string;
  readonly path: string;
  readonly rebuilt: unknown;
  readonly incremental: unknown;
}

export interface ProjectionStateComparison {
  readonly view: string;
  readonly equal: boolean;
  readonly mismatches: ReadonlyArray<ProjectionStateMismatch>;
}

const MAX_MISMATCHES = 8;

const canonical = (value: unknown): string => JSON.stringify(value);

const collect = (
  view: string,
  path: string,
  rebuilt: unknown,
  incremental: unknown,
  sink: Array<ProjectionStateMismatch>,
): void => {
  if (sink.length >= MAX_MISMATCHES) {
    return;
  }
  if (canonical(rebuilt) === canonical(incremental)) {
    return;
  }
  if (Array.isArray(rebuilt) && Array.isArray(incremental)) {
    if (rebuilt.length !== incremental.length) {
      sink.push({
        view,
        path: `${path}.length`,
        rebuilt: rebuilt.length,
        incremental: incremental.length,
      });
      return;
    }
    for (let index = 0; index < rebuilt.length; index += 1) {
      collect(
        view,
        `${path}[${index}]`,
        rebuilt[index],
        incremental[index],
        sink,
      );
    }
    return;
  }
  if (
    typeof rebuilt === "object" &&
    rebuilt !== null &&
    typeof incremental === "object" &&
    incremental !== null &&
    !Array.isArray(rebuilt) &&
    !Array.isArray(incremental)
  ) {
    const keys = [
      ...new Set([...Object.keys(rebuilt), ...Object.keys(incremental)]),
    ].sort();
    for (const key of keys) {
      collect(
        view,
        path === "" ? key : `${path}.${key}`,
        (rebuilt as Record<string, unknown>)[key],
        (incremental as Record<string, unknown>)[key],
        sink,
      );
    }
    return;
  }
  sink.push({ view, path, rebuilt, incremental });
};

/** Per-view rebuild-vs-incremental state comparison (RB-4): structural
 * walk collecting bounded mismatch detail; `equal` is the verdict. */
export const compareProjectionState = (
  view: string,
  rebuilt: unknown,
  incremental: unknown,
): ProjectionStateComparison => {
  const mismatches: Array<ProjectionStateMismatch> = [];
  collect(view, "", rebuilt, incremental, mismatches);
  return { view, equal: mismatches.length === 0, mismatches };
};

// --- P10 `04` §1.2 projection-side retention (view lifetimes only) ---------
//
// Retention here bounds PROJECTION view state only (transcript paging
// windows, attention-row lifetime after the underlying fact is
// superseded, consumed-inbox summary aging). Canonical rows are never
// touched and the journal horizon stays P1 `04` — these are pure
// functions over view-shaped rows.

export interface RetentionSplit<T> {
  readonly kept: ReadonlyArray<T>;
  readonly dropped: ReadonlyArray<T>;
}

/** Transcript paging window: the view keeps the most recent `limit`
 * entries per page (older pages stay reachable by cursor — the window
 * bounds the rendered page, not the entry rows). */
export const retainTranscriptWindow = <T>(
  entries: ReadonlyArray<T>,
  window: { readonly limit: number },
): RetentionSplit<T> => {
  if (entries.length <= window.limit) {
    return { kept: entries, dropped: [] };
  }
  const cut = entries.length - window.limit;
  return { kept: entries.slice(cut), dropped: entries.slice(0, cut) };
};

/** Attention-row lifetime ends when the underlying fact is superseded —
 * a row whose dedup identity no longer appears in the live fact set
 * leaves the view (the journal fact stays, P1 `04`). */
export const retainAttentionRows = (
  rows: ReadonlyArray<AttentionRow>,
  liveDedupKeys: ReadonlySet<string> | ReadonlyArray<string>,
): RetentionSplit<AttentionRow> => {
  const live =
    liveDedupKeys instanceof Set ? liveDedupKeys : new Set(liveDedupKeys);
  const kept: Array<AttentionRow> = [];
  const superseded: Array<AttentionRow> = [];
  for (const row of rows) {
    if (live.has(row.dedupKey)) {
      kept.push(row);
    } else {
      superseded.push(row);
    }
  }
  return { kept, dropped: superseded };
};

export interface ConsumedInboxAgingSplit {
  readonly live: ReadonlyArray<{ readonly entryKey: string }>;
  /** Consumed rows older than the cutoff collapse to one summary count
   * (view lifetime bounded); the underlying inbox rows stay canonical
   * (P6 semantics unchanged). */
  readonly agedSummary: { readonly consumedBeforeCutoff: number };
}

/** Consumed-inbox summary aging: consumed entries' view lifetime is
 * bounded — entries consumed strictly before the cutoff render as an
 * aggregate count, never as live view rows. */
export const ageConsumedInboxEntries = (
  rows: ReadonlyArray<{
    readonly entryKey: string;
    readonly consumedAt: string | null;
  }>,
  aging: { readonly cutoff: string },
): ConsumedInboxAgingSplit => {
  const live: Array<{ readonly entryKey: string }> = [];
  let consumedBeforeCutoff = 0;
  for (const row of rows) {
    if (row.consumedAt === null || row.consumedAt >= aging.cutoff) {
      live.push({ entryKey: row.entryKey });
    } else {
      consumedBeforeCutoff += 1;
    }
  }
  return { live, agedSummary: { consumedBeforeCutoff } };
};
