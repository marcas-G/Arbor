import { describe, expect, it } from "vitest";
import type { Verification, VerificationVerdict } from "../src/index.js";
import {
  concludeVerification,
  EvidenceId,
  isVerificationConcluded,
  isVerificationOpen,
  parse,
  recordVerificationEvidence,
  startVerification,
  VerificationId,
  WorkId,
  WorkRevision,
} from "../src/index.js";

const verificationId = parse(VerificationId)(
  "ver_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ab");
const evidenceId = parse(EvidenceId)(
  "evd_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const targetWorkRevision = parse(WorkRevision)(7);

const mission = {
  goal: "verify domain kernel",
  criteria: ["pure", "typed"],
  riskRequirements: ["no infra import"],
};

const start = (id = verificationId): Verification =>
  startVerification({
    verificationId: id,
    workId,
    targetWorkRevision,
    missionSnapshot: mission,
  });

const describeVerdict = (verdict: VerificationVerdict): string => {
  switch (verdict) {
    case "Pass":
      return "pass";
    case "Fail":
      return "fail";
    case "Unknown":
      return "unknown";
    default: {
      const unreachable: never = verdict;
      return unreachable;
    }
  }
};

describe("verification aggregate", () => {
  it("has exactly three verdict variants", () => {
    expect(describeVerdict("Pass")).toBe("pass");
    expect(describeVerdict("Fail")).toBe("fail");
    expect(describeVerdict("Unknown")).toBe("unknown");
  });

  it("starts Open and records evidence while Open", () => {
    const started = start();
    expect(isVerificationOpen(started)).toBe(true);
    expect(isVerificationConcluded(started)).toBe(false);
    const recorded = recordVerificationEvidence(started, evidenceId);
    expect(recorded.ok).toBe(true);
    if (recorded.ok) {
      expect(recorded.value.state.status).toBe("Open");
      expect(recorded.value.evidenceRefs).toEqual([evidenceId]);
      expect(started.evidenceRefs).toEqual([]);
    }
  });

  it("concludes with a readonly verdict and binds the target revision", () => {
    const result = concludeVerification(start(), "Pass");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state).toEqual({
        status: "Concluded",
        verdict: "Pass",
      });
      expect(result.value.targetWorkRevision).toBe(targetWorkRevision);
      expect(isVerificationConcluded(result.value)).toBe(true);
    }
  });

  it("rejects mutating a concluded verdict", () => {
    const concluded = concludeVerification(start(), "Fail");
    expect(concluded.ok).toBe(true);
    if (!concluded.ok) {
      throw new Error("expected conclude to succeed");
    }
    const reconclude = concludeVerification(concluded.value, "Pass");
    expect(reconclude.ok).toBe(false);
    if (!reconclude.ok) {
      expect(reconclude.error._tag).toBe("TerminalLifecycleMutation");
    }
    const recordAfter = recordVerificationEvidence(concluded.value, evidenceId);
    expect(recordAfter.ok).toBe(false);
    if (!recordAfter.ok) {
      expect(recordAfter.error._tag).toBe("TerminalLifecycleMutation");
    }
  });

  it("creates a distinct identity for re-verification", () => {
    const other = start(
      parse(VerificationId)("ver_018f2b3c-4d5e-7abc-8def-0123456789ac"),
    );
    expect(other.verificationId).not.toBe(verificationId);
    expect(other.workId).toBe(workId);
    expect(other.targetWorkRevision).toBe(targetWorkRevision);
  });
});
