/** Test-only synchronous trace for diagnosing the accepted P41 fact-first
 * Stop recovery branch. Ordinary production composition leaves it absent. */
export type SubmittedDecisionRecoveryQualificationEvent =
  | {
      readonly boundary: "AH10P41RecoveryCandidate";
      readonly executionId: string;
      readonly stopRequested: boolean;
      readonly factPresent: boolean;
      readonly failureCode?: string;
    }
  | {
      readonly boundary: "AH10P41RecoveryLease";
      readonly executionId: string;
      readonly acquired: boolean;
      readonly fencingGeneration?: number;
      readonly errorTag?: string;
    }
  | {
      readonly boundary: "AH10P41StopCloseStage";
      readonly executionId: string;
      readonly stage: string;
      readonly outcome: "pass" | "blocked";
      readonly reason?: string;
      readonly unresolvedP4Effects?: number;
    }
  | {
      readonly boundary: "AH10P41StopSettlement";
      readonly executionId: string;
      readonly resolution: string;
    };

export type SubmittedDecisionRecoveryQualificationProbe = (
  event: SubmittedDecisionRecoveryQualificationEvent,
) => void;

export const RECOVERY_WORKER_ID = "worker:recovery-controller";

/** Crash-restart edge: the previous daemon died mid-flight holding the
 * lease. A fenced settle means the lease is still live — lazy lease expiry
 * owns the takeover; a fenced execution must never crash the daemon. */
export const fencedTakeover = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  ((error as { readonly _tag?: unknown })._tag === "LeaseFencingRejected" ||
    JSON.stringify(error).includes("LeaseFencingRejected"));
