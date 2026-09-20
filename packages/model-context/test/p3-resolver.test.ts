import { describe, expect, it } from "vitest";
import type { InstructionFragment, PromptSlot } from "../src/index.js";
import {
  canonicalInstructionTrust,
  canRaiseAuthority,
  dataOnlyTrust,
  resolveInstructions,
} from "../src/index.js";

const fragment = (
  identity: string,
  authorityRole: InstructionFragment["authorityRole"],
  options: Partial<InstructionFragment> = {},
): InstructionFragment => ({
  identity,
  revision: 1,
  hash: "h",
  semanticKind: "K",
  source: "Canonical",
  scope: "work-objective",
  authorityRole,
  strength: authorityRole <= "A3" ? "Hard" : "Soft",
  compositionMode: "Constrain",
  activationCondition: "always",
  lifetime: "Protected",
  cacheClass: "Stable",
  budgetClass: "b",
  modelCompatibility: [],
  contentRef: identity,
  ...options,
});

const slots: ReadonlyArray<PromptSlot> = [
  {
    slotId: "work-objective",
    semanticKind: "WorkObjective",
    authorityRole: "A3",
    strength: "Hard",
    compositionMode: "Constrain",
    replaceable: false,
    required: true,
    source: "Canonical",
    retention: "Pinned",
    cacheClass: "Stable",
  },
];

describe("P3 instruction resolver", () => {
  it("suppresses a lower-authority fragment overridden by a Hard higher one", () => {
    const result = resolveInstructions({
      fragments: [fragment("a3", "A3"), fragment("a6", "A6")],
      slots,
    });
    expect(result.effective.map((f) => f.identity)).toEqual(["a3"]);
    expect(result.suppressed.map((f) => f.identity)).toEqual(["a6"]);
    expect(result.conflicts).toContain("AuthorityConflict");
  });

  it("rejects ReplaceScope on a non-replaceable slot", () => {
    const result = resolveInstructions({
      fragments: [
        fragment("replacer", "A5", { compositionMode: "ReplaceScope" }),
      ],
      slots,
    });
    expect(result.effective).toHaveLength(0);
    expect(result.conflicts).toContain("ReplacementConflict");
  });

  it("raises GovernanceBlocked for an unresolvable same-level canonical conflict", () => {
    const result = resolveInstructions({
      fragments: [
        fragment("a", "A3", { contentRef: "x" }),
        fragment("b", "A3", { contentRef: "y" }),
      ],
      slots,
    });
    expect(result.governanceIssues).toHaveLength(1);
  });

  it("prevents DataOnly trust from raising authority", () => {
    expect(canRaiseAuthority(canonicalInstructionTrust)).toBe(true);
    expect(canRaiseAuthority(dataOnlyTrust("ExternalRetrieved"))).toBe(false);
    expect(canRaiseAuthority(dataOnlyTrust("ModelDerived"))).toBe(false);
  });
});
