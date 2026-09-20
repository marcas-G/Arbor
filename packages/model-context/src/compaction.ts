import type { ContextEpochNumber, ExecutionId, SessionId } from "@arbor/domain";
import { COMPACTION_PROGRAM } from "./prompt.js";

/** DID v1.7 §8.13/§9.10; P3 `02` §9 (C2). Compaction is an explicit
 * ProviderTurn type, never an invisible hack. P2 owns the Session/Epoch/
 * Checkpoint persistence seam. */
export const COMPACTION_OUTPUT_CONTRACT = "compaction-result-v1";

export type CompactionReason = "ContextUnsatisfiable" | "BudgetPressure";

export interface CompactionRequest {
  readonly executionId: ExecutionId;
  readonly sessionId: SessionId;
  readonly currentEpoch: ContextEpochNumber;
  readonly reason: CompactionReason;
  readonly programId: string;
  readonly programRevision: number;
  readonly programHash: string;
  readonly outputContractRef: string;
}

export interface CompactionCheckpoint {
  readonly ref: string;
  readonly summaryRef: string;
}

export interface CompactionResult {
  readonly checkpoint: CompactionCheckpoint;
  readonly newEpoch: ContextEpochNumber;
}

export const buildCompactionRequest = (input: {
  readonly executionId: ExecutionId;
  readonly sessionId: SessionId;
  readonly currentEpoch: ContextEpochNumber;
  readonly reason: CompactionReason;
}): CompactionRequest => ({
  executionId: input.executionId,
  sessionId: input.sessionId,
  currentEpoch: input.currentEpoch,
  reason: input.reason,
  programId: COMPACTION_PROGRAM.programId,
  programRevision: COMPACTION_PROGRAM.revision,
  programHash: COMPACTION_PROGRAM.hash,
  outputContractRef: COMPACTION_OUTPUT_CONTRACT,
});

export type CompactionValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly violation: "ModelOutputContractViolation";
      readonly reason: string;
    };

const violation = (reason: string): CompactionValidation => ({
  ok: false,
  violation: "ModelOutputContractViolation",
  reason,
});

/** Output validation for a compaction turn (P3 `02` §9). A malformed result is
 * a `ModelOutputContractViolation` handled by bounded repair (`06` §3). */
export const validateCompactionResult = (
  result: unknown,
  request: CompactionRequest,
): CompactionValidation => {
  if (typeof result !== "object" || result === null) {
    return violation("result is not an object");
  }
  const candidate = result as {
    checkpoint?: { ref?: unknown; summaryRef?: unknown };
    newEpoch?: unknown;
  };
  const ref = candidate.checkpoint?.ref;
  const summaryRef = candidate.checkpoint?.summaryRef;
  if (typeof ref !== "string" || ref.length === 0) {
    return violation("missing checkpoint.ref");
  }
  if (typeof summaryRef !== "string" || summaryRef.length === 0) {
    return violation("missing checkpoint.summaryRef");
  }
  if (
    typeof candidate.newEpoch !== "number" ||
    candidate.newEpoch !== request.currentEpoch + 1
  ) {
    return violation("newEpoch must be currentEpoch + 1");
  }
  return { ok: true };
};
