import { afterEach, describe, expect, it } from "vitest";
import { waitForPublic } from "../../support/public-client.js";
import {
  ah18AfterEach,
  boundaries,
  expireLeaseAfterOldDaemonExit,
  readSnapshot,
  startAtBoundary,
} from "./support.js";

afterEach(ah18AfterEach);

describe("linked overflow compaction recovery", () => {
  it.each(boundaries)(
    "resumes one ordinal-0 Summary Turn after process crash at %s",
    async (boundary) => {
      const { marker, provider, fixture, project, workId, boundaryProbe } =
        await startAtBoundary(boundary);
      const executionId = boundaryProbe.executionId;
      const initialInferenceId = `ptn_${executionId}_0`;
      const compactionId = `ptn_${executionId}_0_compact_0`;
      const replacementId = `ptn_${executionId}_0_overflow_0`;
      expect(boundaryProbe.providerTurnId).toBe(compactionId);

      const beforeKill = readSnapshot(fixture.databaseFile, {
        sessionId: project.rootSessionId,
        executionId,
        workId,
      });
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
      expect(beforeKill.providerTurns).toHaveLength(
        boundary === "AH18AfterSummaryTurnCommit" ? 2 : 1,
      );
      expect(
        beforeKill.providerTurns.find(
          (turn) => turn.provider_turn_id === initialInferenceId,
        ),
      ).toMatchObject({
        provider_turn_id: initialInferenceId,
        execution_id: executionId,
        session_id: project.rootSessionId,
        context_epoch: 0,
        settled_at: expect.any(String),
        finish_reason: "Failed",
      });
      expect(beforeKill.providerAttempts).toEqual([
        expect.objectContaining({
          provider_turn_id: initialInferenceId,
          attempt_no: 0,
          outcome: "TerminalFailure",
          provider_error_kind: "ContextLimitExceeded",
          failure_taxonomy_version: "phase1-v2",
          settled_at: expect.any(String),
        }),
      ]);
      expect(beforeKill.links.map((link) => link.role)).toEqual(
        boundary === "AH18BeforeOverflowLinksCommit"
          ? []
          : ["Inference", "OverflowCompaction"],
      );
      const beforeSummaryTurn = beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === compactionId,
      );
      const beforeSummaryManifest = beforeKill.manifests.find(
        (manifest) => manifest.provider_turn_id === compactionId,
      );
      if (boundary === "AH18AfterSummaryTurnCommit") {
        expect(beforeSummaryTurn).toMatchObject({
          provider_turn_id: compactionId,
          context_epoch: 0,
          settled_at: null,
          finish_reason: null,
          manifest_json: expect.any(String),
          portable_request_json: expect.any(String),
        });
        expect(beforeSummaryManifest).toMatchObject({
          provider_turn_id: compactionId,
          manifest_id: beforeSummaryTurn?.manifest_id,
          manifest_json: beforeSummaryTurn?.manifest_json,
          portable_request_json: beforeSummaryTurn?.portable_request_json,
        });
        expect(
          beforeKill.providerAttempts.some(
            (attempt) => attempt.provider_turn_id === compactionId,
          ),
        ).toBe(false);
        expect(
          beforeKill.manifests.filter(
            (manifest) => manifest.provider_turn_id === compactionId,
          ),
        ).toHaveLength(1);
      } else {
        expect(beforeSummaryTurn).toBeUndefined();
        expect(
          beforeKill.manifests.filter(
            (manifest) => manifest.provider_turn_id === compactionId,
          ),
        ).toHaveLength(0);
      }
      expect(provider.requests).toEqual([
        expect.objectContaining({ kind: "initial-inference" }),
      ]);

      await fixture.crash();
      const afterOldKill = readSnapshot(fixture.databaseFile, {
        sessionId: project.rootSessionId,
        executionId,
        workId,
      });
      expect(afterOldKill.session).toEqual(beforeKill.session);
      expect(afterOldKill.checkpoints).toEqual([]);
      expect(afterOldKill.providerTurns).toEqual(beforeKill.providerTurns);
      expect(afterOldKill.providerAttempts).toEqual(
        beforeKill.providerAttempts,
      );
      if (
        boundary === "AH18BeforeOverflowLinksCommit" ||
        boundary === "AH18AfterOverflowLinksCommit"
      ) {
        expect(afterOldKill.links).toEqual(beforeKill.links);
      }
      if (boundary === "AH18AfterSummaryTurnCommit") {
        expect(
          afterOldKill.manifests.find(
            (manifest) => manifest.provider_turn_id === compactionId,
          ),
        ).toEqual(beforeSummaryManifest);
      }
      if (
        boundary === "AH18BeforeSummaryTurnCommit" ||
        boundary === "AH18AfterSummaryTurnCommit"
      ) {
        expect(afterOldKill.links).toEqual(beforeKill.links);
      }

      const expiredLease = await expireLeaseAfterOldDaemonExit(
        fixture,
        project,
        executionId,
        workId,
      );
      expect(expiredLease.after).toMatchObject({
        execution_id: executionId,
        worker_id: expiredLease.before.worker_id,
        worker_incarnation_id: expiredLease.before.worker_incarnation_id,
        generation: expiredLease.before.generation,
        expires_at: "1970-01-01T00:00:00.000Z",
      });
      await fixture.restart().catch((error: unknown) => {
        throw new Error(
          `AH18 ordinary daemon restart failed: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, { sessionId: project.rootSessionId, executionId, workId }))}; providerRequests=${JSON.stringify(provider.requests.map((request) => request.kind))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });

      const recovered = await waitForPublic(
        async () =>
          readSnapshot(fixture.databaseFile, {
            sessionId: project.rootSessionId,
            executionId,
            workId,
          }),
        (snapshot) =>
          snapshot.session?.context_epoch === 1 &&
          snapshot.checkpoints.length === 1 &&
          snapshot.execution?.settlement_kind === "Completed" &&
          snapshot.workWait !== undefined,
        90_000,
      ).catch((error: unknown) => {
        throw new Error(
          `AH18 linked compaction did not resume: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, { sessionId: project.rootSessionId, executionId, workId }))}; requests=${JSON.stringify(provider.requests.map((request) => request.kind))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });

      expect(recovered.session).toEqual({
        session_id: project.rootSessionId,
        context_epoch: 1,
      });
      expect(recovered.checkpoints).toHaveLength(1);
      expect(recovered.checkpoints[0]).toMatchObject({
        context_epoch: 1,
        source_kind: "CompactionTurn",
        source_ref: compactionId,
      });
      expect(
        JSON.parse(recovered.checkpoints[0]?.payload_json ?? "{}"),
      ).toMatchObject({
        _tag: "CompactionCheckpoint",
        implementation: "Summary",
        fromEpoch: 0,
        toEpoch: 1,
        summaryText: `Compacted continuation for ${marker}.`,
      });
      expect(recovered.providerTurns).toHaveLength(3);
      expect(recovered.manifests).toHaveLength(3);
      const initialInference = recovered.providerTurns.find(
        (turn) => turn.provider_turn_id === initialInferenceId,
      );
      const summaryTurn = recovered.providerTurns.find(
        (turn) => turn.provider_turn_id === compactionId,
      );
      const replacementTurn = recovered.providerTurns.find(
        (turn) => turn.provider_turn_id === replacementId,
      );
      const recoveredSummaryManifest = recovered.manifests.find(
        (manifest) => manifest.provider_turn_id === compactionId,
      );
      expect(initialInference?.manifest_json).toBe(
        beforeKill.providerTurns[0]?.manifest_json,
      );
      if (boundary === "AH18AfterSummaryTurnCommit") {
        expect(summaryTurn).toMatchObject({
          manifest_id: beforeSummaryManifest?.manifest_id,
          manifest_json: beforeSummaryManifest?.manifest_json,
          portable_request_json: beforeSummaryManifest?.portable_request_json,
        });
        expect(recoveredSummaryManifest).toEqual(beforeSummaryManifest);
      }
      expect(summaryTurn).toMatchObject({
        provider_turn_id: compactionId,
        execution_id: executionId,
        context_epoch: 0,
        finish_reason: "Stop",
        settled_at: expect.any(String),
      });
      expect(replacementTurn).toMatchObject({
        provider_turn_id: replacementId,
        execution_id: executionId,
        context_epoch: 1,
        settled_at: expect.any(String),
      });
      expect(recovered.providerAttempts).toHaveLength(3);
      expect(recovered.providerAttempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider_turn_id: initialInferenceId,
            attempt_no: 0,
            outcome: "TerminalFailure",
            provider_error_kind: "ContextLimitExceeded",
          }),
          expect.objectContaining({
            provider_turn_id: compactionId,
            attempt_no: 0,
            outcome: "Success",
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
          state: "Prepared",
        }),
        expect.objectContaining({
          overflow_ordinal: 0,
          role: "OverflowReplacement",
          provider_turn_id: replacementId,
          predecessor_provider_turn_id: compactionId,
          context_epoch: 1,
          state: "Prepared",
        }),
      ]);
      expect(recovered.step).toMatchObject({
        execution_id: executionId,
        logical_step_no: 0,
        repair_attempt: 0,
        provider_turn_id: initialInferenceId,
      });
      expect(provider.requests.map((request) => request.kind)).toEqual([
        "initial-inference",
        "summary",
        "replacement-inference",
      ]);
      expect(recovered.workWait).toBeDefined();
      expect(fixture.daemonErrors).toEqual([]);
    },
    150_000,
  );
});
