import { describe, it } from "vitest";
import { v6ePhaseFreshRootDriftVerdict } from "./drift-phase-drift-verdict.js";
import {
  v6ePhaseFirstOutcome,
  v6ePhaseFreshRootPreDrift,
} from "./drift-phase-fresh-root.js";
import { v6ePhaseSecondActionDrift } from "./drift-phase-second-action.js";
import { v6ePhaseSeedAndFirstDecision } from "./drift-phase-seed.js";
import { createV6eScenarioState } from "./support.js";

describe("V6-E V3 exact provider tuple drift across daemon restart", () => {
  it.skipIf(process.platform !== "win32")(
    "preserves P9 terminal semantics and reapproves a fresh root candidate after registry drift",
    async () => {
      const s = createV6eScenarioState();
      await v6ePhaseSeedAndFirstDecision(s);
      await v6ePhaseFirstOutcome(s);
      if (s.p9Terminal) {
        await v6ePhaseFreshRootPreDrift(s);
        await v6ePhaseFreshRootDriftVerdict(s);
        return;
      }
      await v6ePhaseSecondActionDrift(s);
    },
    180_000,
  );
});
