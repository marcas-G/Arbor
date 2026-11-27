import { afterEach, describe, expect, it } from "vitest";
import { waitForPublic } from "../../support/public-client.js";
import {
  ah19AfterEach,
  ah19Failure,
  ah19PersistedStateSummary,
  beginAh19PhaseDiagnostics,
  childEntry,
  corruptNativeManifestLogicalStepNo,
  corruptNativeSourceLink,
  expireLeaseAfterOldDaemonExit,
  providerRequests,
  readSnapshot,
  startAtCheckpointBoundary,
} from "./support.js";

afterEach(ah19AfterEach);

describe("restart binding qualification", () => {
  it("fails closed when a Native manifest claims a different source logical step", async () => {
    const diagnostic = beginAh19PhaseDiagnostics(
      "fails closed when a Native manifest claims a different source logical step",
      "manifest-source-step-mismatch",
    );
    const scenario = await startAtCheckpointBoundary(
      "AH17AfterCheckpointEpochCommit",
    );
    const { fixture, project, workId, probe, reportUrl } = scenario;
    const executionId = probe.executionId;
    const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    diagnostic.attach(fixture, scenario.childOutput);
    diagnostic.setPersistedState(() =>
      ah19PersistedStateSummary(readSnapshot(fixture.databaseFile, ids)),
    );
    diagnostic.phase("child START/LISTEN gen0 complete", { executionId });
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    expect(beforeKill.session?.context_epoch).toBe(1);
    expect(beforeKill.providerTurns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider_turn_id: nativeTurnId }),
      ]),
    );
    const beforeKillNativeManifest = JSON.parse(
      beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      )?.manifest_json ?? "{}",
    ) as Record<string, unknown>;
    expect(beforeKillNativeManifest.logicalStepNo).toBe(1);
    expect(
      beforeKill.providerLinks.filter(
        (link) => link.provider_turn_id === nativeTurnId,
      ),
    ).toEqual([
      expect.objectContaining({
        logical_step_no: 1,
        repair_attempt: 0,
        overflow_ordinal: 0,
        role: "OverflowCompaction",
        predecessor_provider_turn_id: `ptn_${executionId}_1`,
        context_epoch: 0,
      }),
    ]);

    await fixture.crash();
    diagnostic.phase("crash gen0 complete");
    await expireLeaseAfterOldDaemonExit(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    diagnostic.phase("lease expired after old daemon exit", {
      leases: readSnapshot(fixture.databaseFile, ids).leases,
    });
    corruptNativeManifestLogicalStepNo(fixture.databaseFile, nativeTurnId, 0);
    const corrupted = readSnapshot(fixture.databaseFile, ids);
    const corruptedNative = corrupted.providerTurns.find(
      (turn) => turn.provider_turn_id === nativeTurnId,
    );
    expect(
      JSON.parse(corruptedNative?.manifest_json ?? "{}").logicalStepNo,
    ).toBe(0);
    expect(nativeTurnId).toContain("_1_native_compact_0");
    diagnostic.phase("manifest mutated", {
      providerTurnId: nativeTurnId,
      logicalStepNo: 0,
      manifestRefs: corrupted.providerTurns.map((turn) => ({
        providerTurnId: turn.provider_turn_id,
        manifestId: turn.manifest_id,
      })),
    });

    const restartFailure = await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(restartFailure).not.toBeNull();
    diagnostic.phase("gen1 listening/restart returned", {
      restartFailure:
        restartFailure instanceof Error
          ? restartFailure.message
          : String(restartFailure),
      childStart: scenario.childOutput.filter((line) =>
        line.includes("AH19_CHILD_START"),
      ),
    });
    const childFailure = scenario.childOutput
      .map((line) => {
        try {
          return JSON.parse(line) as {
            tag?: string;
            error?: { reason?: string };
          };
        } catch {
          return undefined;
        }
      })
      .find((event) => event?.tag === "AH19_CHILD_ERROR");
    expect(childFailure?.error?.reason).toBe(
      "AgentLoopStepReplayBindingMismatch",
    );
    diagnostic.phase("failclosed marker observed", {
      reason: childFailure?.error?.reason,
      childFailure,
    });
    const rejected = readSnapshot(fixture.databaseFile, ids);
    expect(rejected.session?.context_epoch).toBe(1);
    expect(rejected.checkpoints).toEqual(beforeKill.checkpoints);
    expect(rejected.execution?.settled_at).toBeNull();
    expect(rejected.leases.at(-1)?.generation).toBe(1);
    expect(rejected.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_step_no: 1,
          repair_attempt: 0,
          provider_turn_id: nativeTurnId.replace("_native_compact_0", ""),
          state: "Prepared",
        }),
      ]),
    );
    expect(
      rejected.providerTurns.filter(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toHaveLength(1);
    expect(
      rejected.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === nativeTurnId,
      ),
    ).toEqual([expect.objectContaining({ attempt_no: 0, outcome: "Success" })]);
    expect(
      providerRequests.filter((event) => event.bindingVariant === "B"),
    ).toEqual([]);
    expect(
      providerRequests.filter(
        (event) => event.operationKind === "CompactionNative",
      ),
    ).toHaveLength(1);
  }, 150_000);
  it.each(["repairAttempt", "role", "predecessor"] as const)(
    "fails closed when the P20 source link has a mismatched %s",
    async (corruption) => {
      const scenario = await startAtCheckpointBoundary(
        "AH17AfterCheckpointEpochCommit",
      );
      const { fixture, project, workId, probe, reportUrl } = scenario;
      const executionId = probe.executionId;
      const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
      const ids = { sessionId: project.rootSessionId, executionId, workId };
      const beforeKill = readSnapshot(fixture.databaseFile, ids);
      expect(
        beforeKill.providerLinks.find(
          (link) => link.provider_turn_id === nativeTurnId,
        ),
      ).toMatchObject({
        logical_step_no: 1,
        repair_attempt: 0,
        role: "OverflowCompaction",
        predecessor_provider_turn_id: `ptn_${executionId}_1`,
        context_epoch: 0,
      });

      await fixture.crash();
      await expireLeaseAfterOldDaemonExit(
        fixture,
        project.rootSessionId,
        executionId,
        workId,
      );
      corruptNativeSourceLink(
        fixture.databaseFile,
        nativeTurnId,
        corruption,
        executionId,
      );
      const corrupted = readSnapshot(fixture.databaseFile, ids);
      const corruptedLink = corrupted.providerLinks.find(
        (link) => link.provider_turn_id === nativeTurnId,
      );
      expect(corruptedLink).toBeDefined();
      if (corruption === "repairAttempt") {
        expect(corruptedLink?.repair_attempt).toBe(1);
      } else if (corruption === "role") {
        expect(corruptedLink?.role).toBe("OverflowReplacement");
      } else {
        expect(corruptedLink?.predecessor_provider_turn_id).toBe(
          `ptn_${executionId}_0`,
        );
      }

      const restartFailure = await fixture
        .restart({
          entry: childEntry,
          daemonEnvironment: {
            ARBOR_AH19_BOUNDARY: "none",
            ARBOR_AH19_BINDING_VARIANT: "B",
            ARBOR_AH19_REPORT_URL: reportUrl,
          },
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(restartFailure).not.toBeNull();
      const childFailure = scenario.childOutput
        .map((line) => {
          try {
            return JSON.parse(line) as {
              tag?: string;
              error?: { reason?: string };
            };
          } catch {
            return undefined;
          }
        })
        .find((event) => event?.tag === "AH19_CHILD_ERROR");
      expect(childFailure?.error?.reason).toBe(
        "AgentLoopStepReplayBindingMismatch",
      );
      const rejected = readSnapshot(fixture.databaseFile, ids);
      expect(rejected.session?.context_epoch).toBe(1);
      expect(rejected.checkpoints).toEqual(beforeKill.checkpoints);
      expect(rejected.execution?.settled_at).toBeNull();
      expect(rejected.leases.at(-1)?.generation).toBe(1);
      expect(
        rejected.steps.find((step) => step.logical_step_no === 1),
      ).toMatchObject({ repair_attempt: 0, state: "Prepared" });
      expect(
        providerRequests.filter((event) => event.bindingVariant === "B"),
      ).toEqual([]);
    },
    150_000,
  );
  it("rebuilds through portable Summary after a committed Native checkpoint's binding changes", async () => {
    const diagnostic = beginAh19PhaseDiagnostics(
      "rebuilds through portable Summary after a committed Native checkpoint's binding changes",
      "binding-change-portable-summary",
    );
    const scenario = await startAtCheckpointBoundary(
      "AH17AfterCheckpointEpochCommit",
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    diagnostic.attach(fixture, childOutput);
    diagnostic.setPersistedState(() =>
      ah19PersistedStateSummary(readSnapshot(fixture.databaseFile, ids)),
    );
    diagnostic.phase("child START/LISTEN gen0 complete", { executionId });
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const nativeCheckpoint = JSON.parse(
      beforeKill.checkpoints[0]?.payload_json ?? "{}",
    ) as Record<string, unknown>;
    expect(beforeKill.session?.context_epoch).toBe(1);
    expect(nativeCheckpoint).toMatchObject({
      _tag: "CompactionCheckpoint",
      implementation: "ProviderNative",
      opaqueItemRef: `ah19-opaque:${nativeTurnId}`,
    });
    const oldBindingFingerprint = nativeCheckpoint.bindingFingerprint;
    expect(
      providerRequests.filter(
        (event) => event.operationKind === "CompactionNative",
      ),
    ).toHaveLength(1);

    await fixture.crash();
    diagnostic.phase("crash gen0 complete", { nativeTurnId });
    const afterKill = readSnapshot(fixture.databaseFile, ids);
    expect(afterKill.session).toEqual(beforeKill.session);
    expect(afterKill.checkpoints).toEqual(beforeKill.checkpoints);
    await expireLeaseAfterOldDaemonExit(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    diagnostic.phase("lease expired after old daemon exit", {
      leases: readSnapshot(fixture.databaseFile, ids).leases,
    });
    await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .catch((error: unknown) => {
        throw new Error(
          `AH19 gen1 daemon failed startup: ${error instanceof Error ? error.message : String(error)}; child=${childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}`,
        );
      });
    diagnostic.phase("gen1 LISTEN complete", {
      childStart: childOutput.filter((line) =>
        line.includes("AH19_CHILD_START"),
      ),
    });

    await waitForPublic(
      async () =>
        providerRequests.some(
          (event) =>
            event.bindingVariant === "B" &&
            event.operationKind === "CompactionSummary",
        ),
      (seen) => seen,
      20_000,
    ).catch((error: unknown) => {
      throw ah19Failure("gen1 CompactionSummary request", error);
    });
    diagnostic.phase("gen1 portable Summary request observed", {
      requests: providerRequests.filter(
        (event) => event.bindingVariant === "B",
      ),
    });
    const recovered = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, ids),
      (snapshot) =>
        snapshot.session?.context_epoch === 2 &&
        snapshot.checkpoints.length === 2 &&
        snapshot.execution?.settlement_kind === "Completed" &&
        snapshot.workWait !== undefined,
      75_000,
    ).catch((error: unknown) => {
      throw ah19Failure("portable Summary rebase settlement", error);
    });
    diagnostic.phase("portable Summary work settled", {
      contextEpoch: recovered.session?.context_epoch,
      execution: recovered.execution,
      stepCursor: recovered.steps.map((step) => ({
        logicalStepNo: step.logical_step_no,
        state: step.state,
        cursor: step.next_action_index,
      })),
    });

    const summaryCheckpoint = JSON.parse(
      recovered.checkpoints[1]?.payload_json ?? "{}",
    ) as Record<string, unknown>;
    expect(summaryCheckpoint).toMatchObject({
      _tag: "CompactionCheckpoint",
      implementation: "Summary",
      fromEpoch: 1,
      toEpoch: 2,
      bindingFingerprint: null,
    });
    expect(summaryCheckpoint.summaryText).toContain(
      "Portable AH19 continuation B.",
    );
    expect(
      providerRequests.filter(
        (event) => event.operationKind === "CompactionNative",
      ),
    ).toHaveLength(1);
    const mismatchedRequests = providerRequests.filter(
      (event) => event.bindingVariant === "B",
    );
    expect(mismatchedRequests.length).toBeGreaterThanOrEqual(2);
    expect(
      mismatchedRequests
        .flatMap((event) => event.items)
        .some((item) => item.opaqueItemRef === `ah19-opaque:${nativeTurnId}`),
    ).toBe(false);
    expect(
      providerRequests.some(
        (event) =>
          event.operationKind === "CompactionSummary" &&
          event.bindingVariant === "B" &&
          event.items.some((item) => item._tag === "ControlResult"),
      ),
    ).toBe(true);
    expect(
      recovered.providerTurns.filter(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toHaveLength(1);
    expect(oldBindingFingerprint).toMatch(/^p16fp_[0-9a-f]{64}$/u);
    expect(fixture.daemonErrors).toEqual([]);
  }, 150_000);
});
