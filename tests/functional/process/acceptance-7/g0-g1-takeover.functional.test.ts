import { describe, it, vi } from "vitest";
import { assertAh7Recovered } from "./assert-recovered.js";
import { convergeAh7Recovery } from "./converge.js";
import {
  admitAh7WorkAndApproveShell,
  reachAh7BoundaryAndCrash,
} from "./drive-to-crash.js";
import { ah7FamilyScenarios, ah7ScenarioTestName } from "./scenarios.js";
import { startAh7Fixture } from "./start-fixture.js";
import { createAh7FixtureLifecycle } from "./support.js";
import { runAh7G0G1TakeoverRecovery } from "./takeover-recovery.js";

const lifecycle = createAh7FixtureLifecycle();

describe("Reconcilable tool intent after process crash", () => {
  vi.setConfig({ testTimeout: 180_000 });
  for (const scenario of ah7FamilyScenarios("g0-g1-takeover")) {
    it(ah7ScenarioTestName(scenario), async () => {
      const setupCtx = await startAh7Fixture(scenario, lifecycle);
      const admittedCtx = await admitAh7WorkAndApproveShell(setupCtx);
      const crashCtx = await reachAh7BoundaryAndCrash(admittedCtx);
      await runAh7G0G1TakeoverRecovery(crashCtx);
      const recoveredCtx = await convergeAh7Recovery(crashCtx);
      await assertAh7Recovered(recoveredCtx);
    });
  }
});
