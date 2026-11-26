import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { waitForPublic } from "../../support/public-client.js";
import {
  ah19AfterEach,
  ah19PersistedStateSummary,
  beginAh19PhaseDiagnostics,
  childEntry,
  corruptCompiledInferenceRequestHash,
  expireLeaseAfterOldDaemonExit,
  parseAh19HandshakeState,
  persistAh19StartupRecord,
  providerRequests,
  readConversationHistoryEvidence,
  readSnapshot,
  startAtCheckpointBoundary,
} from "./support.js";

afterEach(ah19AfterEach);

describe("restart binding qualification", () => {
  it("settles a terminal ConversationResponse from its pinned StepEffectsCommitted output after Native rebase", async () => {
    const diagnostic = beginAh19PhaseDiagnostics(
      "terminal ConversationResponse after Native rebase",
      "ah19-terminal-conversation-rebase",
    );
    const scenario = await startAtCheckpointBoundary(
      "AH11AfterStepEffectsCommit",
      { ARBOR_AH19_AH11_MATCH_INDEX: "1" },
      "ConversationResponse",
      true,
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const sourceInferenceTurnId = `ptn_${executionId}_0`;
    const nativeTurnId = `ptn_${executionId}_0_native_compact_0`;
    const replacementTurnId = `ptn_${executionId}_0_overflow_0`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    diagnostic.attach(fixture, childOutput);
    diagnostic.setPersistedState(() =>
      ah19PersistedStateSummary(readSnapshot(fixture.databaseFile, ids)),
    );
    expect(probe.providerTurnId).toBe(sourceInferenceTurnId);
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const responseJob = beforeKill.responseJobs[0];
    expect(responseJob).toMatchObject({
      state: "Running",
      response_body: null,
      response_execution_id: null,
    });
    expect(beforeKill.execution?.settlement_kind).toBeNull();
    expect(beforeKill.session?.context_epoch).toBe(0);
    expect(beforeKill.checkpoints).toEqual([]);
    const checkpointOwner = readConversationHistoryEvidence(
      fixture.databaseFile,
      {
        rootWorkspaceId: project.rootWorkspaceId,
        sessionId: project.rootSessionId,
      },
    ).owner;
    expect(checkpointOwner).toMatchObject({
      context_epoch: 1,
      checkpoint_kind: "ProviderNative",
      producer_execution_id: executionId,
      producer_provider_turn_id: nativeTurnId,
      binding_fingerprint: expect.any(String),
      checkpoint_ref: `ah19-opaque:${nativeTurnId}`,
    });
    const sourceStep = beforeKill.steps.find(
      (step) => step.logical_step_no === 0 && step.repair_attempt === 0,
    );
    expect(sourceStep).toMatchObject({
      provider_turn_id: sourceInferenceTurnId,
      state: "StepEffectsCommitted",
      successor_json: null,
      next_action_index: 0,
      model_output_session_sequence: expect.any(Number),
      decoded_output_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    const sourcedAnswer = beforeKill.sessionEntries.find(
      (entry) =>
        entry.sequence === sourceStep?.model_output_session_sequence &&
        entry.source_ref === `${replacementTurnId}:assistant`,
    );
    expect(sourcedAnswer?.entry_kind).toBe("ModelOutput");
    expect(sourcedAnswer?.item_type).toBe("AssistantMessage");
    expect(sourcedAnswer?.source_ref).toBe(`${replacementTurnId}:assistant`);
    expect(sourcedAnswer?.payload_json).toContain(
      "AH19 recovered terminal conversation answer.",
    );
    expect(beforeKill.actions).toEqual([]);
    expect(
      providerRequests.filter(
        (event) =>
          event.providerTurnId === sourceInferenceTurnId ||
          event.providerTurnId === nativeTurnId ||
          event.providerTurnId === replacementTurnId,
      ),
    ).toHaveLength(3);

    await fixture.crash();
    expect(readSnapshot(fixture.databaseFile, ids).steps).toEqual(
      beforeKill.steps,
    );
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
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_REPORT_URL: reportUrl,
          ARBOR_AH19_STARTUP_TRACE: "1",
        },
      })
      .catch((error: unknown) => {
        const failedSnapshot = readSnapshot(fixture.databaseFile, ids);
        const stepBinding = (() => {
          const db = new DatabaseSync(fixture.databaseFile, { readOnly: true });
          try {
            return db
              .prepare(
                `SELECT manifest_id FROM agent_loop_steps
                  WHERE execution_id = ? AND logical_step_no = 0 AND repair_attempt = 0`,
              )
              .get(executionId) as { manifest_id: string | null } | undefined;
          } finally {
            db.close();
          }
        })();
        const sourceTurn = failedSnapshot.providerTurns.find(
          (turn) => turn.provider_turn_id === sourceInferenceTurnId,
        );
        let sourceManifest: Record<string, unknown> = {};
        try {
          sourceManifest = JSON.parse(
            sourceTurn?.manifest_json ?? "{}",
          ) as Record<string, unknown>;
        } catch {
          sourceManifest = { invalid: true };
        }
        const conversationOwner = readConversationHistoryEvidence(
          fixture.databaseFile,
          {
            rootWorkspaceId: project.rootWorkspaceId,
            sessionId: project.rootSessionId,
          },
        ).owner;
        const replayEvidence = {
          driverManifestGate: {
            stepManifestId: stepBinding?.manifest_id,
            providerTurnManifestId: sourceTurn?.manifest_id,
            providerTurnIdMatches:
              sourceManifest.providerTurnId === sourceInferenceTurnId,
            executionIdMatches: sourceManifest.executionId === executionId,
            sessionIdMatches:
              sourceManifest.sessionId === project.rootSessionId,
            logicalStepNoMatches: sourceManifest.logicalStepNo === 0,
            repairAttemptMatches: sourceManifest.repairAttempt === 0,
            manifestIdMatches:
              stepBinding?.manifest_id == null ||
              stepBinding.manifest_id === sourceTurn?.manifest_id,
          },
          owner: conversationOwner,
          steps: failedSnapshot.steps,
          providerLinks: failedSnapshot.providerLinks,
          providerTurns: failedSnapshot.providerTurns.map((turn) => {
            let manifest: Record<string, unknown> = {};
            try {
              manifest = JSON.parse(turn.manifest_json ?? "{}") as Record<
                string,
                unknown
              >;
            } catch {
              manifest = { invalid: true };
            }
            return {
              providerTurnId: turn.provider_turn_id,
              executionId: turn.execution_id,
              sessionId: turn.session_id,
              contextEpoch: turn.context_epoch,
              manifestId: turn.manifest_id,
              settledAt: turn.settled_at,
              finishReason: turn.finish_reason,
              logicalStepNo: manifest.logicalStepNo,
              repairAttempt: manifest.repairAttempt,
              operationKind: manifest.operationKind,
              resolvedModelBindingFingerprint:
                manifest.resolvedModelBindingFingerprint,
              sourceAgentLoopStep: manifest.sourceAgentLoopStep,
              conversationCheckpoint: manifest.conversationCheckpoint,
            };
          }),
          providerAttempts: failedSnapshot.providerAttempts.map((attempt) => {
            let events: Array<Record<string, unknown>> = [];
            try {
              events = JSON.parse(attempt.canonical_event_prefix_json) as Array<
                Record<string, unknown>
              >;
            } catch {
              events = [];
            }
            return {
              providerTurnId: attempt.provider_turn_id,
              attemptNo: attempt.attempt_no,
              outcome: attempt.outcome,
              errorKind: attempt.provider_error_kind,
              deliveredPosition: attempt.delivered_position,
              eventTags: events.map((event) => event._tag),
            };
          }),
          execution: failedSnapshot.execution,
          responseJobs: failedSnapshot.responseJobs,
          sessionEpoch: failedSnapshot.session?.context_epoch,
          sessionCheckpoints: failedSnapshot.checkpoints,
        };
        persistAh19StartupRecord({
          kind: "startup-failure",
          boundary: "conversation-response-restart",
          process: parseAh19HandshakeState(error) ?? null,
          persistedState: ah19PersistedStateSummary(failedSnapshot),
        });
        const qualification = childOutput.flatMap((line) => {
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            return event.tag === "AH19_PROBE" &&
              typeof event.boundary === "string"
              ? [event.boundary]
              : [];
          } catch {
            return [];
          }
        });
        const qualificationStages = childOutput.flatMap((line) => {
          try {
            const event = JSON.parse(line) as {
              tag?: string;
              boundary?: string;
              stage?: string;
            };
            return event.tag === "AH19_PROBE" &&
              event.boundary === "AH19NativeCheckpointRecovery" &&
              typeof event.stage === "string"
              ? [event.stage]
              : [];
          } catch {
            return [];
          }
        });
        throw new Error(
          `AH19 ConversationResponse daemon restart failed: ${error instanceof Error ? error.message : String(error)}; qualification=${qualification.join("|")}; qualificationStages=${qualificationStages.join("|")}; providerRequests=${JSON.stringify(providerRequests.map(({ operationKind, bindingVariant }) => ({ operationKind, bindingVariant })))}; replayEvidence=${JSON.stringify(replayEvidence)}; persistedState=${JSON.stringify(ah19PersistedStateSummary(failedSnapshot))}`,
        );
      });
    const recovered = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, ids),
      (snapshot) =>
        snapshot.execution !== undefined &&
        snapshot.execution.settled_at !== null &&
        snapshot.responseJobs.some((job) => job.state === "Answered"),
      45_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH19 ConversationResponse terminal recovery did not converge: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(providerRequests)}; child=${childOutput.join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    const messageId = responseJob?.message_id;
    expect(messageId).toBeDefined();
    expect(
      recovered.execution,
      `AH19 ConversationResponse terminal mismatch: ${JSON.stringify({
        execution: recovered.execution,
        responseJobs: recovered.responseJobs,
        steps: recovered.steps,
        providerTurns: recovered.providerTurns.map((turn) => ({
          id: turn.provider_turn_id,
          epoch: turn.context_epoch,
          output: turn.output_contract_ref,
          settled: turn.settled_at,
          finish: turn.finish_reason,
        })),
        providerRequests: providerRequests.map((event) => ({
          id: event.providerTurnId,
          op: event.operationKind,
          binding: event.bindingVariant,
        })),
        child: childOutput
          .filter(
            (line) =>
              line.includes("AH19NativeCheckpointRecovery") ||
              line.includes("AH19_CHILD_ERROR"),
          )
          .slice(-12),
      })}`,
    ).toMatchObject({
      execution_id: executionId,
      settlement_kind: "Completed",
    });
    const recoveredStep = recovered.steps.find(
      (step) => step.logical_step_no === 0 && step.repair_attempt === 0,
    );
    expect(recoveredStep?.state).toBe("SettlementProposed");
    expect(recoveredStep?.successor_json).toBeNull();
    expect(recoveredStep?.decoded_output_hash).toBe(
      sourceStep?.decoded_output_hash,
    );
    expect(recoveredStep?.model_output_session_sequence).toBe(
      sourceStep?.model_output_session_sequence,
    );
    expect(recovered.responseJobs).toEqual([
      expect.objectContaining({
        message_id: messageId,
        state: "Answered",
        response_execution_id: executionId,
        response_body: "AH19 recovered terminal conversation answer.",
      }),
    ]);
    expect(
      recovered.sessionEntries.filter(
        (entry) =>
          entry.entry_kind === "ModelOutput" &&
          entry.item_type === "AssistantMessage" &&
          entry.source_ref === `${replacementTurnId}:assistant`,
      ),
    ).toEqual([sourcedAnswer]);
    expect(
      recovered.providerTurns.filter(
        (turn) =>
          turn.provider_turn_id === sourceInferenceTurnId ||
          turn.provider_turn_id === nativeTurnId ||
          turn.provider_turn_id === replacementTurnId,
      ),
    ).toHaveLength(3);
    const terminalBindingBSummary = providerRequests.filter(
      (event) =>
        event.bindingVariant === "B" &&
        event.operationKind === "CompactionSummary",
    );
    expect(terminalBindingBSummary).toHaveLength(1);
    expect(
      terminalBindingBSummary[0]?.items.some(
        (item) => item.opaqueItemRef === `ah19-opaque:${nativeTurnId}`,
      ),
    ).toBe(false);
    expect(
      providerRequests.filter((event) => event.bindingVariant === "B"),
    ).toHaveLength(1);
    expect(fixture.daemonErrors).toEqual([]);
    diagnostic.phase("terminal response recovery assertions passed");
  }, 180_000);
  it("fails closed on a corrupted compiled hash for the pinned terminal output before Summary", async () => {
    const diagnostic = beginAh19PhaseDiagnostics(
      "corrupted compiled hash for terminal output",
      "ah19-terminal-hash-corruption",
    );
    const scenario = await startAtCheckpointBoundary(
      "AH11AfterStepEffectsCommit",
      { ARBOR_AH19_AH11_MATCH_INDEX: "1" },
      "ConversationResponse",
      true,
    );
    const { fixture, project, workId, probe, reportUrl, childOutput } =
      scenario;
    const executionId = probe.executionId;
    const sourceInferenceTurnId = `ptn_${executionId}_0`;
    const replacementTurnId = `ptn_${executionId}_0_overflow_0`;
    const ids = { sessionId: project.rootSessionId, executionId, workId };
    diagnostic.attach(fixture, childOutput);
    diagnostic.setPersistedState(() =>
      ah19PersistedStateSummary(readSnapshot(fixture.databaseFile, ids)),
    );
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const sourceStep = beforeKill.steps.find(
      (step) => step.logical_step_no === 0 && step.repair_attempt === 0,
    );
    expect(sourceStep).toMatchObject({
      provider_turn_id: sourceInferenceTurnId,
      state: "StepEffectsCommitted",
      successor_json: null,
      next_action_index: 0,
    });
    expect(
      beforeKill.sessionEntries.some(
        (entry) =>
          entry.sequence === sourceStep?.model_output_session_sequence &&
          entry.source_ref === `${replacementTurnId}:assistant`,
      ),
    ).toBe(true);
    expect(beforeKill.session?.context_epoch).toBe(0);
    expect(beforeKill.checkpoints).toEqual([]);
    const checkpointOwner = readConversationHistoryEvidence(
      fixture.databaseFile,
      {
        rootWorkspaceId: project.rootWorkspaceId,
        sessionId: project.rootSessionId,
      },
    ).owner;
    expect(checkpointOwner).toMatchObject({
      context_epoch: 1,
      checkpoint_kind: "ProviderNative",
      producer_execution_id: executionId,
      checkpoint_ref: expect.any(String),
    });
    await fixture.crash();
    await expireLeaseAfterOldDaemonExit(
      fixture,
      project.rootSessionId,
      executionId,
      workId,
    );
    const corrupted = corruptCompiledInferenceRequestHash(
      fixture.databaseFile,
      replacementTurnId,
    );
    expect(corrupted.originalHash).toMatch(/^[0-9a-f]{8}$/u);
    expect(corrupted.corruptedHash).not.toBe(corrupted.originalHash);
    await fixture
      .restart({
        entry: childEntry,
        daemonEnvironment: {
          ARBOR_AH19_BOUNDARY: "none",
          ARBOR_AH19_BINDING_VARIANT: "B",
          ARBOR_AH19_REPORT_URL: reportUrl,
        },
      })
      .then(
        () => undefined,
        () => undefined,
      );
    const failedClosed = await waitForPublic(
      async () => {
        const childFailure = childOutput
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
          .find(
            (event) =>
              event?.tag === "AH19_CHILD_ERROR" &&
              event.error?.reason === "AgentLoopStepReplayBindingMismatch",
          );
        return {
          snapshot: readSnapshot(fixture.databaseFile, ids),
          childFailure,
        };
      },
      (value) => value.childFailure !== undefined,
      20_000,
    );
    expect(failedClosed.snapshot.leases[0]?.generation).toBe(1);
    expect(failedClosed.snapshot.session?.context_epoch).toBe(0);
    expect(failedClosed.snapshot.checkpoints).toEqual([]);
    expect(
      readConversationHistoryEvidence(fixture.databaseFile, {
        rootWorkspaceId: project.rootWorkspaceId,
        sessionId: project.rootSessionId,
      }).owner,
    ).toEqual(checkpointOwner);
    expect(
      failedClosed.snapshot.steps.find(
        (step) => step.logical_step_no === 0 && step.repair_attempt === 0,
      ),
    ).toEqual(sourceStep);
    expect(failedClosed.snapshot.execution?.settlement_kind).toBeNull();
    expect(
      providerRequests.filter((event) => event.bindingVariant === "B"),
    ).toEqual([]);
    expect(fixture.daemonErrors).toEqual([]);
  }, 180_000);
});
