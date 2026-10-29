import type {
  BoundedObservation,
  ReconciliationProofRef,
  RecordedReconciliationFact,
  ToolReconciliationRequest,
  ToolReconciliationResult,
} from "@arbor/ports";
import { validateToolReconciliationResult } from "@arbor/ports";

export type ReconciledNoEffectReasonCode =
  | "AuthoritySnapshotChanged"
  | "ResourceSnapshotChanged"
  | "ApprovalNoLongerAuthorized"
  | "StopRequested"
  | "ReplayLimitReached";

/** The small P39 candidate handed to P4 for one atomic terminal transaction.
 * P4 owns the canonical Artifact/resultRef and P40 observation envelope. */
export interface P39ReconciledNoEffectCandidate {
  readonly settlement: {
    readonly _tag: "ReconciledNoEffect";
    readonly reasonCode: ReconciledNoEffectReasonCode;
    readonly reconciliationFactRef: string;
  };
  readonly observation: BoundedObservation;
  readonly resultRef: null;
  readonly reconciliationSelection: {
    readonly attemptNo: 0 | 1;
    readonly factId: string;
  };
}

const isReasonCode = (value: unknown): value is ReconciledNoEffectReasonCode =>
  value === "AuthoritySnapshotChanged" ||
  value === "ResourceSnapshotChanged" ||
  value === "ApprovalNoLongerAuthorized" ||
  value === "StopRequested" ||
  value === "ReplayLimitReached";

const isBoundedObservation = (value: unknown): value is BoundedObservation => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("text" in value) ||
    !("truncated" in value)
  ) {
    return false;
  }
  return (
    typeof value.text === "string" &&
    value.text.length <= 2000 &&
    typeof value.truncated === "boolean"
  );
};

const exactNotOccurredFact = (
  request: ToolReconciliationRequest,
  result: ToolReconciliationResult,
  recorded: RecordedReconciliationFact,
): boolean => {
  if (
    result._tag !== "NotOccurred" ||
    !validateToolReconciliationResult(request, result) ||
    recorded.outcome !== "NotOccurred" ||
    recorded.factDisposition !== "RecoveryInput" ||
    recorded.invocationId !== request.invocationId ||
    recorded.attemptNo !== request.attemptNo ||
    !/^[0-9a-f]{64}$/u.test(recorded.factId)
  ) {
    return false;
  }
  const proof: ReconciliationProofRef = result.proof;
  return (
    proof.invocationId === recorded.invocationId &&
    proof.attemptNo === recorded.attemptNo &&
    proof.bindingSha256 === request.bindingSha256 &&
    proof.profileHash === request.profileHash &&
    proof.effectKey === request.effectKey
  );
};

/** Converts only the immutable fact returned by recording an authoritative,
 * exact-attempt NotOccurred proof into a terminal P39 candidate. Callers must
 * still revalidate current authority/resource/approval/Stop and lease state in
 * the fenced transaction immediately before asking P4 to settle it. */
export const p39ReconciledNoEffectCandidate = (input: {
  readonly request: ToolReconciliationRequest;
  readonly result: ToolReconciliationResult;
  readonly recordedFact: RecordedReconciliationFact;
  readonly reasonCode: ReconciledNoEffectReasonCode;
  readonly observation: BoundedObservation;
}): P39ReconciledNoEffectCandidate | null => {
  if (
    !exactNotOccurredFact(input.request, input.result, input.recordedFact) ||
    !isReasonCode(input.reasonCode) ||
    !isBoundedObservation(input.observation)
  ) {
    return null;
  }
  const factId = input.recordedFact.factId;
  return {
    settlement: {
      _tag: "ReconciledNoEffect",
      reasonCode: input.reasonCode,
      reconciliationFactRef: factId,
    },
    observation: input.observation,
    resultRef: null,
    reconciliationSelection: {
      attemptNo: input.recordedFact.attemptNo,
      factId,
    },
  };
};
