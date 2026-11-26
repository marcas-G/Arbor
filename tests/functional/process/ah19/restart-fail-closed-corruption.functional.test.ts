import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { waitForPublic } from "../../support/public-client.js";
import {
  ah19AfterEach,
  ah19PersistedStateSummary,
  beginAh19PhaseDiagnostics,
  childEntry,
  corruptOrdinaryNativeManifestField,
  corruptOrdinaryNativeSourceIdentity,
  expireLeaseAfterOldDaemonExit,
  markStepNextReadyWithoutSuccessor,
  persistAh19StartupRecord,
  providerRequests,
  readConversationHistoryEvidence,
  readSnapshot,
  startAtCheckpointBoundary,
  startOrdinaryNativeAtCheckpointBoundary,
} from "./support.js";

afterEach(ah19AfterEach);

describe("AH19 restart binding qualification", () => {
  it.each(["WorkStartup", "ConversationCommon"] as const)(
    "fails closed at %s when the checkpoint owner is NextStepReady without a successor",
    async (route) => {
      const scenario =
        route === "WorkStartup"
          ? await startOrdinaryNativeAtCheckpointBoundary(
              "AH17AfterCheckpointEpochCommit",
            )
          : await startAtCheckpointBoundary(
              "AH19AfterConversationCheckpointOwnerCommit",
              {},
              "ConversationResponse",
            );
      const { fixture, project, workId, childOutput } = scenario;
      const executionId = scenario.probe.executionId;
      const nativeTurnId =
        "native" in scenario
          ? scenario.native.providerTurnId
          : scenario.probe.providerTurnId;
      const ids = { sessionId: project.rootSessionId, executionId, workId };
      const before = readSnapshot(fixture.databaseFile, ids);
      const nativeRow = before.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      );
      const manifest = JSON.parse(nativeRow?.manifest_json ?? "{}") as {
        sourceAgentLoopStep?: { logicalStepNo: number; repairAttempt: number };
      };
      const source =
        route === "WorkStartup"
          ? manifest.sourceAgentLoopStep
          : (() => {
              const link = before.providerLinks.find(
                (candidate) => candidate.provider_turn_id === nativeTurnId,
              );
              expect(link).toMatchObject({
                role: "OverflowCompaction",
              });
              return link === undefined
                ? undefined
                : {
                    logicalStepNo: link.logical_step_no,
                    repairAttempt: link.repair_attempt,
                  };
            })();
      expect(source).toBeDefined();
      expect(scenario.probe.boundary).toBe(
        route === "WorkStartup"
          ? "AH17AfterCheckpointEpochCommit"
          : "AH19AfterConversationCheckpointOwnerCommit",
      );
      expect(scenario.probe.boundary).not.toBe(
        route === "WorkStartup"
          ? "AH19AfterConversationCheckpointOwnerCommit"
          : "AH17AfterCheckpointEpochCommit",
      );
      if (route === "ConversationCommon") {
        const evidence = readConversationHistoryEvidence(fixture.databaseFile, {
          rootWorkspaceId: project.rootWorkspaceId,
          sessionId: project.rootSessionId,
        });
        const owner = evidence.owner;
        const currentJob = evidence.jobs.find(
          (job) => job.active_execution_id === executionId,
        );
        expect(owner).toMatchObject({
          context_epoch: 1,
          checkpoint_kind: "ProviderNative",
          producer_execution_id: executionId,
          producer_provider_turn_id: nativeTurnId,
        });
        expect(before.session?.context_epoch).toBe(0);
        expect(before.checkpoints).toEqual([]);
        expect(evidence.messages).toHaveLength(2);
        expect(evidence.messages[1]).toMatchObject({ state: "Pending" });
        expect(currentJob).toMatchObject({
          state: "Running",
          active_execution_id: executionId,
        });
        expect(evidence.jobs).toHaveLength(2);
        expect(evidence.jobs.some((job) => job.state === "Answered")).toBe(
          true,
        );
      } else {
        expect(before.session?.context_epoch).toBe(1);
        expect(before.checkpoints).toHaveLength(1);
      }
      await fixture.crash();
      await expireLeaseAfterOldDaemonExit(
        fixture,
        project.rootSessionId,
        executionId,
        workId,
      );
      markStepNextReadyWithoutSuccessor(
        fixture.databaseFile,
        executionId,
        source?.logicalStepNo ?? -1,
        source?.repairAttempt ?? -1,
      );
      const requestsBeforeRestart = providerRequests.length;
      await fixture
        .restart({
          entry: childEntry,
          daemonEnvironment: {
            ARBOR_AH19_BOUNDARY: "none",
            ARBOR_AH19_BINDING_VARIANT: "A",
            ...(route === "WorkStartup"
              ? { ARBOR_AH19_ORDINARY_WORK: "1" }
              : {}),
            ARBOR_AH19_CAPTURE_EXIT: "1",
            ...(scenario.reportUrl === undefined
              ? {}
              : { ARBOR_AH19_REPORT_URL: scenario.reportUrl }),
          },
        })
        .catch(() => undefined);
      const outcome = await waitForPublic(
        async () => {
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
          return {
            childError,
            requests: providerRequests.length - requestsBeforeRestart,
          };
        },
        (state) => state.childError !== undefined || state.requests > 0,
        20_000,
      );
      expect(outcome.childError?.error?.reason).toBe(
        "AgentLoopStepReplayBindingMismatch",
      );
      expect(outcome.requests).toBe(0);
      const after = readSnapshot(fixture.databaseFile, ids);
      expect(after.session?.context_epoch).toBe(
        route === "WorkStartup" ? 1 : 0,
      );
      expect(after.checkpoints).toEqual(before.checkpoints);
      expect(after.execution?.settled_at).toBeNull();
      expect(after.steps).toContainEqual(
        expect.objectContaining({
          logical_step_no: source?.logicalStepNo,
          repair_attempt: source?.repairAttempt,
          state: "NextStepReady",
          successor_json: null,
        }),
      );
    },
    150_000,
  );
  const failClosedOnOrdinaryNativeManifestCorruption = async (
    field:
      | "logicalStepNo"
      | "repairAttempt"
      | "providerTurnId"
      | "executionId"
      | "bindingFingerprint",
    withPhaseDiagnostics: boolean,
  ) => {
    const diagnostic = withPhaseDiagnostics
      ? beginAh19PhaseDiagnostics(
          `fails closed on an ordinary Native manifest with corrupted ${field} evidence`,
          `ordinary-native-manifest-${field}`,
        )
      : undefined;
    const scenario = await startOrdinaryNativeAtCheckpointBoundary(
      "AH17AfterCheckpointEpochCommit",
      withPhaseDiagnostics,
    );
    const { fixture, project, workId, native, probe, childOutput } = scenario;
    const executionId = probe.executionId;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    diagnostic?.attach(fixture, childOutput);
    diagnostic?.setPersistedState(() =>
      ah19PersistedStateSummary(readSnapshot(fixture.databaseFile, ids)),
    );
    diagnostic?.phase("child START/LISTEN gen0 complete", { executionId });
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const originalNativeRow = beforeKill.providerTurns.find(
      (turn) => turn.provider_turn_id === native.providerTurnId,
    );
    expect(beforeKill.session?.context_epoch).toBe(1);
    expect(beforeKill.checkpoints).toHaveLength(1);
    expect(
      beforeKill.providerLinks.some(
        (link) =>
          link.provider_turn_id === native.providerTurnId &&
          link.role === "OverflowCompaction",
      ),
    ).toBe(false);
    await fixture.crash();
    diagnostic?.phase("crash gen0 complete", {
      nativeTurnId: native.providerTurnId,
    });
    await expireLeaseAfterOldDaemonExit(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    diagnostic?.phase("lease expired after old daemon exit", {
      leases: readSnapshot(fixture.databaseFile, ids).leases,
    });
    corruptOrdinaryNativeSourceIdentity(
      fixture.databaseFile,
      native.providerTurnId,
      field,
    );
    diagnostic?.phase("manifest mutated", {
      providerTurnId: native.providerTurnId,
      field,
    });
    await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_CAPTURE_EXIT: "1",
          ...(withPhaseDiagnostics ? { ARBOR_AH19_STARTUP_TRACE: "1" } : {}),
        },
      })
      .catch(() => undefined);
    diagnostic?.phase("gen1 restart returned", {
      childStart: childOutput.filter((line) =>
        line.includes("AH19_CHILD_START"),
      ),
    });
    const restartProcess = fixture.daemonProcessSnapshot();
    if (withPhaseDiagnostics) {
      persistAh19StartupRecord({
        kind: "restart-process",
        process:
          restartProcess === null
            ? null
            : {
                pid: restartProcess.pid,
                exitCode: restartProcess.exitCode,
                signalCode: restartProcess.signalCode,
                killed: restartProcess.killed,
                alive: restartProcess.alive,
              },
      });
    }
    const childError = await waitForPublic(
      async () =>
        childOutput
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
          .find((event) => event?.tag === "AH19_CHILD_ERROR"),
      (event) => event !== undefined,
      20_000,
    );
    expect(childError?.error?.reason).toBe(
      "AgentLoopStepReplayBindingMismatch",
    );
    diagnostic?.phase("failclosed marker observed");
    const rejected = readSnapshot(fixture.databaseFile, ids);
    expect(rejected.session?.context_epoch).toBe(1);
    expect(rejected.checkpoints).toEqual(beforeKill.checkpoints);
    expect(
      rejected.providerTurns.find(
        (turn) => turn.provider_turn_id === native.providerTurnId,
      ),
    ).toMatchObject({
      manifest_id: originalNativeRow?.manifest_id,
      settled_at: originalNativeRow?.settled_at,
    });
    expect(rejected.execution?.settled_at).toBeNull();
    expect(rejected.leases.at(-1)?.generation).toBe(1);
    expect(
      providerRequests.filter((request) => request.bindingVariant === "B"),
    ).toHaveLength(0);
    expect(fixture.daemonErrors).toEqual([]);
  };
  it.each(["logicalStepNo", "providerTurnId", "bindingFingerprint"] as const)(
    "fails closed on an ordinary Native manifest with corrupted %s evidence",
    async (field) => failClosedOnOrdinaryNativeManifestCorruption(field, true),
    160_000,
  );
  it.each(["repairAttempt", "executionId"] as const)(
    "fails closed on an ordinary Native manifest with corrupted %s evidence",
    async (field) => failClosedOnOrdinaryNativeManifestCorruption(field, true),
    180_000,
  );
  it.each(["compiledRequestHash", "contextEpoch"] as const)(
    "rejects ordinary Native recovery at the manifest %s check after process loss",
    async (field) => {
      const scenario = await startOrdinaryNativeAtCheckpointBoundary(
        "AH17AfterCheckpointEpochCommit",
      );
      const {
        fixture,
        project,
        workId,
        native,
        probe,
        childOutput,
        reportUrl,
      } = scenario;
      const executionId = probe.executionId;
      const nativeTurnId = native.providerTurnId;
      const ids = { sessionId: project.rootSessionId, executionId, workId };
      const beforeKill = readSnapshot(fixture.databaseFile, ids);
      const nativeBeforeKill = beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      );
      const nativeManifestBeforeKill = JSON.parse(
        nativeBeforeKill?.manifest_json ?? "{}",
      ) as Record<string, unknown>;
      const nativeCheckpointBeforeKill = JSON.parse(
        beforeKill.checkpoints[0]?.payload_json ?? "{}",
      ) as Record<string, unknown>;
      const portableRequestBeforeKill =
        nativeBeforeKill?.portable_request_json ?? "";
      expect(beforeKill.session?.context_epoch).toBe(1);
      expect(beforeKill.checkpoints).toHaveLength(1);
      expect(beforeKill.checkpoints[0]?.source_ref).toBe(nativeTurnId);
      expect(nativeManifestBeforeKill.contextEpoch).toBe(
        nativeCheckpointBeforeKill.fromEpoch,
      );
      expect(nativeManifestBeforeKill.compiledRequestHash).toBe(
        createHash("sha256").update(portableRequestBeforeKill).digest("hex"),
      );
      expect(nativeBeforeKill).toMatchObject({
        context_epoch: 0,
        output_contract_ref: "provider-native-compaction-v1",
        settled_at: expect.any(String),
        finish_reason: "Stop",
      });
      expect(
        beforeKill.providerAttempts.filter(
          (attempt) => attempt.provider_turn_id === nativeTurnId,
        ),
      ).toEqual([
        expect.objectContaining({ attempt_no: 0, outcome: "Success" }),
      ]);
      expect(
        beforeKill.providerLinks.some(
          (link) => link.provider_turn_id === nativeTurnId,
        ),
      ).toBe(false);
      const nativeRequestCount = providerRequests.filter(
        (request) => request.providerTurnId === nativeTurnId,
      ).length;
      expect(nativeRequestCount).toBe(1);

      await fixture.crash();
      await expireLeaseAfterOldDaemonExit(
        fixture,
        project.rootSessionId,
        executionId,
        workId,
      );
      const corruption = corruptOrdinaryNativeManifestField(
        fixture.databaseFile,
        nativeTurnId,
        field,
      );
      const corruptedSnapshot = readSnapshot(fixture.databaseFile, ids);
      const corruptedNative = corruptedSnapshot.providerTurns.find(
        (turn) => turn.provider_turn_id === nativeTurnId,
      );
      expect(corruptedNative?.portable_request_json).toBe(
        corruption.portableRequestJson,
      );
      expect(JSON.parse(corruptedNative?.manifest_json ?? "{}")[field]).toBe(
        corruption.corruptedValue,
      );
      const corruptedNativeManifest = JSON.parse(
        corruptedNative?.manifest_json ?? "{}",
      ) as Record<string, unknown>;
      expect({
        ...corruptedNativeManifest,
        [field]: nativeManifestBeforeKill[field],
      }).toEqual(nativeManifestBeforeKill);
      expect(corruptedSnapshot.session?.context_epoch).toBe(1);
      expect(corruptedSnapshot.checkpoints).toEqual(beforeKill.checkpoints);

      const requestsBeforeRestart = providerRequests.length;
      await fixture
        .restart({
          entry: childEntry,
          daemonEnvironment: {
            ARBOR_AH19_BOUNDARY: "none",
            ARBOR_AH19_BINDING_VARIANT: "A",
            ARBOR_AH19_ORDINARY_WORK: "1",
            ARBOR_AH19_REPORT_URL: reportUrl,
            ARBOR_AH19_CAPTURE_EXIT: "1",
          },
        })
        .catch(() => undefined);

      const rejection = await waitForPublic(
        async () => {
          const stageLine = childOutput.find((line) =>
            line.includes("NativeStartupManifestChecks:"),
          );
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
          return { stageLine, childError };
        },
        (state) =>
          state.stageLine !== undefined && state.childError !== undefined,
        30_000,
      );
      const diagnostic = JSON.parse(rejection.stageLine ?? "{}") as {
        stage?: string;
      };
      const checkValues = Object.fromEntries(
        (diagnostic.stage ?? "")
          .slice("NativeStartupManifestChecks:".length)
          .split(",")
          .map((check) => check.split("=")),
      );
      expect(checkValues).toEqual({
        checkpoint: "true",
        providerTurn: "true",
        execution: "true",
        session: "true",
        source: "true",
        step: "true",
        sourceProviderTurn: "true",
        stepState: "true",
        sourceLinkAbsent: "true",
        frontier: "true",
        receipt: "true",
        operation: "true",
        bindingFingerprint: "true",
        contextEpoch: field === "contextEpoch" ? "false" : "true",
        compiledRequestHash: field === "compiledRequestHash" ? "false" : "true",
      });
      expect(rejection.childError?.error?.reason).toBe(
        "AgentLoopStepReplayBindingMismatch",
      );

      const rejected = readSnapshot(fixture.databaseFile, ids);
      expect(rejected.leases.at(-1)?.generation).toBe(1);
      expect(rejected.session?.context_epoch).toBe(1);
      expect(rejected.checkpoints).toEqual(beforeKill.checkpoints);
      expect(rejected.steps).toEqual(beforeKill.steps);
      expect(rejected.execution).toEqual(beforeKill.execution);
      expect(
        rejected.providerTurns.filter(
          (turn) => turn.provider_turn_id === nativeTurnId,
        ),
      ).toHaveLength(1);
      expect(
        rejected.providerAttempts.filter(
          (attempt) => attempt.provider_turn_id === nativeTurnId,
        ),
      ).toEqual([
        expect.objectContaining({ attempt_no: 0, outcome: "Success" }),
      ]);
      expect(providerRequests).toHaveLength(requestsBeforeRestart);
      expect(
        providerRequests.filter(
          (request) => request.providerTurnId === nativeTurnId,
        ),
      ).toHaveLength(nativeRequestCount);
    },
    150_000,
  );
});
