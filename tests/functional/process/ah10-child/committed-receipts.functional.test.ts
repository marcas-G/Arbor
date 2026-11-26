import { describe, it } from "vitest";
import {
  ah10PhaseCommitSide,
  ah10PhasePinOldAction,
} from "./phases-commit-side.js";
import { ah10PhaseFormation } from "./phases-formation.js";
import {
  ah10PhaseLeaseQualification,
  ah10PhaseNewGeneration,
} from "./phases-recovery.js";
import { ah10PhaseVerdict } from "./phases-verdict.js";
import { createAh10ScenarioState } from "./support.js";

describe("AH10 direct-child AssignWork generation takeover", () => {
  it.each([
    "committed",
    "corrupt-sibling",
    "approval-committed",
    "approval-fencing-before",
  ] as const)(
    "takes over direct-child AssignWork after gen0 %s its command boundary",
    async (rawCrashSide) => {
      const s = createAh10ScenarioState(rawCrashSide);
      await ah10PhaseFormation(s);
      await ah10PhasePinOldAction(s);
      await ah10PhaseCommitSide(s);
      await ah10PhaseLeaseQualification(s);
      await ah10PhaseNewGeneration(s);
      await ah10PhaseVerdict(s);
    },
    180_000,
  );
});
