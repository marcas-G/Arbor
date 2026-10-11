import { describe, expect, it } from "vitest";
import {
  type ReconciliationProofRef,
  type ToolReconciliationRequest,
  type ToolReconciliationResult,
  validateToolReconciliationResult,
} from "../src/tool-reconciliation.js";

const request: ToolReconciliationRequest = {
  invocationId: "tin_p39" as never,
  attemptNo: 0,
  bindingSha256: "a".repeat(64),
  profileHash: "b".repeat(64),
  effectKey: "effect-1",
  visibilityScopeSha256: "c".repeat(64),
};

const proof: ReconciliationProofRef = {
  invocationId: request.invocationId,
  attemptNo: 0,
  bindingSha256: request.bindingSha256,
  profileHash: request.profileHash,
  effectKey: request.effectKey,
  sourceRevision: "revision-9",
  sourceWatermark: "watermark-41",
  observedAt: "2026-10-11T00:00:00.000Z",
  visibilityScopeSha256: request.visibilityScopeSha256,
  evidenceRef: "artifact_evidence",
  evidenceSha256: "d".repeat(64),
  finality: {
    _tag: "ExternallyFenced",
    confirmationRef: "fence-ack-42",
    confirmedAt: "2026-10-11T00:00:00.000Z",
  },
};

describe("P39 exact-attempt reconciliation proof boundary", () => {
  it("accepts a final, exact, scoped NotOccurred proof", () => {
    const result: ToolReconciliationResult = { _tag: "NotOccurred", proof };
    expect(validateToolReconciliationResult(request, result)).toBe(true);
  });

  it("rejects empty lookup evidence, stale attempt identity, and missing finality", () => {
    const emptyLookup = {
      ...proof,
      sourceWatermark: "",
    } as ReconciliationProofRef;
    const staleAttempt = { ...proof, attemptNo: 1 } as ReconciliationProofRef;
    const incompleteVisibility = {
      ...proof,
      visibilityScopeSha256: "e".repeat(64),
    } as ReconciliationProofRef;
    const noFinality = { ...proof, finality: undefined } as unknown as ReconciliationProofRef;

    expect(
      validateToolReconciliationResult(request, {
        _tag: "NotOccurred",
        proof: emptyLookup,
      }),
    ).toBe(false);
    expect(
      validateToolReconciliationResult(request, {
        _tag: "NotOccurred",
        proof: staleAttempt,
      }),
    ).toBe(false);
    expect(
      validateToolReconciliationResult(request, {
        _tag: "NotOccurred",
        proof: incompleteVisibility,
      }),
    ).toBe(false);
    expect(
      validateToolReconciliationResult(request, {
        _tag: "NotOccurred",
        proof: noFinality,
      }),
    ).toBe(false);
  });

  it("does not accept Occurred as Success without a reconstructable result ref", () => {
    const forged = {
      _tag: "Occurred",
      proof,
      settlement: "Success",
      resultRef: "",
    } as ToolReconciliationResult;
    expect(validateToolReconciliationResult(request, forged)).toBe(false);
  });
});
