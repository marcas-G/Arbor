import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import type { ProductionFixture } from "../../functional/support/production-fixture.js";
import {
  admitRootWorkThroughPublicConversation,
  createFunctionalProject,
  functionalId,
  submitHumanMessage,
  waitForExecutableApproval,
  waitForPublic,
} from "../../functional/support/public-client.js";
import {
  armProviderResponseGate,
  discoverProductionProviderConfig,
  finishRealProviderFixture,
  makeDeadlinePublicClient,
  type ProviderCapture,
  readProviderCaptures,
  repositoryBuildAssets,
  type StartedRealProviderFixture,
  startedProviderRequests,
  startRealProviderFixture,
  validateRealJourneyEvidenceRoot,
  waitForHeldProviderResponse,
  writeRealProviderEvidence,
} from "./public-real-journey-support.js";

const OPT_IN_ENV = "ARBOR_RUN_REAL_PUBLIC_S4";
const CAPTURE_FILE_ENV = "ARBOR_PUBLIC_S1_CAPTURE_FILE";
const RESPONSE_GATE_DIRECTORY_ENV = "ARBOR_PUBLIC_S1_RESPONSE_GATE_DIR";
const JOURNEY_BUDGET_MS = 20 * 60_000;

interface TranscriptEntry {
  readonly kind: string;
  readonly body?: string;
  readonly messageId?: string;
}

interface TranscriptPage {
  readonly entries: ReadonlyArray<TranscriptEntry>;
}

const explicitConfigPath =
  process.env.ARBOR_PUBLIC_S1_CONFIG?.trim() ||
  process.env.ARBOR_CONFIG?.trim();
const readiness = discoverProductionProviderConfig();
const evidenceRootReadiness = validateRealJourneyEvidenceRoot();
const missingAssetsAtLoad = repositoryBuildAssets();
const skipReason =
  process.env[OPT_IN_ENV] !== "1"
    ? `set ${OPT_IN_ENV}=1 to explicitly opt in`
    : readiness.ready
      ? explicitConfigPath === undefined
        ? "set ARBOR_PUBLIC_S1_CONFIG to the authorized Provider config path"
        : readiness.config.path.toLowerCase() !==
            resolve(explicitConfigPath).toLowerCase()
          ? "resolved Provider config path does not match the explicit test path"
          : !evidenceRootReadiness.ready
            ? evidenceRootReadiness.reason
            : missingAssetsAtLoad.length > 0
              ? `build ${missingAssetsAtLoad.join(", ")} before qualification`
              : undefined
      : readiness.reason;

const activeFixtures: Array<ProductionFixture> = [];
afterEach(async () => {
  for (const fixture of activeFixtures.splice(0)) await fixture.stop();
});

const transcript = (
  client: ReturnType<typeof makeDeadlinePublicClient>,
  workspaceId: string,
) =>
  client.view<TranscriptPage>("transcript", {
    workspaceId,
    conversationOnly: true,
    limit: 20,
  });

const waitWithinDeadline = async <A>(input: {
  readonly deadlineAt: number;
  readonly read: () => Promise<A>;
  readonly predicate: (value: A) => boolean;
  readonly label: string;
  readonly timeoutMs?: number;
}): Promise<A> => {
  const timeoutMs = Math.min(
    input.timeoutMs ?? 90_000,
    input.deadlineAt - Date.now(),
  );
  if (timeoutMs <= 0)
    throw new Error(`S4 deadline expired before ${input.label}`);
  try {
    return await waitForPublic(input.read, input.predicate, timeoutMs);
  } catch {
    throw new Error(
      `S4 public state did not reach ${input.label} before deadline`,
    );
  }
};

const entryKey = (entry: TranscriptEntry): string =>
  `${entry.kind}:${entry.messageId ?? entry.body ?? "missing-identity"}`;

const requestText = (capture: ProviderCapture): string =>
  JSON.stringify(capture.request ?? {});

const isStrictlyInside = (parent: string, child: string): boolean => {
  const rel = relative(resolve(parent), resolve(child));
  return (
    rel.length > 0 &&
    rel !== ".." &&
    !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(rel)
  );
};

const assertPrivateFixturePaths = (fixture: ProductionFixture): void => {
  expect(isStrictlyInside(fixture.directory, fixture.databaseFile)).toBe(true);
  expect(isStrictlyInside(fixture.directory, fixture.workspaceDirectory)).toBe(
    true,
  );
  expect(isStrictlyInside("C:\\Arbor", fixture.databaseFile)).toBe(false);
  expect(isStrictlyInside("C:\\Arbor", fixture.workspaceDirectory)).toBe(false);
};

const sanitizeErrorKind = (error: unknown): string =>
  error instanceof Error ? error.name.slice(0, 80) : "UnknownFailure";

const withRealFixture = async <A>(input: {
  readonly caseId: string;
  readonly responseGate?: boolean;
  readonly body: (
    run: StartedRealProviderFixture,
    deadlineAt: number,
  ) => Promise<A>;
}): Promise<A> => {
  if (!readiness.ready)
    throw new Error("REAL NOT QUALIFIED: provider config is unavailable");
  if (!evidenceRootReadiness.ready) {
    throw new Error("REAL NOT QUALIFIED: private evidence root is unavailable");
  }
  const run = await startRealProviderFixture({
    config: readiness.config,
    evidenceRoot: evidenceRootReadiness.path,
    journeyId: input.caseId,
    ...(input.responseGate === true ? { responseGate: true } : {}),
  });
  activeFixtures.push(run.fixture);
  const deadlineAt = Date.now() + JOURNEY_BUDGET_MS;
  let status: "PASS" | "FAIL" = "FAIL";
  let result: A | undefined;
  let caught: unknown;
  let scenario: Readonly<Record<string, unknown>> = {};
  let finalized:
    | Awaited<ReturnType<typeof finishRealProviderFixture>>
    | undefined;
  try {
    result = await input.body(run, deadlineAt);
    if (typeof result === "object" && result !== null) {
      scenario = result as Readonly<Record<string, unknown>>;
    }
    status = "PASS";
  } catch (error) {
    caught = error;
    scenario = { ...scenario, failureKind: sanitizeErrorKind(error) };
  } finally {
    finalized = await finishRealProviderFixture(run, status);
    writeRealProviderEvidence({
      run,
      journeyId: input.caseId,
      config: readiness.config,
      status: finalized.status,
      state: scenario,
      ...(finalized.error === undefined
        ? caught === undefined
          ? {}
          : { error: sanitizeErrorKind(caught) }
        : { error: finalized.error }),
    });
    activeFixtures.splice(activeFixtures.indexOf(run.fixture), 1);
  }
  if (caught !== undefined) throw caught;
  if (finalized?.status !== "PASS") {
    throw new Error(
      "REAL public S4 fixture cleanup did not complete successfully",
    );
  }
  return result as A;
};

const publicWorkDetail = async (
  client: ReturnType<typeof makeDeadlinePublicClient>,
  projectId: string,
  workspaceId: string,
  workId: string,
) =>
  client.view<{
    workId: string;
    workspaceId: string;
    lifecycle: string;
    revision: number;
  }>("work-detail", { projectId, workspaceId, workId });

interface ApprovalBinding {
  readonly approvalId: string;
  readonly executionId: string;
  readonly workId: string;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly actionIndex: number;
  readonly logicalActionId: string;
  readonly callRef: string;
  readonly toolInvocationId: string;
  readonly approvalState: string;
  readonly approvalRevision: number;
  readonly stepState: string;
  readonly actionState: string;
  readonly invocationCount: number;
}

const readPendingApprovalBinding = (
  databaseFile: string,
  approvalId: string,
): ApprovalBinding => {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT a.approval_id, a.execution_id, e.episode_ref AS work_id,
                a.logical_step_no, a.repair_attempt, a.action_index,
                a.logical_action_id, a.call_ref, a.tool_invocation_id,
                a.state AS approval_state, a.revision AS approval_revision,
                s.state AS step_state, x.state AS action_state,
                (SELECT COUNT(*) FROM tool_invocations i
                  WHERE i.invocation_id = a.tool_invocation_id) AS invocation_count
           FROM action_approvals a
           JOIN executions e ON e.execution_id = a.execution_id
           JOIN agent_loop_steps s ON s.execution_id = a.execution_id
             AND s.logical_step_no = a.logical_step_no
             AND s.repair_attempt = a.repair_attempt
           JOIN agent_loop_step_actions x ON x.execution_id = a.execution_id
             AND x.logical_step_no = a.logical_step_no
             AND x.repair_attempt = a.repair_attempt
             AND x.action_index = a.action_index
             AND x.logical_action_id = a.logical_action_id
          WHERE a.approval_id = ? AND e.episode_kind = 'WorkEpisode'
            AND a.route_kind = 'Executable'
            AND a.binding_proven = 1`,
      )
      .get(approvalId) as
      | {
          approval_id: string;
          execution_id: string;
          work_id: string;
          logical_step_no: number;
          repair_attempt: number;
          action_index: number;
          logical_action_id: string;
          call_ref: string;
          tool_invocation_id: string;
          approval_state: string;
          approval_revision: number;
          step_state: string;
          action_state: string;
          invocation_count: number;
        }
      | undefined;
    if (row === undefined)
      throw new Error("public approval has no exact durable binding");
    const binding: ApprovalBinding = {
      approvalId: row.approval_id,
      executionId: row.execution_id,
      workId: row.work_id,
      logicalStepNo: row.logical_step_no,
      repairAttempt: row.repair_attempt,
      actionIndex: row.action_index,
      logicalActionId: row.logical_action_id,
      callRef: row.call_ref,
      toolInvocationId: row.tool_invocation_id,
      approvalState: row.approval_state,
      approvalRevision: row.approval_revision,
      stepState: row.step_state,
      actionState: row.action_state,
      invocationCount: row.invocation_count,
    };
    if (
      binding.approvalState !== "Pending" ||
      binding.approvalRevision !== 0 ||
      binding.invocationCount !== 0
    ) {
      throw new Error(
        "Executable approval was not pending before effect admission",
      );
    }
    return binding;
  } finally {
    database.close();
  }
};

const publicStateOracle = "PublicCommandsAndViewsAndWorkspaceArtifact" as const;

it.skipIf(skipReason !== undefined)(
  skipReason === undefined
    ? "REAL S4-A: completed conversation turn stays stable while the pending next turn recovers after hard restart"
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
        const completedTurnCapture = startedProviderRequests(
          capturesAfterCompletedTurn,
        ).find((capture) => requestText(capture).includes(firstPrompt));
        if (completedTurnCapture === undefined) {
          throw new Error(
            "real Provider request for the completed turn was not captured",
          );
        }
        expect(
          capturesAfterCompletedTurn.some(
            (capture) =>
              capture.event === "response-complete" &&
              capture.requestId === completedTurnCapture.requestId &&
              capture.status !== undefined &&
              capture.status >= 200 &&
              capture.status < 300,
          ),
        ).toBe(true);
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
        expect(requestText(held)).toContain(secondPrompt);
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

        const recoveredTranscript = await waitWithinDeadline({
          deadlineAt,
          label: "recovered second assistant turn",
          read: () => transcript(client, project.rootWorkspaceId),
          predicate: (page) =>
            page.entries.filter(
              (entry) => entry.kind === "AssistantConversationTurn",
            ).length === 2 &&
            page.entries.some(
              (entry) =>
                entry.kind === "AssistantConversationTurn" &&
                entry.body?.includes(recallCode),
            ) &&
            page.entries.some(
              (entry) =>
                entry.kind === "HumanConversationTurn" &&
                entry.body === secondPrompt,
            ),
        });
        const finalIdentities = recoveredTranscript.entries.map(entryKey);
        expect(new Set(finalIdentities).size).toBe(finalIdentities.length);
        for (const pendingEntry of pendingTranscript.entries) {
          const recovered = recoveredTranscript.entries.filter(
            (entry) => entryKey(entry) === entryKey(pendingEntry),
          );
          expect(recovered).toEqual([pendingEntry]);
        }
        expect(
          recoveredTranscript.entries.filter(
            (entry) =>
              entry.kind === "AssistantConversationTurn" &&
              entry.body === firstAssistant.body,
          ),
        ).toHaveLength(1);
        const secondAssistant = recoveredTranscript.entries.find(
          (entry) =>
            entry.kind === "AssistantConversationTurn" &&
            entry.body !== firstAssistant.body,
        );
        expect(secondAssistant?.body).toContain(recallCode);

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
        expect(stableTranscript.entries).toEqual(recoveredTranscript.entries);

        const finalCaptures = readProviderCaptures(run.captureFile);
        const starts = startedProviderRequests(finalCaptures);
        const firstTurnStarts = starts.filter(
          (capture) =>
            requestText(capture).includes(firstPrompt) &&
            !requestText(capture).includes(secondPrompt),
        );
        expect(firstTurnStarts).toHaveLength(1);
        expect(
          starts.some(
            (capture) =>
              requestText(capture).includes(secondPrompt) &&
              capture.processId === newDaemonPid,
          ),
        ).toBe(true);
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
          completedTurnRequestId: completedTurnCapture.requestId,
          heldPendingRequestId: held.requestId,
          pendingTranscriptIdentities: pendingIdentities,
          recoveredTranscriptIdentities: finalIdentities,
          oldDaemonPid,
          newDaemonPid,
          recoveryQuietWindowMs,
          completedTurnProviderRequestCount: firstTurnStarts.length,
          recoveredPendingTurnRequestObserved: true,
          fixtureDatabase: run.fixture.databaseFile,
          captureFile: run.captureFile,
        };
      },
    });
  },
  JOURNEY_BUDGET_MS + 2 * 60_000,
);

it.skipIf(skipReason !== undefined)(
  skipReason === undefined
    ? "REAL S4-B: the same Work resumes after an Executable Approval survives hard restart"
    : `REAL NOT QUALIFIED: ${skipReason}`,
  async () => {
    await withRealFixture({
      caseId: "s4-b-work-approval-hard-restart",
      body: async (run, deadlineAt) => {
        assertPrivateFixturePaths(run.fixture);
        const client = makeDeadlinePublicClient(run.fixture, deadlineAt);
        const marker = `S4B-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
        const fileName = `s4-approval-${marker.toLowerCase()}.txt`;
        const fileContent = `S4-APPROVED-ARTIFACT:${marker}`;
        const resourceCatalog = await client.projectResources();
        const availableProfiles = resourceCatalog.profiles.filter(
          (profile) => profile.available,
        );
        expect(availableProfiles).toHaveLength(1);
        expect(availableProfiles[0]).toMatchObject({
          resourceProfileRef: "project-root",
          available: true,
        });
        const project = await createFunctionalProject(
          client,
          run.fixture.workspaceDirectory,
          `Real public S4 approval ${marker}`,
          { resourceSelection: "Profile" },
        );
        await client.command(project.projectId, "GrantPermission", {
          permissionGrantId: functionalId("pgr"),
          issuer: "user:local",
          subject: {
            _tag: "WorkspaceAgent",
            workspaceId: project.rootWorkspaceId,
          },
          capability: "fs:write",
          target: project.rootWorkspaceId,
          expiresAt: new Date(deadlineAt).toISOString(),
        });
        const admittedWork = await admitRootWorkThroughPublicConversation(
          client,
          project,
          marker,
          `Please complete ${marker}: create only ${fileName} in this workspace with the exact single-line content ${fileContent}, then read it back. Ask for any required execution approval before writing.`,
        );
        const workId = admittedWork.workId;
        const workBefore = await waitWithinDeadline({
          deadlineAt,
          label: "approved Work detail",
          read: () =>
            publicWorkDetail(
              client,
              project.projectId,
              project.rootWorkspaceId,
              workId,
            ),
          predicate: (value) =>
            value.workId === workId && value.lifecycle === "Open",
        });
        const approval = await waitForExecutableApproval(
          client,
          project.rootWorkspaceId,
          marker,
          Math.min(90_000, deadlineAt - Date.now()),
        );
        const bindingBefore = readPendingApprovalBinding(
          run.fixture.databaseFile,
          approval.approvalId,
        );
        expect(bindingBefore.workId).toBe(workId);
        expect(bindingBefore.approvalId).toBe(approval.approvalId);
        expect(bindingBefore.approvalRevision).toBe(approval.revision);
        expect(bindingBefore.executionId).toBeTruthy();
        expect(bindingBefore.toolInvocationId).toBeTruthy();
        expect(existsSync(join(run.fixture.workspaceDirectory, fileName))).toBe(
          false,
        );

        const oldDaemonPid = run.fixture.daemonProcessSnapshot()?.pid;
        await run.fixture.crash();
        expect(run.fixture.daemonsExited()).toBe(true);
        await run.fixture.restart({
          daemonEnvironment: { [CAPTURE_FILE_ENV]: run.captureFile },
        });
        const newDaemonPid = run.fixture.daemonProcessSnapshot()?.pid;
        expect(newDaemonPid).toBeDefined();
        expect(newDaemonPid).not.toBe(oldDaemonPid);

        const resumedWork = await waitWithinDeadline({
          deadlineAt,
          label: "same Work after restart",
          read: () =>
            publicWorkDetail(
              client,
              project.projectId,
              project.rootWorkspaceId,
              workId,
            ),
          predicate: (value) =>
            value.workId === workId && value.lifecycle === "Open",
        });
        expect(resumedWork.workspaceId).toBe(project.rootWorkspaceId);
        expect(resumedWork.revision).toBe(workBefore.revision);
        const resumedApproval = await waitForExecutableApproval(
          client,
          project.rootWorkspaceId,
          marker,
          Math.min(90_000, deadlineAt - Date.now()),
        );
        expect(resumedApproval).toEqual(approval);
        const bindingAfter = readPendingApprovalBinding(
          run.fixture.databaseFile,
          approval.approvalId,
        );
        expect(bindingAfter).toEqual(bindingBefore);
        expect(existsSync(join(run.fixture.workspaceDirectory, fileName))).toBe(
          false,
        );
        const startsWhileApprovalWaits = startedProviderRequests(
          readProviderCaptures(run.captureFile),
        ).length;
        const quietWindowMs = Math.min(1_500, deadlineAt - Date.now());
        if (quietWindowMs <= 0) {
          throw new Error(
            "S4 deadline expired before bounded approval idle window",
          );
        }
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, quietWindowMs),
        );
        const stillPending = await waitForExecutableApproval(
          client,
          project.rootWorkspaceId,
          marker,
          Math.min(15_000, deadlineAt - Date.now()),
        );
        expect(stillPending).toEqual(approval);
        expect(
          startedProviderRequests(readProviderCaptures(run.captureFile)),
        ).toHaveLength(startsWhileApprovalWaits);

        await client.command(project.projectId, "ResolveExecutableApproval", {
          approvalId: approval.approvalId,
          expectedRevision: approval.revision,
          decision: "Approve",
          reason: `approve the exact ${marker} workspace file action after restart`,
        });
        const artifactPath = join(run.fixture.workspaceDirectory, fileName);
        await waitWithinDeadline({
          deadlineAt,
          label: "approved real workspace artifact",
          read: async () => readFileSync(artifactPath, "utf8"),
          predicate: (content) => content === fileContent,
        });
        const continuedWork = await waitWithinDeadline({
          deadlineAt,
          label: "same Work remains publicly inspectable after approval",
          read: () =>
            publicWorkDetail(
              client,
              project.projectId,
              project.rootWorkspaceId,
              workId,
            ),
          predicate: (value) => value.workId === workId,
        });
        expect(continuedWork.workspaceId).toBe(project.rootWorkspaceId);
        const postApprovalRequests = startedProviderRequests(
          readProviderCaptures(run.captureFile),
        ).filter(
          (capture) =>
            capture.processId === newDaemonPid &&
            requestText(capture).includes(marker),
        );
        expect(postApprovalRequests.length).toBeGreaterThan(0);
        expect(run.fixture.providerCalls).toHaveLength(0);
        expect(run.fixture.daemonErrors).toEqual([]);

        return {
          oracleLayer: publicStateOracle,
          approvalBindingOracle: "ReadOnlySQLiteAuxiliary",
          projectId: project.projectId,
          workspaceId: project.rootWorkspaceId,
          resourceProfileRef: availableProfiles[0]?.resourceProfileRef,
          workId,
          workRevisionBeforeRestart: workBefore.revision,
          workRevisionAfterRestartBeforeApproval: resumedWork.revision,
          executableApprovalId: approval.approvalId,
          executionId: bindingBefore.executionId,
          toolInvocationId: bindingBefore.toolInvocationId,
          logicalStepNo: bindingBefore.logicalStepNo,
          repairAttempt: bindingBefore.repairAttempt,
          actionIndex: bindingBefore.actionIndex,
          logicalActionId: bindingBefore.logicalActionId,
          callRef: bindingBefore.callRef,
          sameApprovalAndActionBindingSurvivedRestart: true,
          approvalWaitQuietWindowMs: quietWindowMs,
          oldDaemonPid,
          newDaemonPid,
          artifactPath,
          artifactSha256: createHash("sha256")
            .update(fileContent)
            .digest("hex"),
          postApprovalProviderRequests: postApprovalRequests.length,
          fixtureDatabase: run.fixture.databaseFile,
          captureFile: run.captureFile,
        };
      },
    });
  },
  JOURNEY_BUDGET_MS + 2 * 60_000,
);
