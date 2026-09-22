import type { WorkspaceLifecycle, WorkspaceStatusLabel } from "@arbor/domain";

/** Canonical facts a WorkspaceStatus is a pure projection of (P10 `01` §2;
 * SD §12.2 — no reverse pressure on Domain enums). */
export interface WorkspaceStatusFacts {
  readonly lifecycle: WorkspaceLifecycle;
  /** An active (not settled) WorkspaceMain execution exists. */
  readonly activeMain: boolean;
  /** P7 classification output: runnable ≠ ∅ (DependencyAware source). */
  readonly runnableCount: number;
  /** Active WorkWait ∨ blocking dependency (P7-frozen waiting predicate). */
  readonly hasWaitOrBlocking: boolean;
  /** An open verification pending on one of the workspace's works
   * (P8 one-Open-per-revision facts). */
  readonly openVerification: boolean;
  /** Attention read-model rows targeting this workspace (deduplicated). */
  readonly attentionFacts: number;
}

/** Base status = the exhaustive switch over the frozen five base labels
 * (P10 `01` §2, verbatim):
 *
 * - `executing` ⇔ active main execution exists;
 * - `waiting-runnable` ⇔ no active main ∧ runnable ≠ ∅ (P7 classification);
 * - `waiting-blocked` ⇔ no active main ∧ runnable = ∅ ∧ (active WorkWait ∨
 *   blocking dependency ∨ open verification pending);
 * - `idle` ⇔ no active main ∧ runnable = ∅ ∧ no waits/blocks;
 * - `retired` ⇔ lifecycle Retired (terminal).
 */
export const deriveBaseWorkspaceStatus = (
  facts: Omit<WorkspaceStatusFacts, "attentionFacts">,
): WorkspaceStatusLabel => {
  switch (facts.lifecycle) {
    case "Retired":
      return "retired";
    case "Active":
      if (facts.activeMain) {
        return "executing";
      }
      if (facts.runnableCount > 0) {
        return "waiting-runnable";
      }
      if (facts.hasWaitOrBlocking || facts.openVerification) {
        return "waiting-blocked";
      }
      return "idle";
  }
};

/** `attention-flagged` ⇔ any Attention fact targeting the workspace — an
 * overlay composable with every base label except the terminal `retired`
 * (retired wins; the GAP-01 negative fixture lands there). */
export const applyAttentionOverlay = (
  base: WorkspaceStatusLabel,
  hasAttention: boolean,
): WorkspaceStatusLabel =>
  hasAttention && base !== "retired" ? "attention-flagged" : base;

/** Full frozen label map (P10 `01` §2): base switch + attention overlay. */
export const deriveWorkspaceStatus = (
  facts: WorkspaceStatusFacts,
): WorkspaceStatusLabel =>
  applyAttentionOverlay(
    deriveBaseWorkspaceStatus(facts),
    facts.attentionFacts > 0,
  );
