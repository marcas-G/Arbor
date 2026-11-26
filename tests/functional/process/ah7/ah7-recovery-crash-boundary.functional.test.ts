import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { durableSnapshot } from "../../support/ah-durable-snapshot.js";
import { waitForPublic } from "../../support/public-client.js";
import type { Ah7CrashContext } from "./start-fixture.js";
import {
  readP4InvocationApprovalBinding,
  readReconciliationFacts,
  readTestExternalEffects,
  readToolResultForCall,
  reconciliationChild,
} from "./support.js";

const runAh7RecoveryCrashBoundary = async (
  ctx: Ah7CrashContext,
): Promise<void> => {
  const { fixture, client, project, hit, targetExecutionId } = ctx;
  const {
    reconciliationMode,
    recoveryCrashBoundary,
    resourceChangeDuringReconcile,
  } = ctx.flags;
  if (reconciliationMode === undefined)
    throw new Error(
      "AH7 recovery-crash-boundary recovery requires a reconciliation mode",
    );
  const factBoundary =
    String(reconciliationMode) === "NotOccurred"
      ? "AH7BeforeReconciliationFactCommit"
      : "AH7AfterReconciliationFactCommit";
  await fixture.restart({
    entry: reconciliationChild,
    daemonEnvironment: {
      ARBOR_AH10_ROLE: "old",
      ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
      ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
      ARBOR_AH7_TEST_CRASH_BOUNDARY: "disabled",
      ARBOR_AH7_TEST_RECONCILIATION_FACT_BOUNDARY: factBoundary,
    },
  });
  await waitForPublic(
    async () => ctx.hits,
    (value) => value.some((candidate) => candidate.boundary === factBoundary),
    30_000,
  );
  const factsAtFactBoundary = readReconciliationFacts(
    fixture.databaseFile,
    hit.invocationId,
  );
  expect(factsAtFactBoundary).toHaveLength(
    factBoundary === "AH7BeforeReconciliationFactCommit" ? 0 : 1,
  );
  if (factBoundary === "AH7AfterReconciliationFactCommit") {
    expect(factsAtFactBoundary[0]).toMatchObject({
      outcome: reconciliationMode,
      fact_disposition: "RecoveryInput",
    });
  }
  await fixture.crash();
  await fixture.restart({
    entry: reconciliationChild,
    daemonEnvironment: {
      ARBOR_AH10_ROLE: "old",
      ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
      ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
      ARBOR_AH7_TEST_CRASH_BOUNDARY: recoveryCrashBoundary ?? "disabled",
      ...(resourceChangeDuringReconcile
        ? { ARBOR_AH7_TEST_RESOURCE_CHANGE_ON_RECONCILE: "1" }
        : {}),
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
      recoveryCrashBoundary.includes("ToolSettlement") ? 90_000 : 45_000,
    );
    const recoveryHit = hit;
    if (
      recoveryHit === undefined ||
      recoveryHit.invocationId === undefined ||
      recoveryHit.callRef === undefined
    ) {
      throw new Error("AH7 recovery boundary lacks the target invocation");
    }
    const recoveryCallRef = recoveryHit.callRef;
    const boundarySnapshot = durableSnapshot(fixture.databaseFile);
    const boundaryBinding = readP4InvocationApprovalBinding(
      fixture.databaseFile,
      targetExecutionId,
      recoveryHit.invocationId,
    );
    if (recoveryCrashBoundary.includes("ActionResult")) {
      expect(boundaryBinding?.settlement_kind).toBe(
        reconciliationMode === "StillUnknown" ? null : "Success",
      );
      const projectedAction = boundarySnapshot.actions.filter(
        (action) => action.call_ref === recoveryCallRef,
      );
      const projectedResults = boundarySnapshot.toolResults.filter(
        (row) => readToolResultForCall([row], recoveryCallRef) !== undefined,
      );
      if (reconciliationMode === "StillUnknown") {
        const boundaryFacts = readReconciliationFacts(
          fixture.databaseFile,
          recoveryHit.invocationId,
        );
        expect(boundaryFacts).toHaveLength(1);
        expect(boundaryFacts[0]).toMatchObject({
          outcome: "StillUnknown",
          fact_disposition: "RecoveryInput",
        });
        expect(boundarySnapshot.executions).toContainEqual(
          expect.objectContaining({
            execution_id: targetExecutionId,
            settlement_kind: null,
          }),
        );
        const eventDb = new DatabaseSync(fixture.databaseFile, {
          readOnly: true,
        });
        let escalationAtBoundary: ReadonlyArray<{
          payload_json: string;
        }>;
        try {
          escalationAtBoundary = eventDb
            .prepare(
              "SELECT payload_json FROM domain_events WHERE event_type = 'ReconciliationEscalated' AND aggregate_ref = ?",
            )
            .all(targetExecutionId) as unknown as typeof escalationAtBoundary;
        } finally {
          eventDb.close();
        }
        expect(escalationAtBoundary).toHaveLength(1);
        expect(
          JSON.parse(String(escalationAtBoundary[0]?.payload_json)),
        ).toEqual({
          executionId: targetExecutionId,
          invocationRefsFingerprint: recoveryHit.invocationId,
          refs: [recoveryHit.invocationId],
        });
        const attentionAtBoundary = await client.view<{
          rows: ReadonlyArray<{
            source?: string;
            severity?: string;
            targetWorkspaceId?: string;
            dedupKey?: string;
          }>;
        }>("attention", { projectId: project.projectId });
        const unresolvedRows = attentionAtBoundary.rows.filter(
          (row) =>
            row.source === "RecoveryEscalation" &&
            row.dedupKey ===
              `reconciliation-escalated:${targetExecutionId}:${recoveryHit.invocationId}`,
        );
        expect(unresolvedRows).toHaveLength(1);
        expect(unresolvedRows[0]).toMatchObject({
          severity: "ActionRequired",
          targetWorkspaceId: project.rootWorkspaceId,
        });
      }
      if (recoveryCrashBoundary === "AH7BeforeActionResultCommit") {
        expect(projectedAction).toHaveLength(1);
        expect(projectedAction[0]?.state).toBe("Pending");
        expect(projectedResults).toHaveLength(0);
      } else {
        expect(projectedAction).toHaveLength(1);
        expect(projectedAction[0]?.state).toBe(
          reconciliationMode === "StillUnknown"
            ? "ReconciliationPending"
            : "Applied",
        );
        expect(projectedResults).toHaveLength(1);
      }
    } else {
      const shouldBeCommitted =
        recoveryCrashBoundary === "AH7AfterToolSettlementCommit";
      expect(boundaryBinding?.settlement_kind).toBe(
        shouldBeCommitted
          ? reconciliationMode === "Occurred"
            ? "Success"
            : "ReconciledNoEffect"
          : null,
      );
      expect(boundaryBinding?.selected_fact_id).toEqual(
        shouldBeCommitted ? expect.any(String) : null,
      );
      if (reconciliationMode === "Occurred" && shouldBeCommitted) {
        const selectedFact = readReconciliationFacts(
          fixture.databaseFile,
          recoveryHit.invocationId,
        )[0];
        expect(boundaryBinding).toMatchObject({
          settlement_provenance: "Reconciliation",
          selected_attempt_no: 0,
          result_ref: expect.stringMatching(/^art_/u),
        });
        expect(boundaryBinding?.selected_fact_id).toBe(selectedFact?.fact_id);
        expect(boundaryBinding?.result_ref).toBe(selectedFact?.result_ref);
        const boundaryEffects = readTestExternalEffects(fixture.databaseFile);
        expect(boundaryEffects).toHaveLength(1);
        expect(boundaryEffects[0]?.result_ref).toBe(selectedFact?.result_ref);
      }
      expect(boundaryBinding?.observation_json === null).toBe(
        !shouldBeCommitted,
      );
      expect(
        boundarySnapshot.toolResults.filter(
          (row) => readToolResultForCall([row], recoveryCallRef) !== undefined,
        ),
      ).toHaveLength(0);
    }
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
  for (const scenario of ah7FamilyScenarios("recovery-crash-boundary")) {
    it(ah7ScenarioTestName(scenario), async () => {
      const setupCtx = await startAh7Fixture(scenario, lifecycle);
      const admittedCtx = await admitAh7WorkAndApproveShell(setupCtx);
      const crashCtx = await reachAh7BoundaryAndCrash(admittedCtx);
      await runAh7RecoveryCrashBoundary(crashCtx);
      const recoveredCtx = await convergeAh7Recovery(crashCtx);
      await assertAh7Recovered(recoveredCtx);
    });
  }
});
