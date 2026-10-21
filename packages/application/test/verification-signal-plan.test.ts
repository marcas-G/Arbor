import { describe, expect, it } from "vitest";
import { deriveVerificationConclusionEffectPlan } from "../src/verification-signal-plan.js";

describe("VerificationConclusion effect plan", () => {
  it.each([
    ["Pass", false, false],
    ["Pass", true, true],
    ["Fail", false, false],
    ["Fail", true, false],
    ["Unknown", false, false],
    ["Unknown", true, false],
  ] as const)(
    "%s with parent=%s yields the frozen effect matrix",
    (verdict, hasParent, parentEffects) => {
      const plan = deriveVerificationConclusionEffectPlan(
        verdict,
        hasParent ? ("ws_parent" as never) : null,
      );
      expect(plan).toEqual({
        releaseMatchingWorkWaits: true,
        reevaluateOwner: verdict !== "Pass",
        admitParentResult: parentEffects,
        wakeParent: parentEffects,
      });
    },
  );
});
