import { afterEach, describe, expect, it } from "vitest";
import {
  makePublicClient,
  waitForPublic,
} from "../../support/public-client.js";
import {
  ah19AfterEach,
  childEntry,
  expireLeaseAfterOldDaemonExit,
  providerRequests,
  readExecutionIdForProviderTurn,
  readSnapshot,
  startOrdinaryNativeAtCheckpointBoundary,
} from "./support.js";

afterEach(ah19AfterEach);

describe("AH19 restart binding qualification", () => {
  it("rebases ordinary Native recovery from binding A to B through its portable frontier", async () => {
    const scenario = await startOrdinaryNativeAtCheckpointBoundary(
      "AH17AfterCheckpointEpochCommit",
    );
    const { fixture, project, workId, native, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const nativeTurnId = native.providerTurnId;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const beforeRestart = readSnapshot(fixture.databaseFile, ids);
    const nativeRow = beforeRestart.providerTurns.find(
      (turn) => turn.provider_turn_id === nativeTurnId,
    );
    const nativeManifest = JSON.parse(nativeRow?.manifest_json ?? "{}") as {
      inputFrontier?: {
        firstSequence: number | null;
        lastSequence: number | null;
      };
      contextRefs?: ReadonlyArray<string>;
      sourceAgentLoopStep?: {
        providerTurnId: string;
        logicalStepNo: number;
        repairAttempt: number;
      };
    };
    expect(nativeRow).toBeDefined();
    expect(beforeRestart.session?.context_epoch).toBe(1);
    await fixture.crash();
    await expireLeaseAfterOldDaemonExit(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    const requestsBeforeRestart = providerRequests.length;
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: {
        ARBOR_AH19_BOUNDARY: "none",
        ARBOR_AH19_BINDING_VARIANT: "B",
        ARBOR_AH19_ORDINARY_WORK: "1",
        ARBOR_AH19_CAPTURE_EXIT: "1",
        ARBOR_AH19_REPORT_URL: reportUrl,
      },
    });
    await waitForPublic(
      async () => ({
        summary: providerRequests.find(
          (request) =>
            request.operationKind === "CompactionSummary" &&
            request.bindingVariant === "B" &&
            providerRequests.indexOf(request) >= requestsBeforeRestart,
        ),
        inference: providerRequests.find(
          (request) =>
            request.operationKind === "Inference" &&
            request.bindingVariant === "B" &&
            request.providerTurnId ===
              nativeManifest.sourceAgentLoopStep?.providerTurnId,
        ),
      }),
      (state) => state.summary !== undefined && state.inference !== undefined,
      60_000,
    ).catch((error: unknown) => {
      const after = readSnapshot(fixture.databaseFile, ids);
      throw new Error(
        `ordinary Native B rebase failed: ${error instanceof Error ? error.message : String(error)} requests=${JSON.stringify(providerRequests.slice(requestsBeforeRestart).map(({ operationKind, providerTurnId, bindingVariant, items }) => ({ operationKind, providerTurnId, bindingVariant, items })))} stderr=${JSON.stringify(fixture.daemonErrors)} stdout=${JSON.stringify(childOutput.filter((line) => line.includes("AH19_CHILD_ERROR") || line.includes("AH19_CHILD_EXIT") || line.includes("AH19NativeCheckpointRecovery")))} session=${JSON.stringify(after.session)} checkpoints=${JSON.stringify(after.checkpoints)} steps=${JSON.stringify(after.steps)}`,
      );
    });
    const after = readSnapshot(fixture.databaseFile, ids);
    const summaryRow = after.providerTurns.find(
      (turn) =>
        turn.output_contract_ref === "compaction-result-v1" &&
        turn.provider_turn_id !== nativeTurnId,
    );
    const summaryManifest = JSON.parse(summaryRow?.manifest_json ?? "{}") as {
      operationKind?: string;
      resolvedModelBindingFingerprint?: string;
      inputFrontier?: {
        firstSequence: number | null;
        lastSequence: number | null;
      };
      contextRefs?: ReadonlyArray<string>;
      sourceAgentLoopStep?: unknown;
    };
    expect(summaryManifest.operationKind).toBe("CompactionSummary");
    expect(summaryManifest.inputFrontier?.firstSequence).toBe(
      nativeManifest.inputFrontier?.firstSequence,
    );
    expect(summaryManifest.inputFrontier?.lastSequence).toBeGreaterThanOrEqual(
      nativeManifest.inputFrontier?.lastSequence ?? 0,
    );
    expect(
      summaryManifest.contextRefs?.slice(
        0,
        nativeManifest.contextRefs?.length ?? 0,
      ),
    ).toEqual(nativeManifest.contextRefs);
    expect(new Set(summaryManifest.contextRefs).size).toBe(
      summaryManifest.contextRefs?.length,
    );
    expect(summaryManifest.sourceAgentLoopStep).toEqual(
      expect.objectContaining({
        logicalStepNo: nativeManifest.sourceAgentLoopStep?.logicalStepNo,
        repairAttempt: nativeManifest.sourceAgentLoopStep?.repairAttempt,
        providerTurnId: nativeManifest.sourceAgentLoopStep?.providerTurnId,
      }),
    );
    const bRequests = providerRequests
      .slice(requestsBeforeRestart)
      .filter((request) => request.bindingVariant === "B");
    expect(
      bRequests.some((request) => request.operationKind === "CompactionNative"),
    ).toBe(false);
    expect(
      bRequests.every((request) =>
        request.items.every(
          (item) =>
            item._tag !== "CompactionCheckpoint" ||
            item.implementation !== "ProviderNative",
        ),
      ),
    ).toBe(true);
    expect(
      bRequests.filter((request) => request.providerTurnId === nativeTurnId),
    ).toHaveLength(0);
    expect(
      providerRequests.filter(
        (request) => request.providerTurnId === nativeTurnId,
      ),
    ).toHaveLength(1);
    expect(after.checkpoints).toHaveLength(2);
    expect(after.checkpoints[0]?.source_ref).toBe(nativeTurnId);
    expect(fixture.daemonErrors).toEqual([]);
  }, 120_000);
  it("rebases an inherited Native checkpoint when the next Work execution changes binding", async () => {
    const scenario = await startOrdinaryNativeAtCheckpointBoundary(
      "AH17AfterCheckpointEpochCommit",
    );
    const { fixture, project, workId, native, probe, reportUrl, childOutput } =
      scenario;
    const inheritedExecutionId = probe.executionId;
    const inheritedIds = {
      sessionId: project.rootSessionId,
      executionId: inheritedExecutionId,
      workId,
    };
    const checkpointBeforeSettlement = readSnapshot(
      fixture.databaseFile,
      inheritedIds,
    );
    expect(checkpointBeforeSettlement.checkpoints).toHaveLength(1);
    expect(
      checkpointBeforeSettlement.providerTurns.find(
        (turn) => turn.provider_turn_id === native.providerTurnId,
      ),
    ).toMatchObject({ execution_id: inheritedExecutionId });

    // The boundary fixture intentionally holds the Native provider after the
    // checkpoint commit. Recover that execution with the original binding so
    // it can settle before the next public SteerWork creates a new execution.
    await fixture.crash();
    await expireLeaseAfterOldDaemonExit(
      fixture,
      project.rootSessionId,
      inheritedExecutionId,
      workId,
    );
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: {
        ARBOR_AH19_BOUNDARY: "none",
        ARBOR_AH19_BINDING_VARIANT: "A",
        ARBOR_AH19_ORDINARY_WORK: "1",
        ARBOR_AH19_CONTEXT_WINDOW: "16384",
        ARBOR_AH19_ROOT_WORK_ALREADY_ASSIGNED: "1",
        ARBOR_AH19_REPORT_URL: reportUrl,
      },
    });
    const inheritedSettled = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, inheritedIds),
      (snapshot) =>
        snapshot.execution?.settled_at !== null &&
        snapshot.workWait !== undefined,
      60_000,
    );
    const requestsBeforeNewExecution = providerRequests.length;

    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: {
        ARBOR_AH19_BOUNDARY: "none",
        ARBOR_AH19_BINDING_VARIANT: "B",
        ARBOR_AH19_ORDINARY_WORK: "1",
        ARBOR_AH19_CONTEXT_WINDOW: "16384",
        ARBOR_AH19_ROOT_WORK_ALREADY_ASSIGNED: "1",
        ARBOR_AH19_REPORT_URL: reportUrl,
      },
    });
    const client = makePublicClient(fixture.baseUrl);
    const current = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (value) => value?.workId === workId && value.status === "Open",
    );
    if (current === null || current.workId === undefined) {
      throw new Error("inherited Native test lost the current Work");
    }
    await client.command(project.projectId, "SteerWork", {
      workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: current.revision,
      steer: {
        severity: "Normal",
        guidance: `AH19 ordinary recovery history inherited binding change ${crypto.randomUUID()}`,
      },
      provenance: { source: "HumanInput" },
    });

    const summaryRequest = await waitForPublic(
      async () =>
        providerRequests
          .slice(requestsBeforeNewExecution)
          .find(
            (request) =>
              request.operationKind === "CompactionSummary" &&
              request.bindingVariant === "B",
          ),
      (request) => request !== undefined,
      90_000,
    );
    if (summaryRequest === undefined) {
      throw new Error(
        `inherited Native binding rebase did not request Summary; child=${JSON.stringify(childOutput)} daemon=${JSON.stringify(fixture.daemonErrors)}`,
      );
    }
    const newExecutionId = readExecutionIdForProviderTurn(
      fixture.databaseFile,
      summaryRequest.providerTurnId,
    );
    expect(newExecutionId).not.toBe(inheritedExecutionId);

    const newInference = await waitForPublic(
      async () =>
        providerRequests
          .slice(requestsBeforeNewExecution)
          .find(
            (request) =>
              request.operationKind === "Inference" &&
              request.bindingVariant === "B",
          ),
      (request) => request !== undefined,
      60_000,
    );
    expect(newInference).toBeDefined();
    expect(
      providerRequests
        .slice(requestsBeforeNewExecution)
        .filter((request) => request.operationKind === "CompactionNative"),
    ).toHaveLength(0);
    expect(
      newInference?.items.some(
        (item) =>
          item._tag === "CompactionCheckpoint" &&
          item.implementation === "ProviderNative",
      ),
    ).toBe(false);

    const newIds = {
      sessionId: project.rootSessionId,
      executionId: newExecutionId,
      workId,
    };
    const recovered = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, newIds),
      (snapshot) =>
        snapshot.execution?.settled_at !== null &&
        snapshot.workWait !== undefined &&
        snapshot.checkpoints.length === 2,
      90_000,
    );
    const summaryTurn = recovered.providerTurns.find(
      (turn) => turn.provider_turn_id === summaryRequest.providerTurnId,
    );
    const summaryManifest = JSON.parse(summaryTurn?.manifest_json ?? "{}") as {
      executionId?: string;
      sourceAgentLoopStep?: { executionId?: string };
      operationKind?: string;
      resolvedModelBindingFingerprint?: string;
    };
    expect(summaryManifest).toMatchObject({
      executionId: newExecutionId,
      operationKind: "CompactionSummary",
      resolvedModelBindingFingerprint:
        expect.stringMatching(/^p16fp_[0-9a-f]{64}$/u),
      sourceAgentLoopStep: { executionId: inheritedExecutionId },
    });
    expect(recovered.steps).toContainEqual(
      expect.objectContaining({ logical_step_no: 0, repair_attempt: 0 }),
    );
    expect(readSnapshot(fixture.databaseFile, inheritedIds).steps).toEqual(
      inheritedSettled.steps,
    );
    expect(fixture.daemonErrors).toEqual([]);
  }, 180_000);
  it("reuses an inherited Native checkpoint when the next Work execution keeps binding", async () => {
    const scenario = await startOrdinaryNativeAtCheckpointBoundary(
      "AH17AfterCheckpointEpochCommit",
    );
    const { fixture, project, workId, native, probe, reportUrl, childOutput } =
      scenario;
    const inheritedExecutionId = probe.executionId;
    const inheritedIds = {
      sessionId: project.rootSessionId,
      executionId: inheritedExecutionId,
      workId,
    };
    expect(
      readSnapshot(fixture.databaseFile, inheritedIds).checkpoints,
    ).toHaveLength(1);

    await fixture.crash();
    await expireLeaseAfterOldDaemonExit(
      fixture,
      project.rootSessionId,
      inheritedExecutionId,
      workId,
    );
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: {
        ARBOR_AH19_BOUNDARY: "none",
        ARBOR_AH19_BINDING_VARIANT: "A",
        ARBOR_AH19_ORDINARY_WORK: "1",
        ARBOR_AH19_CONTEXT_WINDOW: "16384",
        ARBOR_AH19_ROOT_WORK_ALREADY_ASSIGNED: "1",
        ARBOR_AH19_REPORT_URL: reportUrl,
      },
    });
    const inheritedSettled = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, inheritedIds),
      (snapshot) =>
        snapshot.execution?.settled_at !== null &&
        snapshot.workWait !== undefined,
    );

    const requestsBeforeNewExecution = providerRequests.length;
    const client = makePublicClient(fixture.baseUrl);
    const current = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (value) => value?.workId === workId && value.status === "Open",
    );
    if (current === null || current.workId === undefined) {
      throw new Error(
        "inherited Native exact-binding test lost the current Work",
      );
    }
    await client.command(project.projectId, "SteerWork", {
      workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: current.revision,
      steer: {
        severity: "Normal",
        guidance: `AH19 inherited Native exact binding ${crypto.randomUUID()}`,
      },
      provenance: { source: "HumanInput" },
    });

    const newInference = await waitForPublic(
      async () =>
        providerRequests
          .slice(requestsBeforeNewExecution)
          .find(
            (request) =>
              request.operationKind === "Inference" &&
              request.bindingVariant === "A",
          ),
      (request) => request !== undefined,
      90_000,
    ).catch((error: unknown) => {
      const diagnosticSnapshot = readSnapshot(fixture.databaseFile, {
        sessionId: project.rootSessionId,
        executionId: inheritedExecutionId,
        workId,
      });
      throw new Error(
        `inherited Native exact-binding reuse did not request Inference: ${error instanceof Error ? error.message : String(error)} requests=${JSON.stringify(providerRequests.slice(requestsBeforeNewExecution).map(({ operationKind, providerTurnId, bindingVariant }) => ({ operationKind, providerTurnId, bindingVariant })))} stderr=${JSON.stringify(fixture.daemonErrors)} stdout=${JSON.stringify(childOutput.slice(-80))} inheritedSnapshot=${JSON.stringify({ session: diagnosticSnapshot.session, checkpoints: diagnosticSnapshot.checkpoints, providerTurns: diagnosticSnapshot.providerTurns, steps: diagnosticSnapshot.steps, providerLinks: diagnosticSnapshot.providerLinks, execution: diagnosticSnapshot.execution, leases: diagnosticSnapshot.leases })} fixtureDirectory=${fixture.directory}`,
      );
    });
    expect(newInference).toBeDefined();
    expect(
      providerRequests
        .slice(requestsBeforeNewExecution)
        .filter((request) => request.operationKind === "CompactionNative"),
    ).toHaveLength(0);
    expect(
      newInference?.items.filter(
        (item) =>
          item._tag === "CompactionCheckpoint" &&
          item.implementation === "ProviderNative",
      ),
    ).toHaveLength(1);
    expect(
      providerRequests.filter(
        (request) => request.providerTurnId === native.providerTurnId,
      ),
    ).toHaveLength(1);

    const newExecutionId = readExecutionIdForProviderTurn(
      fixture.databaseFile,
      newInference?.providerTurnId ?? "",
    );
    expect(newExecutionId).not.toBe(inheritedExecutionId);
    const newIds = {
      sessionId: project.rootSessionId,
      executionId: newExecutionId,
      workId,
    };
    const recovered = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, newIds),
      (snapshot) =>
        snapshot.execution?.settled_at !== null &&
        snapshot.workWait !== undefined &&
        snapshot.checkpoints.length === 1,
      90_000,
    );
    expect(recovered.steps).toContainEqual(
      expect.objectContaining({ logical_step_no: 0, repair_attempt: 0 }),
    );
    expect(
      recovered.providerTurns.some(
        (turn) =>
          turn.provider_turn_id === newInference?.providerTurnId &&
          turn.execution_id === newExecutionId,
      ),
    ).toBe(true);
    expect(readSnapshot(fixture.databaseFile, inheritedIds).steps).toEqual(
      inheritedSettled.steps,
    );
    expect(fixture.daemonErrors).toEqual([]);
  }, 180_000);
});
