import { afterEach, describe, expect, it } from "vitest";
import {
  ProviderTurnId,
  parse,
} from "../../../../packages/domain/src/index.js";
import { waitForPublic } from "../../support/public-client.js";
import {
  ah19AfterEach,
  ah19PersistedStateSummary,
  appendSecondOrdinaryNativeCandidate,
  beginAh19PhaseDiagnostics,
  childEntry,
  corruptNativeManifestFrontierHalfNull,
  expireLeaseAfterOldDaemonExit,
  providerRequests,
  readSnapshot,
  startOrdinaryNativeAtCheckpointBoundary,
} from "./support.js";

afterEach(ah19AfterEach);

describe("AH19 restart binding qualification", () => {
  it.each([
    "AH17BeforeCheckpointEpochCommit",
    "AH17AfterCheckpointEpochCommit",
  ] as const)(
    "recovers ordinary Native source identity at %s without replaying the ProviderTurn",
    async (boundary) => {
      const scenario = await startOrdinaryNativeAtCheckpointBoundary(boundary);
      const { fixture, project, workId, native, reportUrl, childOutput } =
        scenario;
      const executionId = scenario.probe.executionId;
      const nativeTurnId = native.providerTurnId;
      const ids = { sessionId: project.rootSessionId, executionId, workId };
      const beforeRestart = readSnapshot(fixture.databaseFile, ids);
      const nativeRow = beforeRestart.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      );
      const manifest = JSON.parse(nativeRow?.manifest_json ?? "{}") as {
        sourceAgentLoopStep?: {
          executionId: string;
          logicalStepNo: number;
          repairAttempt: number;
          providerTurnId: string;
        };
        inputFrontier?: {
          firstSequence: number | null;
          lastSequence: number | null;
        };
      };
      const sourceStep = beforeRestart.steps.find(
        (step) =>
          step.logical_step_no ===
            manifest.sourceAgentLoopStep?.logicalStepNo &&
          step.repair_attempt === manifest.sourceAgentLoopStep?.repairAttempt,
      );
      expect(manifest.sourceAgentLoopStep).toEqual({
        executionId,
        logicalStepNo: sourceStep?.logical_step_no,
        repairAttempt: sourceStep?.repair_attempt,
        providerTurnId: sourceStep?.provider_turn_id,
      });
      expect(beforeRestart.session?.context_epoch).toBe(
        boundary === "AH17BeforeCheckpointEpochCommit" ? 0 : 1,
      );
      expect(beforeRestart.checkpoints).toHaveLength(
        boundary === "AH17BeforeCheckpointEpochCommit" ? 0 : 1,
      );
      const providerRequestCount = providerRequests.length;
      const nativeCount = providerRequests.filter(
        (request) => request.providerTurnId === nativeTurnId,
      ).length;
      await fixture.crash();
      await expireLeaseAfterOldDaemonExit(
        fixture,
        project.rootSessionId,
        executionId,
        workId,
      );
      await fixture
        .restart({
          entry: childEntry,
          daemonEnvironment: {
            ARBOR_AH19_BOUNDARY: "none",
            ARBOR_AH19_BINDING_VARIANT: "A",
            ARBOR_AH19_REPORT_URL: reportUrl,
            ARBOR_AH19_CAPTURE_EXIT: "1",
          },
        })
        .catch((error: unknown) => {
          throw new Error(
            `ordinary Native daemon restart failed: ${error instanceof Error ? error.message : String(error)} stderr=${JSON.stringify(fixture.daemonErrors)} stdout=${JSON.stringify(childOutput.filter((line) => line.includes("AH19_CHILD_ERROR") || line.includes("AH19_CHILD_EXIT") || line.includes("AH19_CHILD_START")))} lease=${JSON.stringify(readSnapshot(fixture.databaseFile, ids).leases)} turns=${JSON.stringify(
              readSnapshot(fixture.databaseFile, ids).providerTurns.map(
                ({
                  provider_turn_id,
                  context_epoch,
                  settled_at,
                  finish_reason,
                  output_contract_ref,
                  manifest_json,
                }) => ({
                  provider_turn_id,
                  context_epoch,
                  settled_at,
                  finish_reason,
                  output_contract_ref,
                  sourceAgentLoopStep: (() => {
                    try {
                      return (
                        JSON.parse(manifest_json ?? "{}") as Record<
                          string,
                          unknown
                        >
                      ).sourceAgentLoopStep;
                    } catch {
                      return "invalid";
                    }
                  })(),
                }),
              ),
            )} session=${JSON.stringify(readSnapshot(fixture.databaseFile, ids).session)} steps=${JSON.stringify(readSnapshot(fixture.databaseFile, ids).steps)}`,
          );
        });

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
      const resumedSnapshot = readSnapshot(fixture.databaseFile, ids);
      if (providerRequests.length <= providerRequestCount) {
        throw new Error(
          `ordinary Native restart stalled: requests=${JSON.stringify(providerRequests.map(({ operationKind, providerTurnId, bindingVariant }) => ({ operationKind, providerTurnId, bindingVariant })))} daemonErrors=${JSON.stringify(fixture.daemonErrors)} probes=${JSON.stringify(childOutput.filter((line) => line.includes("AH19NativeCheckpointRecovery") || line.includes("AH19_CHILD_ERROR")))} sessionEpoch=${resumedSnapshot.session?.context_epoch} lease=${JSON.stringify(resumedSnapshot.leases)}`,
        );
      }
      const resumedInference = providerRequests.find(
        (request) =>
          request.operationKind === "Inference" &&
          request.providerTurnId ===
            manifest.sourceAgentLoopStep?.providerTurnId,
      );
      expect(resumedSnapshot.checkpoints).toHaveLength(1);
      expect(
        resumedInference,
        `expected source inference ${manifest.sourceAgentLoopStep?.providerTurnId}; requests=${JSON.stringify(providerRequests.map(({ operationKind, providerTurnId }) => ({ operationKind, providerTurnId })))}`,
      ).toBeDefined();
      expect(resumedInference?.items ?? []).toContainEqual(
        expect.objectContaining({
          _tag: "CompactionCheckpoint",
          implementation: "ProviderNative",
          opaqueItemRef: `ah19-opaque:${nativeTurnId}`,
        }),
      );
      expect(
        providerRequests.filter(
          (request) => request.operationKind === "CompactionNative",
        ),
      ).toHaveLength(1);
      expect(
        providerRequests.filter(
          (request) => request.providerTurnId === nativeTurnId,
        ),
      ).toHaveLength(nativeCount);
      expect(providerRequests.length).toBeGreaterThanOrEqual(
        providerRequestCount,
      );
      expect(resumedSnapshot.steps).toContainEqual(
        expect.objectContaining({
          logical_step_no: manifest.sourceAgentLoopStep?.logicalStepNo,
          repair_attempt: manifest.sourceAgentLoopStep?.repairAttempt,
          provider_turn_id: manifest.sourceAgentLoopStep?.providerTurnId,
        }),
      );
      expect(resumedSnapshot.checkpoints[0]?.source_ref).toBe(nativeTurnId);
      expect(
        resumedSnapshot.providerLinks.some(
          (link) =>
            link.provider_turn_id === nativeTurnId &&
            link.role === "OverflowCompaction",
        ),
      ).toBe(false);
      expect(fixture.daemonErrors).toEqual([]);
      expect(manifest.inputFrontier).toMatchObject({
        firstSequence: expect.any(Number),
        lastSequence: expect.any(Number),
      });
    },
    180_000,
  );
  it("fails closed when ordinary Native startup has two same-epoch candidates", async () => {
    const scenario = await startOrdinaryNativeAtCheckpointBoundary(
      "AH17BeforeCheckpointEpochCommit",
    );
    const { fixture, project, workId, native, probe, childOutput } = scenario;
    const ids = {
      sessionId: project.rootSessionId,
      executionId: probe.executionId,
      workId,
    };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    expect(beforeKill.session?.context_epoch).toBe(0);
    expect(beforeKill.checkpoints).toHaveLength(0);
    expect(
      beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === native.providerTurnId,
      ),
    ).toMatchObject({
      settled_at: expect.any(String),
      finish_reason: "Stop",
      output_contract_ref: "provider-native-compaction-v1",
    });
    expect(
      beforeKill.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === native.providerTurnId,
      ),
    ).toEqual([expect.objectContaining({ outcome: "Success" })]);
    await fixture.crash();
    await expireLeaseAfterOldDaemonExit(
      fixture,
      project.rootSessionId,
      probe.executionId,
      workId,
    );
    const appended = appendSecondOrdinaryNativeCandidate(
      fixture.databaseFile,
      native.providerTurnId,
    );
    expect(appended.candidateCount).toBe(2);
    expect(parse(ProviderTurnId)(appended.secondTurnId)).toBe(
      appended.secondTurnId,
    );
    expect(appended.secondTurnId).not.toBe(native.providerTurnId);
    expect(appended.secondManifestId).toMatch(
      /^mft_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    const beforeRestart = readSnapshot(fixture.databaseFile, ids);
    const requestsBeforeRestart = providerRequests.length;
    await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_BINDING_VARIANT: "A",
          ARBOR_AH19_ORDINARY_WORK: "1",
          ARBOR_AH19_CAPTURE_EXIT: "1",
        },
      })
      .catch(() => undefined);
    const outcome = await waitForPublic(
      async () => ({
        stage: childOutput.find((line) =>
          line.includes("NativeCompactionCandidateAmbiguity:count=2"),
        ),
        snapshot: readSnapshot(fixture.databaseFile, ids),
      }),
      (state) => state.stage !== undefined,
      30_000,
    );
    expect(outcome.stage).toContain(
      "NativeCompactionCandidateAmbiguity:count=2",
    );
    expect(outcome.snapshot.session?.context_epoch).toBe(0);
    expect(outcome.snapshot.checkpoints).toEqual(beforeRestart.checkpoints);
    expect(outcome.snapshot.steps).toEqual(beforeRestart.steps);
    expect(outcome.snapshot.execution?.settled_at).toBeNull();
    expect(providerRequests).toHaveLength(requestsBeforeRestart);
    expect(
      providerRequests.filter(
        (request) => request.providerTurnId === native.providerTurnId,
      ),
    ).toHaveLength(1);
  }, 150_000);
  const failClosedForHalfNullOrdinaryNativeFrontier = async (
    nullSide: "firstSequence" | "lastSequence",
  ) => {
    const diagnostic =
      nullSide === "lastSequence"
        ? beginAh19PhaseDiagnostics(
            "fails closed after restart when an ordinary Native frontier has only lastSequence null",
            "ordinary-native-lastSequence-null",
          )
        : undefined;
    const scenario = await startOrdinaryNativeAtCheckpointBoundary(
      "AH17AfterCheckpointEpochCommit",
    );
    const { fixture, project, workId, native, probe, childOutput } = scenario;
    const ids = {
      sessionId: project.rootSessionId,
      executionId: probe.executionId,
      workId,
    };
    diagnostic?.attach(fixture, childOutput);
    diagnostic?.setPersistedState(() =>
      ah19PersistedStateSummary(readSnapshot(fixture.databaseFile, ids)),
    );
    diagnostic?.phase("gen0 checkpoint boundary ready", {
      executionId: probe.executionId,
      providerTurnId: native.providerTurnId,
    });
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    expect(beforeKill.session?.context_epoch).toBe(1);
    expect(beforeKill.checkpoints).toHaveLength(1);
    await fixture.crash();
    diagnostic?.phase("gen0 daemon crashed");
    await expireLeaseAfterOldDaemonExit(
      fixture,
      project.rootSessionId,
      probe.executionId,
      workId,
    );
    diagnostic?.phase("lease expired after old daemon exit");
    corruptNativeManifestFrontierHalfNull(
      fixture.databaseFile,
      native.providerTurnId,
      nullSide,
    );
    diagnostic?.phase("manifest frontier mutated", { nullSide });
    const corrupted = readSnapshot(fixture.databaseFile, ids);
    const changedTurn = corrupted.providerTurns.find(
      (turn) => turn.provider_turn_id === native.providerTurnId,
    );
    const frontier = JSON.parse(changedTurn?.manifest_json ?? "{}")
      .inputFrontier as {
      firstSequence: number | null;
      lastSequence: number | null;
    };
    expect(frontier[nullSide]).toBeNull();
    expect(
      frontier[nullSide === "firstSequence" ? "lastSequence" : "firstSequence"],
    ).toEqual(expect.any(Number));
    const requestsBeforeRestart = providerRequests.length;
    await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_BINDING_VARIANT: "A",
          ARBOR_AH19_ORDINARY_WORK: "1",
          ARBOR_AH19_CAPTURE_EXIT: "1",
        },
      })
      .catch(() => undefined);
    diagnostic?.phase("gen1 restart returned");
    const outcome = await waitForPublic(
      async () => ({
        stage: childOutput.find((line) =>
          line.includes("NativeCheckpointEvidence:frontier=false:source=true"),
        ),
        snapshot: readSnapshot(fixture.databaseFile, ids),
      }),
      (state) => state.stage !== undefined,
      30_000,
    );
    diagnostic?.phase("fail-closed frontier marker observed", {
      stage: outcome.stage,
    });
    expect(outcome.stage).toContain(
      "NativeCheckpointEvidence:frontier=false:source=true",
    );
    expect(outcome.snapshot.session?.context_epoch).toBe(1);
    expect(outcome.snapshot.checkpoints).toEqual(beforeKill.checkpoints);
    expect(outcome.snapshot.steps).toEqual(beforeKill.steps);
    expect(outcome.snapshot.execution?.settled_at).toBeNull();
    expect(providerRequests).toHaveLength(requestsBeforeRestart);
  };
  it(
    "fails closed after restart when an ordinary Native frontier has only firstSequence null",
    () => failClosedForHalfNullOrdinaryNativeFrontier("firstSequence"),
    150_000,
  );

  it(
    "fails closed after restart when an ordinary Native frontier has only lastSequence null",
    () => failClosedForHalfNullOrdinaryNativeFrontier("lastSequence"),
    180_000,
  );
});
