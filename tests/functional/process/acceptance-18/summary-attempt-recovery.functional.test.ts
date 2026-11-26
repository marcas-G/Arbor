import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startProductionFixture } from "../../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
  waitForPublic,
} from "../../support/public-client.js";
import {
  type Ah18Probe,
  ah18AfterEach,
  ah18Child,
  expireLeaseAfterOldDaemonExit,
  fixtures,
  providerServers,
  readSnapshot,
  startAh18MeasuredWork,
  startOverflowProvider,
} from "./support.js";

afterEach(ah18AfterEach);

describe("linked overflow compaction recovery", () => {
  it.each(["in-progress", "retryable-failure"] as const)(
    "resumes the link-pinned Summary ProviderTurn after a hard crash with Attempt 0 %s",
    async (summaryAttemptState) => {
      const marker = `AH18-summary-attempt-${randomUUID().slice(0, 8)}`;
      const provider = await startOverflowProvider(
        marker,
        "manual-wait",
        summaryAttemptState === "in-progress" ? "hold" : "transport-failure",
      );
      providerServers.push(provider.server);
      const summaryFailureProbes: Ah18Probe[] = [];
      const fixture = await startProductionFixture({
        reply: () => ({ _tag: "HttpError", status: 500 }),
        daemonEnvironment: {
          ARBOR_MODEL_BASE_URL: provider.baseUrl,
        },
        onDaemonStdout: (line: string) => {
          try {
            const probe = JSON.parse(line) as Ah18Probe;
            if (
              probe.tag === "AH18_PROBE" &&
              probe.boundary === "AH18AfterSummaryRetryableFailureCommit"
            ) {
              summaryFailureProbes.push(probe);
            }
          } catch {
            // Preserve non-probe diagnostics from the real daemon.
          }
        },
      });
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `AH18 Summary Attempt recovery ${marker}`,
      );
      const measured = await startAh18MeasuredWork({
        client,
        fixture,
        project,
        provider,
        marker,
        ...(summaryAttemptState === "retryable-failure"
          ? {
              restartOptions: {
                entry: ah18Child,
                daemonEnvironment: {
                  ARBOR_AH18_BOUNDARY: "AH18AfterSummaryRetryableFailureCommit",
                  ARBOR_MODEL_BASE_URL: provider.baseUrl,
                },
              },
            }
          : {}),
      });
      const { workId, executionId } = measured;
      const inferenceId = `ptn_${executionId}_0`;
      const compactionId = `ptn_${executionId}_0_compact_0`;
      const replacementId = `ptn_${executionId}_0_overflow_0`;
      expect(compactionId).toBe(`ptn_${executionId}_0_compact_0`);

      if (summaryAttemptState === "in-progress") {
        await waitForPublic(
          async () =>
            provider.requests.filter((request) => request.kind === "summary")
              .length,
          (count) => count === 1,
          45_000,
        );
      } else {
        const retryProbe = await waitForPublic(
          async () => summaryFailureProbes[0],
          (probe) => probe !== undefined,
          30_000,
        );
        expect(retryProbe).toMatchObject({
          boundary: "AH18AfterSummaryRetryableFailureCommit",
          providerTurnId: compactionId,
          attemptNo: 0,
          failureKind: "TransportFailed",
        });
      }

      const ids = { sessionId: project.rootSessionId, executionId, workId };
      const beforeKill = readSnapshot(fixture.databaseFile, ids);
      const summaryTurnBefore = beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === compactionId,
      );
      const summaryManifestBefore = beforeKill.manifests.find(
        (manifest) => manifest.provider_turn_id === compactionId,
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
        provider_turn_id: inferenceId,
        state: "Prepared",
      });
      expect(beforeKill.links.map((link) => link.role)).toEqual([
        "Inference",
        "OverflowCompaction",
      ]);
      expect(summaryTurnBefore).toMatchObject({
        provider_turn_id: compactionId,
        execution_id: executionId,
        context_epoch: 0,
        settled_at: null,
        finish_reason: null,
      });
      expect(summaryManifestBefore).toMatchObject({
        provider_turn_id: compactionId,
        manifest_id: summaryTurnBefore?.manifest_id,
        manifest_json: summaryTurnBefore?.manifest_json,
        portable_request_json: summaryTurnBefore?.portable_request_json,
      });
      const summaryAttemptsBefore = beforeKill.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === compactionId,
      );
      expect(summaryAttemptsBefore).toHaveLength(1);
      if (summaryAttemptState === "in-progress") {
        expect(summaryAttemptsBefore[0]).toMatchObject({
          attempt_no: 0,
          outcome: "InProgress",
          settled_at: null,
        });
      } else {
        expect(summaryAttemptsBefore[0]).toMatchObject({
          attempt_no: 0,
          outcome: "RetryableFailure",
          provider_error_kind: "TransportFailed",
          retry_safety: "SafeReplay",
          retry_decision: "Retry",
          retry_strategy: "Replay",
          settled_at: expect.any(String),
        });
      }
      expect(
        beforeKill.providerAttempts.filter(
          (attempt) => attempt.provider_turn_id === inferenceId,
        ),
      ).toHaveLength(1);
      expect(
        beforeKill.providerAttempts.some(
          (attempt) => attempt.provider_turn_id === replacementId,
        ),
      ).toBe(false);
      expect(
        provider.requests.filter(
          (request) => request.kind === "initial-inference",
        ),
      ).toHaveLength(1);

      await fixture.crash();
      const afterOldKill = readSnapshot(fixture.databaseFile, ids);
      expect(afterOldKill.session).toEqual(beforeKill.session);
      expect(afterOldKill.checkpoints).toEqual([]);
      expect(afterOldKill.providerTurns).toEqual(beforeKill.providerTurns);
      expect(afterOldKill.manifests).toEqual(beforeKill.manifests);
      expect(afterOldKill.providerAttempts).toEqual(
        beforeKill.providerAttempts,
      );
      expect(afterOldKill.links).toEqual(beforeKill.links);
      expect(afterOldKill.step).toEqual(beforeKill.step);
      await expireLeaseAfterOldDaemonExit(
        fixture,
        project,
        executionId,
        workId,
      );
      await fixture.restart();

      const recovered = await waitForPublic(
        async () => readSnapshot(fixture.databaseFile, ids),
        (snapshot) =>
          snapshot.session?.context_epoch === 1 &&
          snapshot.checkpoints.length === 1 &&
          snapshot.execution?.settlement_kind === "Completed" &&
          snapshot.workWait !== undefined,
        90_000,
      );
      expect(recovered.checkpoints).toHaveLength(1);
      expect(recovered.checkpoints[0]).toMatchObject({
        context_epoch: 1,
        source_kind: "CompactionTurn",
        source_ref: compactionId,
      });
      expect(recovered.providerTurns).toHaveLength(3);
      expect(recovered.manifests).toHaveLength(3);
      expect(
        recovered.providerTurns.find(
          (turn) => turn.provider_turn_id === compactionId,
        ),
      ).toMatchObject({
        manifest_id: summaryTurnBefore?.manifest_id,
        manifest_json: summaryTurnBefore?.manifest_json,
        portable_request_json: summaryTurnBefore?.portable_request_json,
        context_epoch: 0,
        finish_reason: "Stop",
        settled_at: expect.any(String),
      });
      expect(
        recovered.manifests.find(
          (manifest) => manifest.provider_turn_id === compactionId,
        ),
      ).toEqual(summaryManifestBefore);
      const recoveredSummaryAttempts = recovered.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === compactionId,
      );
      expect(recoveredSummaryAttempts).toHaveLength(2);
      expect(recoveredSummaryAttempts[0]).toMatchObject({
        attempt_no: 0,
        outcome: "RetryableFailure",
        retry_decision: "Retry",
      });
      expect(recoveredSummaryAttempts[1]).toMatchObject({
        attempt_no: 1,
        outcome: "Success",
      });
      if (summaryAttemptState === "in-progress") {
        expect(recoveredSummaryAttempts[0]).toMatchObject({
          provider_error_kind: null,
          retry_strategy: "Replay",
          retry_reason: expect.stringContaining("ProcessLost retry"),
        });
      } else {
        expect(recoveredSummaryAttempts[0]).toMatchObject({
          provider_error_kind: "TransportFailed",
          retry_safety: "SafeReplay",
          retry_strategy: "Replay",
        });
      }
      expect(recovered.providerAttempts).toHaveLength(4);
      expect(recovered.providerAttempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider_turn_id: inferenceId,
            attempt_no: 0,
            outcome: "TerminalFailure",
            provider_error_kind: "ContextLimitExceeded",
          }),
          expect.objectContaining({
            provider_turn_id: replacementId,
            attempt_no: 0,
            outcome: "Success",
          }),
        ]),
      );
      expect(recovered.links).toEqual([
        expect.objectContaining({
          logical_step_no: 0,
          repair_attempt: 0,
          overflow_ordinal: 0,
          role: "Inference",
          provider_turn_id: inferenceId,
          state: "SettledFailure",
        }),
        expect.objectContaining({
          logical_step_no: 0,
          repair_attempt: 0,
          overflow_ordinal: 0,
          role: "OverflowCompaction",
          provider_turn_id: compactionId,
          predecessor_provider_turn_id: inferenceId,
          context_epoch: 0,
          state: "Prepared",
        }),
        expect.objectContaining({
          logical_step_no: 0,
          repair_attempt: 0,
          overflow_ordinal: 0,
          role: "OverflowReplacement",
          provider_turn_id: replacementId,
          predecessor_provider_turn_id: compactionId,
          context_epoch: 1,
          state: "Prepared",
        }),
      ]);
      expect(recovered.step).toMatchObject({
        logical_step_no: 0,
        repair_attempt: 0,
        provider_turn_id: inferenceId,
      });
      expect(provider.requests.map((request) => request.kind)).toEqual([
        "initial-inference",
        "summary",
        "summary",
        "replacement-inference",
      ]);
      expect(recovered.workWait).toBeDefined();
      expect(fixture.daemonErrors).toEqual([]);
    },
    150_000,
  );
});
