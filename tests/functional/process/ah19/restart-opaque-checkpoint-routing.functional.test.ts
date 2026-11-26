import { afterEach, describe, expect, it } from "vitest";
import { waitForPublic } from "../../support/public-client.js";
import {
  ah19AfterEach,
  childEntry,
  expireLeaseAfterOldDaemonExit,
  providerRequests,
  readSnapshot,
  startAtCheckpointBoundary,
} from "./support.js";

afterEach(ah19AfterEach);

describe("AH19 restart binding qualification", () => {
  it("routes an overflow-linked Native receipt through P20 before a changed-binding rebase", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH17BeforeCheckpointEpochCommit",
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const nativeTurnId = probe.providerTurnId;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const nativeLink = beforeKill.providerLinks.find(
      (link) => link.provider_turn_id === nativeTurnId,
    );
    expect(nativeLink).toMatchObject({
      logical_step_no: 1,
      repair_attempt: 0,
      role: "OverflowCompaction",
      overflow_ordinal: 0,
    });
    expect(
      beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toMatchObject({
      settled_at: expect.any(String),
      finish_reason: "Stop",
      output_contract_ref: "provider-native-compaction-v1",
    });
    expect(
      beforeKill.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === nativeTurnId,
      ),
    ).toEqual([expect.objectContaining({ attempt_no: 0, outcome: "Success" })]);
    expect(beforeKill.session?.context_epoch).toBe(0);
    expect(beforeKill.checkpoints).toHaveLength(0);
    await fixture.crash();
    await expireLeaseAfterOldDaemonExit(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    const requestCountBeforeRestart = providerRequests.length;
    await fixture.restart({
      entry: childEntry,
      daemonEnvironment: {
        ARBOR_AH19_BOUNDARY: "none",
        ARBOR_AH19_BINDING_VARIANT: "B",
        ARBOR_AH19_REPORT_URL: reportUrl,
        ARBOR_AH19_CAPTURE_EXIT: "1",
      },
    });
    const resumed = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, ids),
      (snapshot) =>
        snapshot.session?.context_epoch === 1 &&
        snapshot.checkpoints.length === 1 &&
        snapshot.workWait !== undefined,
      60_000,
    ).catch((error: unknown) => {
      const snapshot = readSnapshot(fixture.databaseFile, ids);
      throw new Error(
        `P20 Native source was not recovered before portable rebase: ${error instanceof Error ? error.message : String(error)} requests=${JSON.stringify(providerRequests.slice(requestCountBeforeRestart).map(({ operationKind, providerTurnId, bindingVariant, items }) => ({ operationKind, providerTurnId, bindingVariant, items })))} stderr=${JSON.stringify(fixture.daemonErrors)} stdout=${JSON.stringify(childOutput.filter((line) => line.includes("AH19_CHILD_ERROR") || line.includes("AH19NativeCheckpointRecovery")))} session=${JSON.stringify(snapshot.session)} checkpoints=${JSON.stringify(snapshot.checkpoints)} links=${JSON.stringify(snapshot.providerLinks)} steps=${JSON.stringify(snapshot.steps)}`,
      );
    });
    expect(resumed.checkpoints).toHaveLength(1);
    expect(resumed.providerLinks).toContainEqual(nativeLink);
    expect(resumed.providerLinks).toContainEqual(
      expect.objectContaining({
        logical_step_no: nativeLink?.logical_step_no,
        repair_attempt: nativeLink?.repair_attempt,
        role: "OverflowReplacement",
        predecessor_provider_turn_id: nativeTurnId,
        context_epoch: 1,
      }),
    );
    expect(resumed.checkpoints[0]?.source_ref).not.toBe(nativeTurnId);
    expect(
      providerRequests.filter(
        (request) => request.providerTurnId === nativeTurnId,
      ),
    ).toHaveLength(1);
    const bindingBRequests = providerRequests
      .slice(requestCountBeforeRestart)
      .filter((request) => request.bindingVariant === "B");
    expect(
      bindingBRequests.some(
        (request) => request.operationKind === "CompactionNative",
      ),
    ).toBe(false);
    expect(
      bindingBRequests.every((request) =>
        request.items.every(
          (item) =>
            item._tag !== "CompactionCheckpoint" ||
            item.implementation !== "ProviderNative",
        ),
      ),
    ).toBe(true);
    expect(fixture.daemonErrors).toEqual([]);
  }, 150_000);
  it("fails closed rather than sending an older Native opaque checkpoint to a changed binding", async () => {
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
    expect(probe.providerTurnId).toBe(targetNativeTurnId);
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    expect(beforeKill.session?.context_epoch).toBe(1);
    expect(beforeKill.checkpoints).toHaveLength(1);
    const olderCheckpoint = JSON.parse(
      beforeKill.checkpoints[0]?.payload_json ?? "{}",
    ) as Record<string, unknown>;
    expect(olderCheckpoint.opaqueItemRef).toBe(olderOpaqueRef);
    const targetNativeTurn = beforeKill.providerTurns.find(
      (turn) => turn.provider_turn_id === targetNativeTurnId,
    );
    expect(targetNativeTurn).toMatchObject({
      settled_at: expect.any(String),
      output_contract_ref: "provider-native-compaction-v1",
    });
    const targetNativeRequest = JSON.parse(
      targetNativeTurn?.portable_request_json ?? "{}",
    ) as { inputItems?: ReadonlyArray<Record<string, unknown>> };
    expect(
      targetNativeRequest.inputItems?.filter(
        (item) =>
          item._tag === "CompactionCheckpoint" &&
          item.implementation === "ProviderNative",
      ),
    ).toEqual([
      expect.objectContaining({
        implementation: "ProviderNative",
        opaqueItemRef: olderOpaqueRef,
      }),
    ]);
    expect(
      beforeKill.providerLinks.filter(
        (link) => link.provider_turn_id === targetNativeTurnId,
      ),
    ).toEqual([
      expect.objectContaining({
        logical_step_no: 2,
        repair_attempt: 0,
        role: "OverflowCompaction",
        predecessor_provider_turn_id: `ptn_${executionId}_2`,
        context_epoch: 1,
      }),
    ]);
    const olderReplacementLink = beforeKill.providerLinks.find(
      (link) =>
        link.logical_step_no === 1 && link.role === "OverflowReplacement",
    );
    expect(olderReplacementLink).toMatchObject({
      provider_turn_id: `ptn_${executionId}_1_overflow_0`,
      predecessor_provider_turn_id: olderNativeTurnId,
      context_epoch: 1,
    });

    await fixture.crash();
    const afterKill = readSnapshot(fixture.databaseFile, ids);
    expect(afterKill.session?.context_epoch).toBe(1);
    expect(afterKill.checkpoints).toEqual(beforeKill.checkpoints);
    expect(
      afterKill.providerTurns.find(
        (turn) => turn.provider_turn_id === targetNativeTurnId,
      ),
    ).toEqual(targetNativeTurn);
    await expireLeaseAfterOldDaemonExit(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    const restartFailure = await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_NESTED_NATIVE: "1",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_CAPTURE_EXIT: "1",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    if (restartFailure !== null) {
      const childError = childOutput
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
      expect(
        childError?.error?.reason,
        `unexpected nested restart failure: ${restartFailure instanceof Error ? restartFailure.message : String(restartFailure)}; child=${childOutput.join(" | ")}`,
      ).toBe("AgentLoopStepReplayBindingMismatch");
      expect(
        providerRequests.some(
          (request) =>
            request.bindingVariant === "B" &&
            request.items.some((item) => item.opaqueItemRef === olderOpaqueRef),
        ),
      ).toBe(false);
    }
    const recovery = await waitForPublic(
      async () => ({
        resumedSuccessor: childOutput.some((line) => {
          try {
            const event = JSON.parse(line) as {
              tag?: string;
              boundary?: string;
              stage?: string;
              providerTurnId?: string;
            };
            return (
              event.tag === "AH19_PROBE" &&
              event.boundary === "AH19NativeCheckpointRecovery" &&
              event.stage ===
                `NativeRebaseResumesPersistedSuccessor:from=1:to=2:providerTurn=ptn_${executionId}_2` &&
              event.providerTurnId === olderNativeTurnId
            );
          } catch {
            return false;
          }
        }),
        nestedRejected: childOutput.some((line) => {
          try {
            const event = JSON.parse(line) as {
              tag?: string;
              boundary?: string;
              stage?: string;
              providerTurnId?: string;
            };
            return (
              event.tag === "AH19_PROBE" &&
              event.boundary === "AH19NativeCheckpointRecovery" &&
              event.stage === "NestedNativeFrontierRejected" &&
              event.providerTurnId === targetNativeTurnId
            );
          } catch {
            return false;
          }
        }),
        leakedRequest: providerRequests.find(
          (event) =>
            event.bindingVariant === "B" &&
            event.items.some((item) => item.opaqueItemRef === olderOpaqueRef),
        ),
      }),
      (state) =>
        state.resumedSuccessor ||
        state.nestedRejected ||
        state.leakedRequest !== undefined,
      60_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 nested Native rebase did not reach a bounded decision: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    expect(recovery.resumedSuccessor).toBe(true);
    expect(recovery.nestedRejected).toBe(true);
    expect(recovery.leakedRequest).toBeUndefined();
    expect(
      providerRequests.filter(
        (event) =>
          event.bindingVariant === "B" &&
          event.items.some((item) => item.opaqueItemRef === olderOpaqueRef),
      ),
    ).toEqual([]);
    const afterRejection = readSnapshot(fixture.databaseFile, ids);
    expect(
      afterRejection.providerLinks.find(
        (link) =>
          link.logical_step_no === 1 && link.role === "OverflowReplacement",
      ),
    ).toEqual(olderReplacementLink);
  }, 180_000);
});
