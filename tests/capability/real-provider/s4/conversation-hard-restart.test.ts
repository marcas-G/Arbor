// REAL S4-A conversation hard restart (B5 split): an unknown Provider
// outcome after a hard restart is surfaced as NeedsAttention without
// replay. The test body is moved verbatim from the former monolithic
// public-s4-recovery.test.ts.
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  createFunctionalProject,
  submitHumanMessage,
} from "../../../functional/support/public-client.js";
import {
  armProviderResponseGate,
  makeDeadlinePublicClient,
  providerRequestsMatching,
  readProviderCaptures,
  startedProviderRequests,
  waitForHeldProviderResponse,
} from "../public-real-journey-support.js";
import {
  readConversationLeaseBinding,
  readFailClosedConversationSnapshot,
} from "./support/conversation-recovery.js";
import {
  assertPrivateFixturePaths,
  CAPTURE_FILE_ENV,
  entryKey,
  JOURNEY_BUDGET_MS,
  publicStateOracle,
  RESPONSE_GATE_DIRECTORY_ENV,
  requestText,
  requireBoundProviderRequests,
  skipReason,
  transcript,
  waitWithinDeadline,
  withRealFixture,
} from "./support/journey.js";

it.skipIf(skipReason !== undefined)(
  skipReason === undefined
    ? "REAL S4-A: unknown Provider outcome after hard restart is surfaced as NeedsAttention without replay"
    : `REAL NOT QUALIFIED: ${skipReason}`,
  async () => {
    await withRealFixture({
      caseId: "s4-a-conversation-hard-restart",
      responseGate: true,
      body: async (run, deadlineAt) => {
        assertPrivateFixturePaths(run.fixture);
        const client = makeDeadlinePublicClient(run.fixture, deadlineAt);
        const marker = `S4A-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
        const recallCode = `RECALL-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
        const project = await createFunctionalProject(
          client,
          run.fixture.workspaceDirectory,
          `Real public S4 conversation ${marker}`,
          { resourceSelection: "ConversationOnly" },
        );
        const firstPrompt = `For this conversation, remember the exact code ${recallCode}. Reply with a short confirmation that includes it. Marker: ${marker}.`;
        await submitHumanMessage(client, project, firstPrompt);
        const firstTranscript = await waitWithinDeadline({
          deadlineAt,
          label: "first assistant turn",
          read: () => transcript(client, project.rootWorkspaceId),
          predicate: (page) =>
            page.entries.some(
              (entry) =>
                entry.kind === "AssistantConversationTurn" &&
                entry.body?.includes(recallCode),
            ),
        });
        const firstAssistant = firstTranscript.entries.find(
          (entry) =>
            entry.kind === "AssistantConversationTurn" &&
            entry.body?.includes(recallCode),
        );
        if (firstAssistant === undefined)
          throw new Error("first public answer is missing");

        const capturesAfterCompletedTurn = readProviderCaptures(
          run.captureFile,
        );
        const completedTurnEvidence = requireBoundProviderRequests(
          providerRequestsMatching(capturesAfterCompletedTurn, (request) =>
            requestText(request).includes(firstPrompt),
          ),
          "completed turn",
        );
        if (completedTurnEvidence.length === 0) {
          throw new Error(
            "real Provider request for the completed turn was not captured",
          );
        }
        const completedTurnSuccess = completedTurnEvidence.find((evidence) =>
          evidence.bodyEvents.some(
            (capture) =>
              capture.event === "response-complete" &&
              capture.status !== undefined &&
              capture.status >= 200 &&
              capture.status < 300,
          ),
        );
        if (completedTurnSuccess === undefined) {
          throw new Error(
            "completed public turn has no captured successful Provider response",
          );
        }
        const firstTurnRequestIdsBeforeRestart = completedTurnEvidence
          .map((evidence) => evidence.requestId)
          .sort();
        const secondPrompt = `What exact code did I ask you to remember? Return it unchanged. Marker: ${marker}.`;
        const startsBeforePendingTurn = startedProviderRequests(
          readProviderCaptures(run.captureFile),
        ).length;
        armProviderResponseGate(run, { requiredMessageText: secondPrompt });
        await submitHumanMessage(client, project, secondPrompt);
        const held = await waitForHeldProviderResponse(run, {
          afterSequence: startsBeforePendingTurn,
          deadlineAt,
        });
        expect(held.status).toBeGreaterThanOrEqual(200);
        expect(held.status).toBeLessThan(300);
        if (held.request === undefined) {
          throw new Error("held Provider response lacks its request body");
        }
        expect(requestText(held.request)).toContain(secondPrompt);
        const pendingTranscript = await waitWithinDeadline({
          deadlineAt,
          label: "second user turn pending without an assistant answer",
          read: () => transcript(client, project.rootWorkspaceId),
          predicate: (page) =>
            page.entries.filter(
              (entry) => entry.kind === "HumanConversationTurn",
            ).length === 2 &&
            page.entries.filter(
              (entry) => entry.kind === "AssistantConversationTurn",
            ).length === 1 &&
            page.entries.some(
              (entry) =>
                entry.kind === "HumanConversationTurn" &&
                entry.body === secondPrompt,
            ),
        });
        const pendingIdentities = pendingTranscript.entries.map(entryKey);
        expect(new Set(pendingIdentities).size).toBe(pendingIdentities.length);

        const oldDaemonPid = run.fixture.daemonProcessSnapshot()?.pid;
        const oldLease = readConversationLeaseBinding({
          databaseFile: run.fixture.databaseFile,
          messageId:
            pendingTranscript.entries.find(
              (entry) =>
                entry.kind === "HumanConversationTurn" &&
                entry.body === secondPrompt,
            )?.messageId ?? "",
        });
        await run.fixture.crash();
        expect(run.fixture.daemonsExited()).toBe(true);
        expect(run.fixture.daemonProcessSnapshot()?.alive).toBe(false);
        await run.fixture.restart({
          daemonEnvironment: {
            [CAPTURE_FILE_ENV]: run.captureFile,
            [RESPONSE_GATE_DIRECTORY_ENV]: "",
          },
        });
        const newDaemonPid = run.fixture.daemonProcessSnapshot()?.pid;
        expect(newDaemonPid).toBeDefined();
        expect(newDaemonPid).not.toBe(oldDaemonPid);

        const failClosedTranscript = await waitWithinDeadline({
          deadlineAt,
          label: "pending second turn surfaced as NeedsAttention",
          read: () => transcript(client, project.rootWorkspaceId),
          predicate: (page) =>
            page.entries.filter(
              (entry) => entry.kind === "HumanConversationTurn",
            ).length === 2 &&
            page.entries.filter(
              (entry) => entry.kind === "AssistantConversationTurn",
            ).length === 1 &&
            page.entries.some(
              (entry) =>
                entry.kind === "HumanConversationTurn" &&
                entry.body === secondPrompt &&
                entry.responseStatus?.state === "NeedsAttention" &&
                entry.responseStatus.reason === "UnknownFailure",
            ),
        });
        const finalIdentities = failClosedTranscript.entries.map(entryKey);
        expect(new Set(finalIdentities).size).toBe(finalIdentities.length);
        for (const pendingEntry of pendingTranscript.entries) {
          const recovered = failClosedTranscript.entries.filter(
            (entry) => entryKey(entry) === entryKey(pendingEntry),
          );
          expect(recovered).toHaveLength(1);
          expect(recovered[0]).toMatchObject({
            kind: pendingEntry.kind,
            body: pendingEntry.body,
            messageId: pendingEntry.messageId,
          });
        }
        expect(
          failClosedTranscript.entries.filter(
            (entry) =>
              entry.kind === "AssistantConversationTurn" &&
              entry.body === firstAssistant.body,
          ),
        ).toHaveLength(1);
        expect(
          failClosedTranscript.entries.filter(
            (entry) => entry.kind === "AssistantConversationTurn",
          ),
        ).toEqual([firstAssistant]);
        const pendingHuman = failClosedTranscript.entries.find(
          (entry) =>
            entry.kind === "HumanConversationTurn" &&
            entry.body === secondPrompt,
        );
        expect(pendingHuman?.responseStatus).toMatchObject({
          state: "NeedsAttention",
          reason: "UnknownFailure",
        });
        const failClosedSnapshot = readFailClosedConversationSnapshot({
          databaseFile: run.fixture.databaseFile,
          projectId: project.projectId,
          workspaceId: project.rootWorkspaceId,
          sessionId: project.rootSessionId,
          messageId: pendingHuman?.messageId ?? "",
        });
        expect(failClosedSnapshot.job).toMatchObject({
          state: "NeedsAttention",
          attentionReason: "UnknownFailure",
          lastFailureClass: "UnknownFailure",
          hasResponseBody: false,
        });
        expect(failClosedSnapshot.job.activeExecutionId).toBe(
          failClosedSnapshot.execution.executionId,
        );
        expect(failClosedSnapshot.humanMessage).toMatchObject({
          messageId: pendingHuman?.messageId,
          state: "Pending",
          claimedByExecutionId: null,
          settledAt: null,
        });
        expect(failClosedSnapshot.execution).toMatchObject({
          projectId: project.projectId,
          workspaceId: project.rootWorkspaceId,
          episodeKind: "ConversationResponseEpisode",
          episodeRef: pendingHuman?.messageId,
          sessionId: project.rootSessionId,
          settlementKind: "Failed",
        });
        expect(failClosedSnapshot.execution.settledAt).toBeTruthy();
        expect(failClosedSnapshot.step).toMatchObject({
          logicalStepNo: 0,
          repairAttempt: 0,
          state: "SettlementProposed",
          manifestId: null,
          decoderVersion: null,
          hasSuccessor: false,
        });
        expect(failClosedSnapshot.providerTurn).toMatchObject({
          executionId: failClosedSnapshot.execution.executionId,
          sessionId: project.rootSessionId,
          finishReason: "Failed",
        });
        expect(failClosedSnapshot.providerTurn.settledAt).toBeTruthy();
        expect(failClosedSnapshot.manifest).toMatchObject({
          manifestId: failClosedSnapshot.providerTurn.manifestId,
          providerTurnId: failClosedSnapshot.providerTurn.providerTurnId,
          executionId: failClosedSnapshot.execution.executionId,
          sessionId: project.rootSessionId,
          hasPortableRequest: true,
        });
        expect(failClosedSnapshot.providerAttempt).toMatchObject({
          attemptNo: 0,
          outcome: "TerminalFailure",
          retrySafety: "UnsafeReplay",
          retryDecision: "Stop",
          successEvidenceVersion: null,
          observation: {
            responseStarted: true,
            canonicalEventEmitted: false,
            consumerVisibleOutput: false,
            toolCallProposed: false,
            continuationAvailable: false,
            externalEffectPossible: true,
          },
        });
        expect(failClosedSnapshot.recoveryDecision).toMatchObject({
          causeTag: "ProcessLost",
          retrySafety: "UnsafeReplay",
          retryDecision: "Stop",
        });
        expect(failClosedSnapshot.lease).toMatchObject({
          generation: oldLease.generation + 1,
        });
        expect(failClosedSnapshot.execution.executionId).toBe(
          oldLease.executionId,
        );
        expect(failClosedSnapshot.lease?.workerIncarnationId).not.toBe(
          oldLease.workerIncarnationId,
        );
        expect(failClosedSnapshot.workspaceSchedulerTimerCount).toBe(0);
        expect(failClosedSnapshot.consumerOffsets.length).toBeGreaterThan(0);
        expect(failClosedSnapshot.maxProjectEventSequence).not.toBeNull();
        expect(
          failClosedSnapshot.consumerOffsets.every(
            (offset) =>
              offset.lastSequence ===
              failClosedSnapshot.maxProjectEventSequence,
          ),
        ).toBe(true);

        const recoveryQuietWindowMs = Math.min(1_500, deadlineAt - Date.now());
        if (recoveryQuietWindowMs <= 0) {
          throw new Error(
            "S4 deadline expired before bounded recovery stability window",
          );
        }
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, recoveryQuietWindowMs),
        );
        const stableTranscript = await transcript(
          client,
          project.rootWorkspaceId,
        );
        expect(stableTranscript.entries).toEqual(failClosedTranscript.entries);
        expect(
          readFailClosedConversationSnapshot({
            databaseFile: run.fixture.databaseFile,
            projectId: project.projectId,
            workspaceId: project.rootWorkspaceId,
            sessionId: project.rootSessionId,
            messageId: pendingHuman?.messageId ?? "",
          }),
        ).toEqual(failClosedSnapshot);

        const finalCaptures = readProviderCaptures(run.captureFile);
        const firstTurnEvidenceAfterRestart = requireBoundProviderRequests(
          providerRequestsMatching(
            finalCaptures,
            (request) =>
              requestText(request).includes(firstPrompt) &&
              !requestText(request).includes(secondPrompt),
          ),
          "completed turn after restart",
        );
        expect(
          firstTurnEvidenceAfterRestart
            .map((evidence) => evidence.requestId)
            .sort(),
        ).toEqual(firstTurnRequestIdsBeforeRestart);
        const recoveredPendingEvidence = requireBoundProviderRequests(
          providerRequestsMatching(finalCaptures, (request) =>
            requestText(request).includes(secondPrompt),
          ),
          "pending turn after restart",
        );
        expect(recoveredPendingEvidence).toHaveLength(1);
        expect(recoveredPendingEvidence[0]?.requestStart.processId).toBe(
          oldDaemonPid,
        );
        expect(recoveredPendingEvidence[0]?.requestId).toBe(held.requestId);
        expect(
          recoveredPendingEvidence[0]?.bodyEvents.map(
            (capture) => capture.event,
          ),
        ).toContain("response-held");
        expect(
          recoveredPendingEvidence[0]?.bodyEvents.map(
            (capture) => capture.event,
          ),
        ).not.toContain("response-released");
        expect(
          recoveredPendingEvidence[0]?.bodyEvents.some(
            (capture) => capture.event === "response-complete",
          ),
        ).toBe(true);
        expect(
          finalCaptures.some(
            (capture) =>
              capture.event === "request-start" &&
              capture.processId === newDaemonPid,
          ),
        ).toBe(false);
        expect(
          finalCaptures.some(
            (capture) =>
              capture.event === "response-released" &&
              capture.requestId === held.requestId,
          ),
        ).toBe(false);
        expect(run.fixture.providerCalls).toHaveLength(0);
        expect(run.fixture.daemonErrors).toEqual([]);

        return {
          oracleLayer: publicStateOracle,
          projectId: project.projectId,
          workspaceId: project.rootWorkspaceId,
          sessionId: project.rootSessionId,
          workspaceMode: "ConversationOnly",
          firstUserPromptMarker: marker,
          completedTurnRequestIds: firstTurnRequestIdsBeforeRestart,
          heldPendingRequestId: held.requestId,
          pendingTranscriptIdentities: pendingIdentities,
          recoveredTranscriptIdentities: finalIdentities,
          oldDaemonPid,
          newDaemonPid,
          recoveryQuietWindowMs,
          failClosedPendingRequestIds: recoveredPendingEvidence
            .map((evidence) => evidence.requestId)
            .sort(),
          completedTurnProviderRequestCount:
            firstTurnRequestIdsBeforeRestart.length,
          pendingTurnReplayObservedAfterRestart: false,
          failClosedState: failClosedSnapshot,
          fixtureDatabase: run.fixture.databaseFile,
          captureFile: run.captureFile,
        };
      },
    });
  },
  JOURNEY_BUDGET_MS + 2 * 60_000,
);
