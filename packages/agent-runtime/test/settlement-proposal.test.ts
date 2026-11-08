import { describe, expect, it } from "vitest";
import { settlementProposal } from "../src/settlement-proposal.js";

describe("settlement proposal", () => {
  it("preserves the immutable settlement value", () => {
    const settlement = {
      _tag: "Interrupted",
      result: { _tag: "ControlledInterruption", reason: "test" },
    } as const;
    expect(settlementProposal(settlement)).toEqual({
      _tag: "SettlementProposal",
      settlement,
    });
  });
});
