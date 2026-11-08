import { describe, expect, it } from "vitest";
import { decideActionTransition } from "../src/step-transition.js";

describe("step action transition", () => {
  it("stales before effect classification", () => {
    expect(
      decideActionTransition({
        freshness: "Stale",
        effect: "Applied",
        settlementRequested: false,
      }),
    ).toEqual({ _tag: "SkippedStale" });
  });
  it("preserves unknown outcomes as a hard gate", () => {
    expect(
      decideActionTransition({
        freshness: "Fresh",
        effect: "Unknown",
        settlementRequested: false,
      }),
    ).toEqual({ _tag: "OutcomeUnknown" });
  });
  it("distinguishes rejection and applied settlement", () => {
    expect(
      decideActionTransition({
        freshness: "Fresh",
        effect: "Rejected",
        settlementRequested: false,
      }),
    ).toEqual({ _tag: "TerminalRejected" });
    expect(
      decideActionTransition({
        freshness: "Fresh",
        effect: "Applied",
        settlementRequested: true,
      }),
    ).toEqual({ _tag: "Applied", next: "Settle" });
  });
});
