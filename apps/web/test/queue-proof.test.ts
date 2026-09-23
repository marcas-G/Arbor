import { describe, expect, it } from "vitest";
import {
  isGovernanceKind,
  parseGovernanceEntryKey,
} from "../src/queue/governance-target.js";

/**
 * W-00 proof ③ (mechanical): the frozen inbox DTO structurally recovers
 * proposalId + proposalRevision from the deterministic `gov:` entryKey —
 * CONCLUSION: DecisionCards MAY offer RecordDecision in Web v1 (strict
 * fail-closed parsing; never guess from the presentation summary).
 */
describe("W-00 proof: governance queue action-target", () => {
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
