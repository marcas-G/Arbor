import { describe, expect, it } from "vitest";
import {
  decideRepair,
  type RepairPolicy,
} from "../packages/agent-runtime/src/index.js";

const policy: RepairPolicy = { maxRepairs: 2 };

describe("P3 bounded output-contract repair", () => {
  it("repairs with an A4 fragment while attempts remain", () => {
    const decision = decideRepair(
      policy,
      0,
      "agent-directive-v1",
      "missing claim",
    );
    expect(decision._tag).toBe("Repair");
    if (decision._tag === "Repair") {
      expect(decision.repairFragment.authorityRole).toBe("A4");
      expect(decision.repairFragment.contentRef).toContain(
        "agent-directive-v1",
      );
    }
  });

  it("settles Failed when repair is exhausted", () => {
    const decision = decideRepair(policy, 2, "agent-directive-v1", "bad json");
    expect(decision._tag).toBe("Exhausted");
    if (decision._tag === "Exhausted") {
      expect(decision.settlement._tag).toBe("Failed");
    }
  });

  it("settles Interrupted(RuntimeSafetyStop) for a looping signal", () => {
    const decision = decideRepair(
      policy,
      2,
      "agent-directive-v1",
      "repeated loop detected",
    );
    expect(decision._tag).toBe("Exhausted");
    if (decision._tag === "Exhausted") {
      expect(decision.settlement._tag).toBe("Interrupted");
      if (decision.settlement._tag === "Interrupted") {
        expect(decision.settlement.result._tag).toBe("ControlledInterruption");
      }
    }
  });
});
