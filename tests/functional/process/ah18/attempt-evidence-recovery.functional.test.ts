import { afterEach, describe, expect, it } from "vitest";
import { waitForPublic } from "../../support/public-client.js";
import {
  ah18AfterEach,
  expireLeaseAfterOldDaemonExit,
  readSnapshot,
  startAtBoundary,
} from "./support.js";

afterEach(ah18AfterEach);

describe("AH18 linked overflow compaction recovery", () => {
  it("recovers from terminal Attempt evidence when the original failTurn transaction is killed before commit", async () => {
    const boundary = "AH18BeforeInferenceFailTurnCommit";
    const scenario = await startAtBoundary(boundary);
    const { fixture, provider, project, workId, boundaryProbe } = scenario;
    const executionId = boundaryProbe.executionId;
    const initialInferenceId = `ptn_${executionId}_0`;
    const compactionId = `ptn_${executionId}_0_compact_0`;
    const replacementId = `ptn_${executionId}_0_overflow_0`;
    expect(boundaryProbe.providerTurnId).toBe(initialInferenceId);

    const ids = {
      sessionId: project.rootSessionId,
      executionId,
      workId,
    };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const beforeTurn = beforeKill.providerTurns.find(
      (turn) => turn.provider_turn_id === initialInferenceId,
    );
    const beforeAttempt = beforeKill.providerAttempts.find(
      (attempt) => attempt.provider_turn_id === initialInferenceId,
    );
    expect(beforeKill.session).toEqual({
      session_id: project.rootSessionId,
      context_epoch: 0,
    });
    expect(beforeKill.checkpoints).toEqual([]);
    expect(beforeKill.step).toMatchObject({
      execution_id: executionId,
      logical_step_no: 0,
      repair_attempt: 0,
      provider_turn_id: initialInferenceId,
      state: "Prepared",
    });
    expect(beforeTurn).toMatchObject({
      provider_turn_id: initialInferenceId,
      execution_id: executionId,
      session_id: project.rootSessionId,
      context_epoch: 0,
      settled_at: null,
      finish_reason: null,
      manifest_id: expect.any(String),
      manifest_json: expect.any(String),
      portable_request_json: expect.any(String),
    });
    expect(beforeAttempt).toMatchObject({
      provider_turn_id: initialInferenceId,
      attempt_no: 0,
      outcome: "TerminalFailure",
      provider_error_kind: "ContextLimitExceeded",
      failure_taxonomy_version: "phase1-v2",
      retry_safety: expect.any(String),
      retry_decision: expect.any(String),
      retry_reason: expect.any(String),
      canonical_event_prefix_json: expect.any(String),
      delivered_position: 0,
      settled_at: expect.any(String),
    });
    expect(
      JSON.parse(beforeAttempt?.canonical_event_prefix_json ?? "null"),
    ).toEqual(expect.any(Array));
    expect(beforeKill.links).toEqual([]);
    expect(beforeKill.providerTurns).toHaveLength(1);
    expect(beforeKill.providerAttempts).toHaveLength(1);
    expect(provider.requests.map((request) => request.kind)).toEqual([
      "initial-inference",
    ]);

    await fixture.crash();
    const afterOldKill = readSnapshot(fixture.databaseFile, ids);
    expect(afterOldKill.session).toEqual(beforeKill.session);
    expect(afterOldKill.checkpoints).toEqual([]);
    expect(afterOldKill.step).toEqual(beforeKill.step);
    expect(afterOldKill.providerTurns).toEqual(beforeKill.providerTurns);
    expect(afterOldKill.providerAttempts).toEqual(beforeKill.providerAttempts);
    expect(afterOldKill.links).toEqual([]);
    expect(provider.requests.map((request) => request.kind)).toEqual([
      "initial-inference",
    ]);

    await expireLeaseAfterOldDaemonExit(fixture, project, executionId, workId);
    await fixture.restart().catch((error: unknown) => {
      throw new Error(
        `AH18 restart after failTurn rollback failed: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(provider.requests.map((request) => request.kind))}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    const recovered = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, ids),
      (snapshot) =>
        snapshot.session?.context_epoch === 1 &&
        snapshot.checkpoints.length === 1 &&
        snapshot.execution?.settlement_kind === "Completed" &&
        snapshot.workWait !== undefined,
      90_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH18 did not recover from terminal Attempt evidence: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(provider.requests.map((request) => request.kind))}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });

    const recoveredTurn = recovered.providerTurns.find(
      (turn) => turn.provider_turn_id === initialInferenceId,
    );
    expect(recovered.providerTurns).toHaveLength(3);
    expect(recovered.providerAttempts).toHaveLength(3);
    expect(recoveredTurn).toMatchObject({
      settled_at: expect.any(String),
      finish_reason: "Failed",
      manifest_id: beforeTurn?.manifest_id,
      manifest_json: beforeTurn?.manifest_json,
      portable_request_json: beforeTurn?.portable_request_json,
    });
    expect(
      recovered.providerAttempts.find(
        (attempt) => attempt.provider_turn_id === initialInferenceId,
      ),
    ).toEqual(beforeAttempt);
    expect(recovered.links).toEqual([
      expect.objectContaining({
        overflow_ordinal: 0,
        role: "Inference",
        provider_turn_id: initialInferenceId,
        context_epoch: 0,
        state: "SettledFailure",
      }),
      expect.objectContaining({
        overflow_ordinal: 0,
        role: "OverflowCompaction",
        provider_turn_id: compactionId,
        predecessor_provider_turn_id: initialInferenceId,
        context_epoch: 0,
      }),
      expect.objectContaining({
        overflow_ordinal: 0,
        role: "OverflowReplacement",
        provider_turn_id: replacementId,
        predecessor_provider_turn_id: compactionId,
        context_epoch: 1,
      }),
    ]);
    expect(recovered.steps).toEqual([
      expect.objectContaining({ logical_step_no: 0, repair_attempt: 0 }),
    ]);
    expect(provider.requests.map((request) => request.kind)).toEqual([
      "initial-inference",
      "summary",
      "replacement-inference",
    ]);
    expect(fixture.daemonErrors).toEqual([]);
  }, 150_000);
});
