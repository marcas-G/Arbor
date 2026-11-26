import { afterEach, describe, expect, it } from "vitest";
import { functionalId, waitForPublic } from "../../support/public-client.js";
import {
  ah18AfterEach,
  corruptSummaryBinding,
  expectFailClosedEvidence,
  expireLeaseAfterOldDaemonExit,
  insertOrphanCompactionManifest,
  readSnapshot,
  startAtBoundary,
  waitForFailedRestartExit,
} from "./support.js";

afterEach(ah18AfterEach);

describe("AH18 linked overflow compaction recovery", () => {
  it("fails closed when a NotFound Summary Turn has an orphan manifest", async () => {
    const boundary = "AH18AfterOverflowLinksCommit";
    const scenario = await startAtBoundary(boundary);
    const { fixture, provider, project, workId, boundaryProbe } = scenario;
    const executionId = boundaryProbe.executionId;
    const compactionId = boundaryProbe.providerTurnId;
    const initial = readSnapshot(fixture.databaseFile, {
      sessionId: project.rootSessionId,
      executionId,
      workId,
    });
    expect(initial.links.map((link) => link.role)).toEqual([
      "Inference",
      "OverflowCompaction",
    ]);
    expect(
      initial.providerTurns.some(
        (turn) => turn.provider_turn_id === compactionId,
      ),
    ).toBe(false);
    expect(
      initial.manifests.some(
        (manifest) => manifest.provider_turn_id === compactionId,
      ),
    ).toBe(false);

    await fixture.crash();
    await expireLeaseAfterOldDaemonExit(fixture, project, executionId, workId);
    insertOrphanCompactionManifest(fixture.databaseFile, {
      providerTurnId: compactionId,
      executionId,
      sessionId: project.rootSessionId,
      manifestId: functionalId("mft"),
    });
    const corrupted = readSnapshot(fixture.databaseFile, {
      sessionId: project.rootSessionId,
      executionId,
      workId,
    });
    expect(corrupted.links).toEqual(initial.links);
    expect(
      corrupted.manifests.filter(
        (manifest) => manifest.provider_turn_id === compactionId,
      ),
    ).toHaveLength(1);
    expect(
      corrupted.providerTurns.some(
        (turn) => turn.provider_turn_id === compactionId,
      ),
    ).toBe(false);

    let restartError: unknown;
    try {
      await fixture.restart();
    } catch (error) {
      restartError = error;
    }
    await waitForPublic(
      async () => ({
        errors: fixture.daemonErrors,
        providerRequests: provider.requests.length,
      }),
      (state) => state.errors.length > 0 || state.providerRequests > 1,
      15_000,
    );
    expectFailClosedEvidence(fixture, restartError);
    const failedRestart = await waitForFailedRestartExit(fixture);
    expect(failedRestart.alive).toBe(false);
    expect(
      failedRestart.exitCode !== null || failedRestart.signalCode !== null,
    ).toBe(true);

    const failedClosed = readSnapshot(fixture.databaseFile, {
      sessionId: project.rootSessionId,
      executionId,
      workId,
    });
    expect(provider.requests.map((request) => request.kind)).toEqual([
      "initial-inference",
    ]);
    expect(failedClosed.session?.context_epoch).toBe(0);
    expect(failedClosed.checkpoints).toEqual([]);
    expect(failedClosed.links).toEqual(initial.links);
    expect(failedClosed.step).toMatchObject({
      logical_step_no: 0,
      repair_attempt: 0,
      state: "Prepared",
    });
    expect(
      failedClosed.providerTurns.some(
        (turn) => turn.provider_turn_id === compactionId,
      ),
    ).toBe(false);
    expect(fixture.daemonErrors.join(" | ")).toMatch(
      /ProtocolViolation|manifest-orphaned|ProviderRuntime|AgentLoopStep/u,
    );
  }, 150_000);

  it.each(["manifest-context-epoch", "turn-context-epoch"] as const)(
    "fails closed when an Unsettled Summary binding is corrupted: %s",
    async (corruption) => {
      const scenario = await startAtBoundary("AH18AfterSummaryTurnCommit");
      const { fixture, provider, project, workId, boundaryProbe } = scenario;
      const executionId = boundaryProbe.executionId;
      const compactionId = boundaryProbe.providerTurnId;
      const initial = readSnapshot(fixture.databaseFile, {
        sessionId: project.rootSessionId,
        executionId,
        workId,
      });
      const summaryTurn = initial.providerTurns.find(
        (turn) => turn.provider_turn_id === compactionId,
      );
      if (summaryTurn === undefined) {
        throw new Error("AH18 Unsettled Summary Turn is missing at probe");
      }
      expect(summaryTurn).toMatchObject({
        context_epoch: 0,
        settled_at: null,
        manifest_json: expect.any(String),
      });
      expect(
        initial.providerAttempts.some(
          (attempt) => attempt.provider_turn_id === compactionId,
        ),
      ).toBe(false);

      await fixture.crash();
      await expireLeaseAfterOldDaemonExit(
        fixture,
        project,
        executionId,
        workId,
      );
      corruptSummaryBinding(fixture.databaseFile, {
        providerTurnId: compactionId,
        manifestId: summaryTurn.manifest_id,
        corruption,
      });
      const corrupted = readSnapshot(fixture.databaseFile, {
        sessionId: project.rootSessionId,
        executionId,
        workId,
      });
      expect(corrupted.links).toEqual(initial.links);
      const corruptedSummary = corrupted.providerTurns.find(
        (turn) => turn.provider_turn_id === compactionId,
      );
      expect(corruptedSummary).toBeDefined();
      if (corruption === "manifest-context-epoch") {
        expect(
          JSON.parse(corruptedSummary?.manifest_json ?? "{}").contextEpoch,
        ).toBe(1);
        expect(corruptedSummary?.context_epoch).toBe(0);
      } else {
        expect(corruptedSummary?.context_epoch).toBe(1);
        expect(
          JSON.parse(corruptedSummary?.manifest_json ?? "{}").contextEpoch,
        ).toBe(0);
      }

      let restartError: unknown;
      try {
        await fixture.restart();
      } catch (error) {
        restartError = error;
      }
      await waitForPublic(
        async () => ({
          errors: fixture.daemonErrors,
          providerRequests: provider.requests.length,
        }),
        (state) => state.errors.length > 0 || state.providerRequests > 1,
        15_000,
      );
      expectFailClosedEvidence(fixture, restartError);
      const failedRestart = await waitForFailedRestartExit(fixture);
      expect(failedRestart.alive).toBe(false);
      expect(
        failedRestart.exitCode !== null || failedRestart.signalCode !== null,
      ).toBe(true);

      const failedClosed = readSnapshot(fixture.databaseFile, {
        sessionId: project.rootSessionId,
        executionId,
        workId,
      });
      expect(provider.requests.map((request) => request.kind)).toEqual([
        "initial-inference",
      ]);
      expect(failedClosed.session?.context_epoch).toBe(0);
      expect(failedClosed.checkpoints).toEqual([]);
      expect(failedClosed.links).toEqual(initial.links);
      expect(failedClosed.step).toMatchObject({
        logical_step_no: 0,
        repair_attempt: 0,
        state: "Prepared",
      });
      expect(
        failedClosed.links.some((link) => link.role === "OverflowReplacement"),
      ).toBe(false);
      expect(failedClosed.execution?.settled_at).toBeNull();
    },
    150_000,
  );
});
