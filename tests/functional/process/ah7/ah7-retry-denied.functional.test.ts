import { expect } from "vitest";
import { durableSnapshot } from "../../support/ah-durable-snapshot.js";
import { waitForPublic } from "../../support/public-client.js";
import type { Ah7CrashContext } from "./start-fixture.js";
import {
  readP4InvocationApprovalBinding,
  readReconciliationFacts,
  readToolResultForCall,
  reconciliationChild,
} from "./support.js";

const runAh7RetryDeniedRecovery = async (
  ctx: Ah7CrashContext,
): Promise<void> => {
  const { fixture, hit, targetExecutionId } = ctx;
  const {
    reconciliationMode,
    resourceChangeDuringReconcile,
    reconciliationDrift,
    recoveryCrashBoundary,
  } = ctx.flags;
  if (reconciliationMode === undefined)
    throw new Error("AH7 retry-denied recovery requires a reconciliation mode");
  await fixture.restart({
    entry: reconciliationChild,
    daemonEnvironment: {
      ARBOR_AH10_ROLE: "old",
      ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
      ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
      ...(resourceChangeDuringReconcile
        ? { ARBOR_AH7_TEST_RESOURCE_CHANGE_ON_RECONCILE: "1" }
        : {}),
      ...(reconciliationDrift === undefined
        ? {}
        : { ARBOR_AH7_TEST_DRIFT_ON_RECONCILE: reconciliationDrift }),
      ARBOR_AH7_TEST_CRASH_BOUNDARY: recoveryCrashBoundary ?? "disabled",
    },
  });
  if (recoveryCrashBoundary !== undefined) {
    await waitForPublic(
      async () => ctx.hits,
      (value) =>
        value.some(
          (candidate) =>
            candidate.boundary === recoveryCrashBoundary &&
            candidate.callRef === hit?.callRef,
        ),
      90_000,
    );
    const recoveryHit = hit;
    if (
      recoveryHit === undefined ||
      recoveryHit.invocationId === undefined ||
      recoveryHit.callRef === undefined
    ) {
      throw new Error("AH7 P40 boundary lacks the target invocation");
    }
    const recoveryCallRef = recoveryHit.callRef;
    const boundaryBinding = readP4InvocationApprovalBinding(
      fixture.databaseFile,
      targetExecutionId,
      recoveryHit.invocationId,
    );
    expect(
      readReconciliationFacts(fixture.databaseFile, recoveryHit.invocationId),
    ).toEqual([
      expect.objectContaining({
        outcome: "NotOccurred",
        fact_disposition: "RecoveryInput",
      }),
    ]);
    const shouldBeCommitted =
      recoveryCrashBoundary === "AH7AfterToolSettlementCommit";
    expect(boundaryBinding?.settlement_kind).toBe(
      shouldBeCommitted ? "ReconciledNoEffect" : null,
    );
    expect(boundaryBinding?.selected_fact_id).toEqual(
      shouldBeCommitted ? expect.any(String) : null,
    );
    expect(boundaryBinding?.observation_json === null).toBe(!shouldBeCommitted);
    expect(
      durableSnapshot(fixture.databaseFile).toolResults.filter(
        (row) => readToolResultForCall([row], recoveryCallRef) !== undefined,
      ),
    ).toHaveLength(0);
    await fixture.crash();
    await fixture.restart({
      entry: reconciliationChild,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "old",
        ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
        ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
        ARBOR_AH7_TEST_CRASH_BOUNDARY: "disabled",
        ...(resourceChangeDuringReconcile
          ? { ARBOR_AH7_TEST_RESOURCE_CHANGE_ON_RECONCILE: "1" }
          : {}),
        ...(reconciliationDrift === undefined
          ? {}
          : { ARBOR_AH7_TEST_DRIFT_ON_RECONCILE: reconciliationDrift }),
      },
    });
  }
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
  for (const scenario of ah7FamilyScenarios("retry-denied")) {
    it(ah7ScenarioTestName(scenario), async () => {
      const setupCtx = await startAh7Fixture(scenario, lifecycle);
      const admittedCtx = await admitAh7WorkAndApproveShell(setupCtx);
      const crashCtx = await reachAh7BoundaryAndCrash(admittedCtx);
      await runAh7RetryDeniedRecovery(crashCtx);
      const recoveredCtx = await convergeAh7Recovery(crashCtx);
      await assertAh7Recovered(recoveredCtx);
    });
  }
});
