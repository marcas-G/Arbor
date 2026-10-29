import { describe, expect, it } from "vitest";
import {
  isGovernanceKind,
  parseControlApprovalEntryKey,
  parseExecutableApprovalEntry,
  parseGovernanceEntryKey,
} from "../src/queue/governance-target.js";

/**
 * W-00 proof ③ (mechanical): the frozen inbox DTO structurally recovers
 * proposalId + proposalRevision from the deterministic `gov:` entryKey —
 * CONCLUSION: DecisionCards MAY offer RecordDecision in Web v1 (strict
 * fail-closed parsing; never guess from the presentation summary).
 */
describe("W-00 proof: governance queue action-target", () => {
  it("recovers exact control approval identity and revision", () => {
    expect(
      parseControlApprovalEntryKey("cap:cap_deadbeef:3", "Governance"),
    ).toEqual({ approvalId: "cap_deadbeef", approvalRevision: 3 });
    expect(
      parseControlApprovalEntryKey("cap:cap_deadbeef:3", "Message"),
    ).toBeNull();
  });
  it("binds eap: by its final revision and full opaque approval ID", () => {
    const approvalId = "eap:prj_1:exe_1:4:0:0:la_1:call_1:tinv_1";
    const target = {
      kind: "ExecutableApproval",
      approvalId,
      revision: 3,
      executionId: "exe_1",
      toolName: "shell",
      toolVersion: "1.0.0",
      validatedArgumentsPreview: "{}",
      targetResourceSpaceIds: [],
      capabilities: ["shell:exec"],
      sideEffectSemantics: "NonIdempotent",
      expiresAt: "2099-01-01T00:00:00.000Z",
      actionDigest: "sha256:abc",
    } as const;
    expect(
      parseExecutableApprovalEntry(`eap:${approvalId}:3`, "Governance", target),
    ).toEqual(target);
    expect(
      parseExecutableApprovalEntry(`eap:${approvalId}:4`, "Governance", target),
    ).toBeNull();
    expect(
      parseExecutableApprovalEntry(`eap:${approvalId}:3`, "Message", target),
    ).toBeNull();
    expect(
      parseExecutableApprovalEntry("cap:cap_deadbeef:3", "Governance", target),
    ).toBeNull();
    expect(
      parseExecutableApprovalEntry(`eap:${approvalId}:3`, "Governance", {
        ...target,
        approvalId: "eap:foreign",
      }),
    ).toBeNull();
  });
  it("recovers proposalId + revision from a well-formed Governance entryKey", () => {
    expect(
      parseGovernanceEntryKey(
        "gov:fpr_018f6a2e-0000-7000-8000-00000000000f:3",
        "Governance",
      ),
    ).toEqual({
      proposalId: "fpr_018f6a2e-0000-7000-8000-00000000000f",
      proposalRevision: 3,
    });
  });

  it("rejects non-Governance kinds regardless of key shape", () => {
    expect(parseGovernanceEntryKey("gov:fpr_x:1", "Message")).toBeNull();
    expect(parseGovernanceEntryKey("gov:fpr_x:1", "HumanInput")).toBeNull();
    expect(isGovernanceKind("Governance")).toBe(true);
  });

  it("fails closed on malformed keys (read-only degradation, never a guess)", () => {
    expect(parseGovernanceEntryKey("msg:ses_1", "Governance")).toBeNull();
    expect(parseGovernanceEntryKey("gov:", "Governance")).toBeNull();
    expect(parseGovernanceEntryKey("gov:fpr_x", "Governance")).toBeNull();
    expect(parseGovernanceEntryKey("gov:fpr_x:", "Governance")).toBeNull();
    expect(parseGovernanceEntryKey("gov:fpr_x:abc", "Governance")).toBeNull();
    expect(
      parseGovernanceEntryKey("gov:fpr_x:1:extra", "Governance"),
    ).toBeNull();
    expect(parseGovernanceEntryKey("", "Governance")).toBeNull();
  });

  it("never parses the presentation summary string", () => {
    // The summary is display text; identity recovery must come ONLY from
    // the structured entryKey — a summary containing an id must not bind.
    expect(
      parseGovernanceEntryKey(
        'formation proposal "fpr_x" revision 2 awaiting human decision',
        "Governance",
      ),
    ).toBeNull();
  });
});
