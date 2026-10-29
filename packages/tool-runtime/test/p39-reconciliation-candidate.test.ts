import type {
  RecordedReconciliationFact,
  ToolReconciliationRequest,
  ToolReconciliationResult,
} from "@arbor/ports";
import { describe, expect, it } from "vitest";
import { p39ReconciledNoEffectCandidate } from "../src/p39-reconciliation-candidate.js";

const request: ToolReconciliationRequest = {
  invocationId: "tin_00000000-0000-7000-8000-000000000001" as never,
  attemptNo: 0,
  bindingSha256: "a".repeat(64),
  profileHash: "b".repeat(64),
  effectKey: "effect-key-1",
  visibilityScopeSha256: "c".repeat(64),
};

const notOccurred: ToolReconciliationResult = {
  _tag: "NotOccurred",
  proof: {
    invocationId: request.invocationId,
    attemptNo: 0,
    bindingSha256: request.bindingSha256,
    profileHash: request.profileHash,
    effectKey: request.effectKey,
    sourceRevision: "source-revision-8",
    sourceWatermark: "watermark-11",
    observedAt: "2026-10-11T09:00:00.000Z",
    visibilityScopeSha256: request.visibilityScopeSha256,
    evidenceRef: "art_00000000-0000-7000-8000-000000000002",
    evidenceSha256: "d".repeat(64),
    finality: {
      _tag: "ExternallyFenced",
      confirmationRef: "fence-confirmation-11",
      confirmedAt: "2026-10-11T09:00:00.000Z",
    },
  },
};

const recordedFact: RecordedReconciliationFact = {
  factId: "e".repeat(64),
  invocationId: request.invocationId,
  attemptNo: 0,
  factDisposition: "RecoveryInput",
  outcome: "NotOccurred",
};

describe("P39 ReconciledNoEffect candidate", () => {
  it("carries the exact recorded NotOccurred fact into P4 selection and never invents a result ref", () => {
    const candidate = p39ReconciledNoEffectCandidate({
      request,
      result: notOccurred,
      recordedFact,
      reasonCode: "StopRequested",
      observation: {
        text: "external attempt was fenced before it could occur",
        truncated: false,
      },
    });

    expect(candidate).toEqual({
      settlement: {
        _tag: "ReconciledNoEffect",
        reasonCode: "StopRequested",
        reconciliationFactRef: recordedFact.factId,
      },
      observation: {
        text: "external attempt was fenced before it could occur",
        truncated: false,
      },
      resultRef: null,
      reconciliationSelection: { attemptNo: 0, factId: recordedFact.factId },
    });
  });

  it("does not turn an Occurred proof into a ReconciledNoEffect candidate", () => {
    const candidate = p39ReconciledNoEffectCandidate({
      request,
      result: {
        _tag: "Occurred",
        proof: notOccurred.proof,
        settlement: "Success",
        resultRef: "art_result",
      },
      recordedFact,
      reasonCode: "ReplayLimitReached",
      observation: {
        text: "must not be used to synthesize Success",
        truncated: false,
      },
    });

    expect(candidate).toBeNull();
  });

  it("rejects a fact from another invocation or attempt", () => {
    const candidate = p39ReconciledNoEffectCandidate({
      request,
      result: notOccurred,
      recordedFact: {
        ...recordedFact,
        attemptNo: 1,
      },
      reasonCode: "ApprovalNoLongerAuthorized",
      observation: { text: "proof binding mismatch", truncated: false },
    });

    expect(candidate).toBeNull();
  });

  it("rejects incomplete finality and unbounded candidate text", () => {
    const incompleteFinality: ToolReconciliationResult = {
      _tag: "NotOccurred",
      proof: {
        ...notOccurred.proof,
        finality: {
          _tag: "FinalityHorizonElapsed",
          horizon: "",
          elapsedAt: "2026-10-11T09:00:00.000Z",
        },
      },
    };
    const candidate = p39ReconciledNoEffectCandidate({
      request,
      result: incompleteFinality,
      recordedFact,
      reasonCode: "ResourceSnapshotChanged",
      observation: { text: "x".repeat(2001), truncated: true },
    });

    expect(candidate).toBeNull();
  });
});
