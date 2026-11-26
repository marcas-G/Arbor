import type { Ah7CrashContext } from "./start-fixture.js";
import { crashChild } from "./support.js";

const restartAh7NonIdempotentBoundary = async (
  ctx: Ah7CrashContext,
): Promise<void> => {
  const { fixture } = ctx;
  await fixture.restart({
    entry: crashChild,
    daemonEnvironment: {
      ARBOR_AH_BOUNDARY: "disabled",
      ARBOR_AH_NON_IDEMPOTENT: "1",
    },
  });
};

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

const lifecycle = createAh7FixtureLifecycle();

describe("AH7 Reconcilable tool intent after process crash", () => {
  vi.setConfig({ testTimeout: 180_000 });
  for (const scenario of ah7FamilyScenarios("non-idempotent-boundary")) {
    it(ah7ScenarioTestName(scenario), async () => {
      const setupCtx = await startAh7Fixture(scenario, lifecycle);
      const admittedCtx = await admitAh7WorkAndApproveShell(setupCtx);
      const crashCtx = await reachAh7BoundaryAndCrash(admittedCtx);
      await restartAh7NonIdempotentBoundary(crashCtx);
      const recoveredCtx = await convergeAh7Recovery(crashCtx);
      await assertAh7Recovered(recoveredCtx);
    });
  }
});
