import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { durableSnapshot } from "../../support/ah-durable-snapshot.js";
import { waitForPublic } from "../../support/public-client.js";
import type { Ah7CrashContext } from "./start-fixture.js";
import {
  readEffectAttempts,
  readP4InvocationApprovalBinding,
  readP39RecoveryBinding,
  readReconciliationFacts,
  readTestExternalEffects,
  readTestReconciliationCallCount,
  reconciliationChild,
} from "./support.js";

const restartWithAh7ProfileDrift = async (
  ctx: Ah7CrashContext,
): Promise<void> => {
  const {
    fixture,
    targetExecutionId,
    targetInvocationId,
    targetCallRef,
    effectFile,
    attemptsBeforeRecovery,
    bindingBeforeRecovery,
  } = ctx;
  const { reconciliationMode, profileDrift } = ctx.flags;
  if (profileDrift === undefined)
    throw new Error("AH7 profile-drift recovery requires a profile drift");
  await fixture.restart({
    entry: reconciliationChild,
    daemonEnvironment: {
      ARBOR_AH10_ROLE: "old",
      ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
      ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode ?? "NotOccurred",
      ARBOR_AH7_TEST_PROFILE_DRIFT: profileDrift,
      ARBOR_AH7_TEST_CRASH_BOUNDARY: "disabled",
    },
  });
  const drifted = await waitForPublic(
    async () => durableSnapshot(fixture.databaseFile),
    (value) =>
      value.actions.some(
        (action) =>
          action.execution_id === targetExecutionId &&
          action.call_ref === targetCallRef &&
          action.state === "ReconciliationPending",
      ) &&
      value.executions.some(
        (execution) =>
          execution.execution_id === targetExecutionId &&
          execution.settlement_kind === "OutcomeUnknown",
      ),
    45_000,
  );
  expect(
    readP4InvocationApprovalBinding(
      fixture.databaseFile,
      targetExecutionId,
      targetInvocationId,
    ),
  ).toMatchObject({
    effect_admission_state: "MayHaveStarted",
    result_ref: null,
    settlement_kind: null,
    settled_at: null,
    selected_attempt_no: null,
    selected_fact_id: null,
  });
  expect(
    drifted.actions.find((action) => action.call_ref === targetCallRef)?.state,
  ).toBe("ReconciliationPending");
  expect(
    readReconciliationFacts(fixture.databaseFile, targetInvocationId),
  ).toEqual([]);
  expect(readEffectAttempts(fixture.databaseFile, targetInvocationId)).toEqual(
    attemptsBeforeRecovery,
  );
  expect(
    readP39RecoveryBinding(fixture.databaseFile, targetInvocationId),
  ).toEqual(bindingBeforeRecovery);
  expect(readTestExternalEffects(fixture.databaseFile)).toEqual([]);
  expect(
    readTestReconciliationCallCount(fixture.databaseFile, targetInvocationId),
  ).toBe(0);
  expect(existsSync(join(fixture.workspaceDirectory, effectFile))).toBe(false);
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
  for (const scenario of ah7FamilyScenarios("profile-drift")) {
    it(ah7ScenarioTestName(scenario), async () => {
      const setupCtx = await startAh7Fixture(scenario, lifecycle);
      const admittedCtx = await admitAh7WorkAndApproveShell(setupCtx);
      const crashCtx = await reachAh7BoundaryAndCrash(admittedCtx);
      await restartWithAh7ProfileDrift(crashCtx);
      const recoveredCtx = await convergeAh7Recovery(crashCtx);
      await assertAh7Recovered(recoveredCtx);
    });
  }
});
