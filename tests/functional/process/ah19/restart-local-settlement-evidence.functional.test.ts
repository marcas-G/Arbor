import { afterEach, describe, expect, it } from "vitest";
import { waitForPublic } from "../../support/public-client.js";
import {
  type Ah19Snapshot,
  ah19AfterEach,
  childEntry,
  corruptNativeSuccessPrefix,
  expireLeaseAfterOldDaemonExit,
  providerRequests,
  readSnapshot,
  startAtCheckpointBoundary,
} from "./support.js";

afterEach(ah19AfterEach);

describe("AH19 restart binding qualification", () => {
  it("locally settles complete Native success evidence on the same Turn and Manifest after process loss", async () => {
    const scenario = await startAtCheckpointBoundary("AH12BeforeSuccessCommit");
    const { fixture, project, workId, probe, reportUrl } = scenario;
    const executionId = probe.executionId;
    const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    expect(probe.providerTurnId).toBe(nativeTurnId);
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    expect(beforeKill.session?.context_epoch).toBe(0);
    expect(beforeKill.checkpoints).toEqual([]);
    const beforeTurn = beforeKill.providerTurns.find(
      (turn) => turn.provider_turn_id === nativeTurnId,
    );
    expect(beforeTurn).toMatchObject({
      output_contract_ref: "provider-native-compaction-v1",
      settled_at: null,
      finish_reason: null,
      manifest_json: expect.any(String),
      portable_request_json: expect.any(String),
    });
    const beforeAttempt = beforeKill.providerAttempts.find(
      (attempt) => attempt.provider_turn_id === nativeTurnId,
    );
    expect(beforeAttempt).toMatchObject({
      attempt_no: 0,
      outcome: "InProgress",
      delivered_position: 0,
      continuation_checkpoint_json: null,
    });
    const beforeObservation = JSON.parse(
      beforeAttempt?.observation_json ?? "{}",
    ) as Record<string, unknown>;
    expect(beforeObservation).toEqual({
      responseStarted: true,
      canonicalEventEmitted: true,
      consumerVisibleOutput: false,
      toolCallProposed: false,
      continuationAvailable: true,
      externalEffectPossible: false,
    });
    const completePrefix = JSON.parse(
      beforeAttempt?.canonical_event_prefix_json ?? "[]",
    ) as Array<{ _tag?: string; finishReason?: string; stateRef?: string }>;
    expect(completePrefix.map((event) => event._tag)).toEqual([
      "TurnStarted",
      "ContinuationState",
      "TurnCompleted",
    ]);
    expect(completePrefix.at(-1)?.finishReason).toBe("Stop");
    expect(completePrefix[1]?.stateRef).toBe(`ah19-opaque:${nativeTurnId}`);
    expect(
      providerRequests.filter(
        (event) => event.operationKind === "CompactionNative",
      ),
    ).toEqual([
      expect.objectContaining({
        providerTurnId: nativeTurnId,
        bindingVariant: "A",
      }),
    ]);

    await fixture.crash();
    const afterKill = readSnapshot(fixture.databaseFile, ids);
    expect(
      afterKill.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toEqual(beforeTurn);
    expect(afterKill.providerAttempts).toEqual(beforeKill.providerAttempts);
    expect(afterKill.checkpoints).toEqual([]);
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
        ARBOR_AH19_BINDING_VARIANT: "A",
        ARBOR_AH19_REPORT_URL: reportUrl,
      },
    });

    const recovered = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, ids),
      (snapshot) =>
        snapshot.session?.context_epoch === 1 &&
        snapshot.checkpoints.length === 1 &&
        snapshot.execution?.settlement_kind === "Completed" &&
        snapshot.workWait !== undefined,
      75_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 unsettled Native Turn did not recover: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${scenario.childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    const recoveredNativeTurn = recovered.providerTurns.find(
      (turn) => turn.provider_turn_id === nativeTurnId,
    );
    expect(
      recovered.providerTurns.filter(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toHaveLength(1);
    expect(recoveredNativeTurn?.manifest_id).toBe(beforeTurn?.manifest_id);
    expect(recoveredNativeTurn?.manifest_json).toBe(beforeTurn?.manifest_json);
    expect(recoveredNativeTurn?.portable_request_json).toBe(
      beforeTurn?.portable_request_json,
    );
    expect(recoveredNativeTurn?.output_contract_ref).toBe(
      "provider-native-compaction-v1",
    );
    expect(recoveredNativeTurn?.finish_reason).toBe("Stop");
    expect(
      recovered.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === nativeTurnId,
      ),
    ).toEqual([
      expect.objectContaining({
        attempt_no: 0,
        outcome: "Success",
        delivered_position: completePrefix.length,
      }),
    ]);
    const nativeRequests = providerRequests.filter(
      (event) => event.operationKind === "CompactionNative",
    );
    expect(nativeRequests).toHaveLength(1);
    expect(nativeRequests.map((event) => event.providerTurnId)).toEqual([
      nativeTurnId,
    ]);
    expect(
      recovered.checkpoints.filter(
        (entry) => entry.source_ref === nativeTurnId,
      ),
    ).toHaveLength(1);
    expect(fixture.daemonErrors).toEqual([]);
  }, 150_000);
  it.each([
    "truncated",
    "duplicate-terminal",
    "invalid-continuation",
    "identity-mismatch",
  ] as const)(
    "does not locally settle Native success when its canonical prefix is %s",
    async (corruption) => {
      const scenario = await startAtCheckpointBoundary(
        "AH12BeforeSuccessCommit",
      );
      const { fixture, project, workId, probe, reportUrl } = scenario;
      const executionId = probe.executionId;
      const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
      const ids = { sessionId: project.rootSessionId, executionId, workId };
      const beforeKill = readSnapshot(fixture.databaseFile, ids);
      const beforeTurn = beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      );
      const beforeAttempt = beforeKill.providerAttempts.find(
        (attempt) => attempt.provider_turn_id === nativeTurnId,
      );
      expect(beforeTurn).toMatchObject({
        output_contract_ref: "provider-native-compaction-v1",
        settled_at: null,
        manifest_json: expect.any(String),
      });
      expect(beforeAttempt).toMatchObject({
        outcome: "InProgress",
        delivered_position: 0,
      });

      await fixture.crash();
      await expireLeaseAfterOldDaemonExit(
        fixture,
        project.rootSessionId,
        executionId,
        workId,
      );
      corruptNativeSuccessPrefix(
        fixture.databaseFile,
        nativeTurnId,
        corruption,
        executionId,
      );
      const corrupted = readSnapshot(fixture.databaseFile, ids);
      expect(
        corrupted.providerAttempts.find(
          (attempt) => attempt.provider_turn_id === nativeTurnId,
        )?.outcome,
      ).toBe("InProgress");
      expect(
        corrupted.providerTurns.find(
          (turn) => turn.provider_turn_id === nativeTurnId,
        ),
      ).toEqual(beforeTurn);

      const restartResult = await fixture
        .restart({
          entry: childEntry,
          daemonEnvironment: {
            ARBOR_AH19_BOUNDARY: "none",
            ARBOR_AH19_BINDING_VARIANT: "A",
            ARBOR_AH19_REPORT_URL: reportUrl,
          },
        })
        .then(
          () => ({ healthy: true as const }),
          (error: unknown) => ({ healthy: false as const, error }),
        );
      let rejected: Ah19Snapshot;
      if (restartResult.healthy) {
        rejected = await waitForPublic(
          async () => readSnapshot(fixture.databaseFile, ids),
          (snapshot) =>
            snapshot.providerAttempts.some(
              (attempt) =>
                attempt.provider_turn_id === nativeTurnId &&
                attempt.outcome === "TerminalFailure",
            ),
          60_000,
        ).catch((error: unknown) => {
          throw new Error(
            `AH19 malformed Native prefix was not failed closed (${corruption}): ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${scenario.childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
          );
        });
      } else {
        const childFailure = scenario.childOutput
          .map((line) => {
            try {
              return JSON.parse(line) as {
                tag?: string;
                error?: {
                  cause?: { safeDiagnostic?: string };
                };
              };
            } catch {
              return undefined;
            }
          })
          .find((event) => event?.tag === "AH19_CHILD_ERROR");
        expect(childFailure?.error?.cause?.safeDiagnostic).toBe(
          "provider-turn-recovery-stopped",
        );
        rejected = readSnapshot(fixture.databaseFile, ids);
      }
      const rejectedTurn = rejected.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      );
      expect(rejectedTurn).toMatchObject({
        output_contract_ref: "provider-native-compaction-v1",
        finish_reason: "Failed",
      });
      expect(rejected.session?.context_epoch).toBe(0);
      expect(rejected.checkpoints).toEqual([]);
      expect(
        rejected.providerTurns.filter(
          (turn) => turn.provider_turn_id === nativeTurnId,
        ),
      ).toHaveLength(1);
      expect(
        providerRequests.filter(
          (event) => event.operationKind === "CompactionNative",
        ),
      ).toEqual([
        expect.objectContaining({
          providerTurnId: nativeTurnId,
          bindingVariant: "A",
        }),
      ]);
    },
    180_000,
  );
  it("locally commits the same settled Native receipt after a pre-checkpoint crash when the binding still matches", async () => {
    const scenario = await startAtCheckpointBoundary(
      "AH17BeforeCheckpointEpochCommit",
    );
    const { fixture, project, workId, probe, reportUrl } = scenario;
    const executionId = probe.executionId;
    const nativeTurnId = `ptn_${executionId}_1_native_compact_0`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    expect(beforeKill.session?.context_epoch).toBe(0);
    expect(beforeKill.checkpoints).toEqual([]);
    expect(
      beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toMatchObject({ settled_at: expect.any(String), finish_reason: "Stop" });
    expect(
      providerRequests.filter(
        (event) => event.operationKind === "CompactionNative",
      ),
    ).toHaveLength(1);

    await fixture.crash();
    const afterKill = readSnapshot(fixture.databaseFile, ids);
    expect(afterKill.session).toEqual(beforeKill.session);
    expect(afterKill.checkpoints).toEqual([]);
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
        ARBOR_AH19_BINDING_VARIANT: "A",
        ARBOR_AH19_REPORT_URL: reportUrl,
      },
    });

    const recovered = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, ids),
      (snapshot) =>
        snapshot.session?.context_epoch === 1 &&
        snapshot.checkpoints.length === 1 &&
        snapshot.execution?.settlement_kind === "Completed" &&
        snapshot.workWait !== undefined,
      75_000,
    );
    expect(recovered.checkpoints).toHaveLength(1);
    expect(
      recovered.providerTurns.filter(
        (turn) => turn.provider_turn_id === nativeTurnId,
      ),
    ).toHaveLength(1);
    expect(
      providerRequests.filter(
        (event) => event.operationKind === "CompactionNative",
      ),
    ).toHaveLength(1);
    expect(
      providerRequests.some(
        (event) =>
          event.bindingVariant === "A" &&
          event.operationKind === "Inference" &&
          event.items.some(
            (item) => item.opaqueItemRef === `ah19-opaque:${nativeTurnId}`,
          ),
      ),
    ).toBe(true);
    expect(
      providerRequests.some(
        (event) => event.operationKind === "CompactionSummary",
      ),
    ).toBe(false);
    expect(fixture.daemonErrors).toEqual([]);
  }, 150_000);
});
