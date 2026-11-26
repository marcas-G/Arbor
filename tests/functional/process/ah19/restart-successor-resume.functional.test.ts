import { afterEach, describe, expect, it } from "vitest";
import { waitForPublic } from "../../support/public-client.js";
import {
  ah19AfterEach,
  childEntry,
  corruptStepSuccessorLogicalStepNo,
  corruptStepSuccessorPredecessor,
  expireLeaseAfterOldDaemonExit,
  probes,
  providerRequests,
  readSnapshot,
  startAtCheckpointBoundary,
  startOrdinaryNativeAtCheckpointBoundary,
} from "./support.js";

afterEach(ah19AfterEach);

describe("AH19 restart binding qualification", () => {
  it("fails closed when the persisted NextStepReady successor does not point back to its source", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH17BeforeCheckpointEpochCommit",
      {
        ARBOR_AH19_NESTED_NATIVE: "1",
        ARBOR_AH19_GATE_TURN_SUFFIX: "_2_native_compact_1",
      },
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const olderNativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const targetNativeTurnId = `ptn_${executionId}_2_native_compact_1`;
    const olderOpaqueRef = `ah19-opaque:${olderNativeTurnId}`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const sourceStep = beforeKill.steps.find(
      (step) => step.logical_step_no === 1 && step.repair_attempt === 0,
    );
    const targetStep = beforeKill.steps.find(
      (step) => step.logical_step_no === 2 && step.repair_attempt === 0,
    );
    expect(sourceStep?.state).toBe("NextStepReady");
    expect(JSON.parse(sourceStep?.successor_json ?? "{}")).toMatchObject({
      logicalStepNo: 2,
      repairAttempt: 0,
      providerTurnId: `ptn_${executionId}_2`,
    });
    expect(targetStep).toMatchObject({
      predecessor_logical_step_no: 1,
      predecessor_repair_attempt: 0,
    });

    await fixture.crash();
    await expireLeaseAfterOldDaemonExit(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    corruptStepSuccessorPredecessor(fixture.databaseFile, executionId);
    const corrupted = readSnapshot(fixture.databaseFile, ids);
    expect(
      corrupted.steps.find((step) => step.logical_step_no === 2),
    ).toMatchObject({
      predecessor_logical_step_no: 0,
      predecessor_repair_attempt: 0,
    });

    await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_NESTED_NATIVE: "1",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .then(
        () => undefined,
        () => undefined,
      );
    const restartChildError = childOutput
      .flatMap((line) => {
        try {
          return [
            JSON.parse(line) as {
              tag?: string;
              error?: { _tag?: string; stage?: string; reason?: string };
            },
          ];
        } catch {
          return [];
        }
      })
      .find((event) => event.tag === "AH19_CHILD_ERROR");
    expect(restartChildError?.error).toMatchObject({
      _tag: "ExecutionDriverInvariantFailure",
      stage: "AgentLoopStep",
      reason: "AgentLoopStepReplayBindingMismatch",
    });
    expect(
      childOutput.some((line) =>
        line.includes("NativeRebaseResumesPersistedSuccessor"),
      ),
    ).toBe(false);
    expect(
      providerRequests.filter((event) => event.bindingVariant === "B"),
    ).toEqual([]);
    const leakedRequests = providerRequests.filter(
      (event) =>
        event.bindingVariant === "B" &&
        event.items.some((item) => item.opaqueItemRef === olderOpaqueRef),
    );
    expect(leakedRequests).toEqual([]);
    const afterRestart = readSnapshot(fixture.databaseFile, ids);
    expect(afterRestart.actions).toEqual(corrupted.actions);
    expect(afterRestart.sessionEntries).toEqual(corrupted.sessionEntries);
    expect(afterRestart.checkpoints).toEqual(corrupted.checkpoints);
    expect(
      afterRestart.providerTurns.find(
        (turn) => turn.provider_turn_id === targetNativeTurnId,
      ),
    ).toBeDefined();
    expect(
      afterRestart.checkpoints.some(
        (checkpoint) => checkpoint.source_ref === targetNativeTurnId,
      ),
    ).toBe(false);
  }, 180_000);
  it("fails closed when the persisted NextStepReady successor skips a logical step", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH17BeforeCheckpointEpochCommit",
      {
        ARBOR_AH19_NESTED_NATIVE: "1",
        ARBOR_AH19_GATE_TURN_SUFFIX: "_2_native_compact_1",
      },
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const targetNativeTurnId = `ptn_${executionId}_2_native_compact_1`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const sourceStep = beforeKill.steps.find(
      (step) => step.logical_step_no === 1 && step.repair_attempt === 0,
    );
    expect(sourceStep?.state).toBe("NextStepReady");
    expect(JSON.parse(sourceStep?.successor_json ?? "{}")).toMatchObject({
      logicalStepNo: 2,
      repairAttempt: 0,
      providerTurnId: `ptn_${executionId}_2`,
    });
    await fixture.crash();
    await expireLeaseAfterOldDaemonExit(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    corruptStepSuccessorLogicalStepNo(fixture.databaseFile, executionId);
    const corrupted = readSnapshot(fixture.databaseFile, ids);
    expect(
      JSON.parse(
        corrupted.steps.find((step) => step.logical_step_no === 1)
          ?.successor_json ?? "{}",
      ).logicalStepNo,
    ).toBe(3);

    await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_NESTED_NATIVE: "1",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .then(
        () => undefined,
        () => undefined,
      );
    const restartChildError = childOutput
      .flatMap((line) => {
        try {
          return [
            JSON.parse(line) as {
              tag?: string;
              error?: { _tag?: string; stage?: string; reason?: string };
            },
          ];
        } catch {
          return [];
        }
      })
      .find((event) => event.tag === "AH19_CHILD_ERROR");
    expect(restartChildError?.error).toMatchObject({
      _tag: "ExecutionDriverInvariantFailure",
      stage: "AgentLoopStep",
      reason: "AgentLoopStepReplayBindingMismatch",
    });
    expect(
      childOutput.some((line) =>
        line.includes("NativeRebaseResumesPersistedSuccessor"),
      ),
    ).toBe(false);
    expect(
      providerRequests.filter((event) => event.bindingVariant === "B"),
    ).toEqual([]);
    const afterRestart = readSnapshot(fixture.databaseFile, ids);
    expect(afterRestart.actions).toEqual(corrupted.actions);
    expect(afterRestart.sessionEntries).toEqual(corrupted.sessionEntries);
    expect(afterRestart.checkpoints).toEqual(corrupted.checkpoints);
    expect(
      afterRestart.providerTurns.some(
        (turn) => turn.provider_turn_id === targetNativeTurnId,
      ),
    ).toBe(true);
    expect(
      afterRestart.checkpoints.some(
        (checkpoint) => checkpoint.source_ref === targetNativeTurnId,
      ),
    ).toBe(false);
  }, 180_000);
  it("resumes a StepEffectsCommitted source to its exact next successor without replaying effects", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH11AfterStepEffectsCommit",
      {
        ARBOR_AH19_NESTED_NATIVE: "1",
        ARBOR_AH19_AH11_MATCH_INDEX: "1",
      },
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const sourceInferenceTurnId = `ptn_${executionId}_0`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    expect(probe.providerTurnId).toBe(sourceInferenceTurnId);
    expect(
      probes.filter((entry) => entry.boundary === "AH11AfterStepEffectsCommit"),
    ).toHaveLength(1);
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    expect(beforeKill.session?.context_epoch).toBe(0);
    expect(beforeKill.checkpoints).toEqual([]);
    const sourceStep = beforeKill.steps.find(
      (step) => step.logical_step_no === 0 && step.repair_attempt === 0,
    );
    expect(sourceStep).toMatchObject({
      provider_turn_id: sourceInferenceTurnId,
      state: "StepEffectsCommitted",
      successor_json: null,
      next_action_index: 1,
    });
    const sourceAction = beforeKill.actions.filter(
      (action) => action.logical_step_no === 0 && action.repair_attempt === 0,
    );
    expect(sourceAction).toHaveLength(1);
    const sourceCallRef = sourceAction[0]?.call_ref ?? "";
    expect(sourceAction[0]).toMatchObject({
      action_kind: "update_plan",
      state: "Applied",
    });
    expect(
      beforeKill.sessionEntries.filter(
        (entry) =>
          entry.entry_kind === "Observation" &&
          entry.payload_json.includes(sourceCallRef),
      ),
    ).toHaveLength(1);
    expect(
      providerRequests.filter(
        (event) => event.providerTurnId === sourceInferenceTurnId,
      ),
    ).toHaveLength(1);

    await fixture.crash();
    const afterKill = readSnapshot(fixture.databaseFile, ids);
    expect(afterKill.steps.find((step) => step.logical_step_no === 0)).toEqual(
      sourceStep,
    );
    await expireLeaseAfterOldDaemonExit(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: {
        ARBOR_AH19_BOUNDARY: "AH11AfterStepEffectsCommit",
        ARBOR_AH19_AH11_COUNT_ONLY: "1",
        ARBOR_AH19_BINDING_VARIANT: "B",
        ARBOR_AH19_REPORT_URL: reportUrl,
      },
    });
    const converged = await waitForPublic(
      async () => {
        const snapshot = readSnapshot(fixture.databaseFile, ids);
        const resumedStep = snapshot.steps.find(
          (step) => step.logical_step_no === 0 && step.repair_attempt === 0,
        );
        const childFailure = childOutput.some((line) => {
          try {
            return (
              (JSON.parse(line) as { tag?: string }).tag === "AH19_CHILD_ERROR"
            );
          } catch {
            return false;
          }
        });
        return { snapshot, resumedStep, childFailure };
      },
      (state) =>
        (state.resumedStep?.state === "NextStepReady" &&
          state.snapshot.steps.some(
            (step) =>
              step.logical_step_no === 1 &&
              step.repair_attempt === 0 &&
              step.state === "SettlementProposed",
          )) ||
        state.childFailure,
      75_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 StepEffectsCommitted successor did not converge: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    expect(
      converged.childFailure,
      `AH19 StepEffectsCommitted RED snapshot=${JSON.stringify({
        sessionEpoch: converged.snapshot.session?.context_epoch,
        checkpoints: converged.snapshot.checkpoints.map((entry) => ({
          sourceRef: entry.source_ref,
          payload: entry.payload_json,
        })),
        steps: converged.snapshot.steps.map((step) => ({
          step: step.logical_step_no,
          repair: step.repair_attempt,
          state: step.state,
          successor: step.successor_json,
        })),
        child: childOutput.filter(
          (line) =>
            line.includes("AH19NativeCheckpointRecovery") ||
            line.includes("AH19_CHILD_ERROR"),
        ),
        bindingBRequests: providerRequests.filter(
          (event) => event.bindingVariant === "B",
        ),
      })}`,
    ).toBe(false);
    expect(
      childOutput.filter((line) => line.includes('"tag":"AH19_AH11_COUNT"')),
    ).toEqual([]);
    const successorProgress = await waitForPublic(
      async () => ({
        snapshot: readSnapshot(fixture.databaseFile, ids),
        successorRequested: providerRequests.some(
          (event) =>
            event.bindingVariant === "B" &&
            event.operationKind === "Inference" &&
            event.providerTurnId === `ptn_${executionId}_1`,
        ),
      }),
      (state) =>
        state.successorRequested || state.snapshot.workWait !== undefined,
      45_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 StepEffectsCommitted successor did not run: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${childOutput.join(" | ")}`,
      );
    });
    const finalSnapshot = successorProgress.snapshot;
    const resumedStep = finalSnapshot.steps.find(
      (step) => step.logical_step_no === 0 && step.repair_attempt === 0,
    );
    expect(resumedStep?.state).toBe("NextStepReady");
    const successor = JSON.parse(resumedStep?.successor_json ?? "{}") as Record<
      string,
      unknown
    >;
    expect(successor).toMatchObject({
      executionId,
      logicalStepNo: 1,
      repairAttempt: 0,
      providerTurnId: `ptn_${executionId}_1`,
    });
    expect(
      finalSnapshot.steps.find(
        (step) => step.logical_step_no === 1 && step.repair_attempt === 0,
      )?.predecessor_logical_step_no,
    ).toBe(0);
    expect(finalSnapshot.session?.context_epoch).toBe(1);
    expect(finalSnapshot.checkpoints).toHaveLength(1);
    expect(
      finalSnapshot.actions.filter((action) => action.logical_step_no === 0),
    ).toEqual(sourceAction);
    expect(
      finalSnapshot.sessionEntries.filter(
        (entry) =>
          entry.entry_kind === "Observation" &&
          entry.payload_json.includes(sourceCallRef),
      ),
    ).toHaveLength(1);
    expect(
      providerRequests.filter(
        (event) =>
          event.bindingVariant === "B" &&
          event.operationKind === "Inference" &&
          event.providerTurnId === `ptn_${executionId}_1`,
      ),
    ).toHaveLength(1);
  }, 180_000);
  it("resumes a committed Native source StepEffectsCommitted to its exact successor without replaying effects", async () => {
    const scenario = await startOrdinaryNativeAtCheckpointBoundary(
      "AH17BeforeCheckpointEpochCommit",
    );
    const { fixture, project, workId, probe, childOutput } = scenario;
    const nativeTurnId = scenario.native.providerTurnId;
    const executionId = probe.executionId;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const nativeCommitted = readSnapshot(fixture.databaseFile, ids);
    const nativeManifest = JSON.parse(
      nativeCommitted.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      )?.manifest_json ?? "{}",
    ) as Record<string, unknown>;
    const sourceStepNo = Number(
      (
        nativeManifest.sourceAgentLoopStep as
          | { logicalStepNo?: number }
          | undefined
      )?.logicalStepNo,
    );
    const sourceInferenceTurnId = `ptn_${executionId}_${sourceStepNo}`;
    expect(nativeCommitted.session?.context_epoch).toBe(0);
    expect(nativeCommitted.checkpoints).toHaveLength(0);
    expect(
      nativeCommitted.steps.find(
        (step) =>
          step.logical_step_no === sourceStepNo && step.repair_attempt === 0,
      ),
    ).toMatchObject({
      provider_turn_id: sourceInferenceTurnId,
      state: "Prepared",
    });
    await fixture.crash();
    await expireLeaseAfterOldDaemonExit(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: {
        ARBOR_AH19_BOUNDARY: "none",
        ARBOR_AH19_SECONDARY_BOUNDARY: "AH11AfterStepEffectsCommit",
        ARBOR_AH19_AH11_COUNT_ONLY: "1",
        ARBOR_AH19_AH11_COUNT_ONLY_HOLD: "1",
        ARBOR_AH19_NATIVE_SOURCE_ACTION_TURN_ID: sourceInferenceTurnId,
        ARBOR_AH19_NATIVE_SOURCE_ACTION_CHECKPOINT_REF: `ah19-opaque:${nativeTurnId}`,
        ARBOR_AH19_BINDING_VARIANT: "A",
        ARBOR_AH19_REPORT_URL: scenario.reportUrl,
      },
    });
    const effectsProbe = await waitForPublic(
      async () =>
        childOutput
          .map((line) => {
            try {
              return JSON.parse(line) as {
                tag?: string;
                count?: number;
                providerTurnId?: string;
              };
            } catch {
              return undefined;
            }
          })
          .find(
            (event) =>
              event?.tag === "AH19_AH11_COUNT" &&
              event.providerTurnId === sourceInferenceTurnId,
          ),
      (event) => event !== undefined,
      60_000,
    ).catch((error: unknown) => {
      const snapshot = readSnapshot(fixture.databaseFile, ids);
      throw new Error(
        `Native checkpoint source never reached its matching StepEffectsCommitted boundary: ${error instanceof Error ? error.message : String(error)}; sessionEpoch=${snapshot.session?.context_epoch}; execution=${JSON.stringify(snapshot.execution)}; steps=${JSON.stringify(snapshot.steps.map(({ logical_step_no, repair_attempt, provider_turn_id, state, next_action_index, successor_json }) => ({ logical_step_no, repair_attempt, provider_turn_id, state, next_action_index, successor_json })))}; leases=${JSON.stringify(snapshot.leases)}; providerRequests=${JSON.stringify(providerRequests.map(({ operationKind, providerTurnId, bindingVariant }) => ({ operationKind, providerTurnId, bindingVariant })))}; childErrors=${childOutput
          .filter((line) => line.includes("AH19_CHILD_ERROR"))
          .slice(-4)
          .join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    if (effectsProbe === undefined) {
      throw new Error("Native StepEffectsCommitted source probe missing");
    }
    expect(effectsProbe.providerTurnId).toBe(sourceInferenceTurnId);
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const sourceStep = beforeKill.steps.find(
      (step) =>
        step.logical_step_no === sourceStepNo && step.repair_attempt === 0,
    );
    const nativeTurn = beforeKill.providerTurns.find(
      (turn) => turn.provider_turn_id === nativeTurnId,
    );
    expect(nativeTurn).toBeDefined();
    const nativeCheckpoint = JSON.parse(
      beforeKill.checkpoints[0]?.payload_json ?? "{}",
    ) as Record<string, unknown>;
    expect(sourceStep).toMatchObject({
      provider_turn_id: sourceInferenceTurnId,
      state: "StepEffectsCommitted",
      successor_json: null,
    });
    expect(beforeKill.session?.context_epoch).toBe(1);
    expect(nativeCheckpoint).toMatchObject({
      _tag: "CompactionCheckpoint",
      implementation: "ProviderNative",
      opaqueItemRef: `ah19-opaque:${nativeTurnId}`,
      bindingFingerprint: nativeManifest.resolvedModelBindingFingerprint,
    });
    expect(nativeManifest).toMatchObject({
      operationKind: "CompactionNative",
      providerTurnId: nativeTurnId,
      sourceAgentLoopStep: {
        executionId,
        logicalStepNo: sourceStepNo,
        repairAttempt: 0,
        providerTurnId: sourceInferenceTurnId,
      },
    });
    const sourceLinks = beforeKill.providerLinks.filter(
      (link) =>
        link.logical_step_no === sourceStepNo && link.repair_attempt === 0,
    );
    // This ordinary Work Native checkpoint is sourced directly by the
    // manifest's sourceAgentLoopStep and does not use a P20 overflow chain.
    expect(sourceLinks).toEqual([]);
    const sourceActions = beforeKill.actions.filter(
      (action) => action.logical_step_no === sourceStepNo,
    );
    const sourceObservations = beforeKill.sessionEntries.filter(
      (entry) =>
        entry.entry_kind === "Observation" &&
        sourceActions.some((action) =>
          entry.payload_json.includes(action.call_ref),
        ),
    );
    const observedSourceEffectBoundaries = childOutput.filter((line) => {
      try {
        const event = JSON.parse(line) as {
          tag?: string;
          providerTurnId?: string;
        };
        return (
          event.tag === "AH19_AH11_COUNT" &&
          event.providerTurnId === sourceInferenceTurnId
        );
      } catch {
        return false;
      }
    });
    expect(observedSourceEffectBoundaries).toHaveLength(1);
    expect(
      probes.filter(
        (entry) => entry.boundary === "AH17BeforeCheckpointEpochCommit",
      ),
    ).toHaveLength(1);

    await fixture.crash();
    const afterKill = readSnapshot(fixture.databaseFile, ids);
    expect(
      afterKill.steps.find((step) => step.logical_step_no === sourceStepNo),
    ).toEqual(sourceStep);
    expect(afterKill.checkpoints).toEqual(beforeKill.checkpoints);
    await expireLeaseAfterOldDaemonExit(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: {
        ARBOR_AH19_BOUNDARY: "none",
        ARBOR_AH19_SECONDARY_BOUNDARY: "AH11AfterStepEffectsCommit",
        ARBOR_AH19_AH11_COUNT_ONLY: "1",
        ARBOR_AH19_AH11_COUNT_ONLY_HOLD: "1",
        ARBOR_AH19_AH11_COUNT_ONLY_PROVIDER_TURN_ID: sourceInferenceTurnId,
        ARBOR_AH19_BINDING_VARIANT: "A",
        ARBOR_AH19_REPORT_URL: scenario.reportUrl,
      },
    });
    const resumed = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, ids),
      (snapshot) => {
        const source = snapshot.steps.find(
          (step) =>
            step.logical_step_no === sourceStepNo && step.repair_attempt === 0,
        );
        return source?.state === "NextStepReady";
      },
      60_000,
    );
    const resumedSource = resumed.steps.find(
      (step) =>
        step.logical_step_no === sourceStepNo && step.repair_attempt === 0,
    );
    expect(resumedSource?.state).toBe("NextStepReady");
    const successor = JSON.parse(
      resumedSource?.successor_json ?? "{}",
    ) as Record<string, unknown>;
    expect(successor).toMatchObject({
      executionId,
      logicalStepNo: sourceStepNo + 1,
      repairAttempt: 0,
      providerTurnId: `ptn_${executionId}_${sourceStepNo + 1}`,
    });
    expect(
      resumed.steps.find(
        (step) =>
          step.logical_step_no === sourceStepNo + 1 &&
          step.repair_attempt === 0,
      )?.predecessor_logical_step_no,
    ).toBe(sourceStepNo);
    expect(resumed.checkpoints).toEqual(beforeKill.checkpoints);
    expect(
      resumed.providerLinks.filter(
        (link) =>
          link.logical_step_no === sourceStepNo && link.repair_attempt === 0,
      ),
    ).toEqual(sourceLinks);
    expect(
      resumed.actions.filter(
        (action) => action.logical_step_no === sourceStepNo,
      ),
    ).toEqual(sourceActions);
    expect(
      resumed.sessionEntries.filter(
        (entry) =>
          entry.entry_kind === "Observation" &&
          sourceActions.some((action) =>
            entry.payload_json.includes(action.call_ref),
          ),
      ),
    ).toEqual(sourceObservations);
    expect(
      providerRequests.filter(
        (event) => event.providerTurnId === sourceInferenceTurnId,
      ),
    ).toHaveLength(1);
    expect(
      providerRequests.filter((event) => event.providerTurnId === nativeTurnId),
    ).toHaveLength(1);
    const finalSourceEffectBoundaries = childOutput.filter((line) => {
      try {
        const event = JSON.parse(line) as {
          tag?: string;
          providerTurnId?: string;
        };
        return (
          event.tag === "AH19_AH11_COUNT" &&
          event.providerTurnId === sourceInferenceTurnId
        );
      } catch {
        return false;
      }
    });
    expect(finalSourceEffectBoundaries).toEqual(observedSourceEffectBoundaries);
  }, 180_000);
});
