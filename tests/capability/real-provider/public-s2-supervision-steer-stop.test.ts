import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  createFunctionalProject,
  functionalId,
  submitHumanMessage,
  waitForPublic,
} from "../../functional/support/public-client.js";
import {
  armProviderResponseGate,
  captureWorkspaceSnapshot,
  discoverProductionProviderConfig,
  finishRealProviderFixture,
  makeDeadlinePublicClient,
  type ProviderCapture,
  type RealProviderConfig,
  readProviderCaptures,
  releaseProviderResponse,
  repositoryBuildAssets,
  startedProviderRequests,
  startRealProviderFixture,
  updateProviderResponseGateSelector,
  validateRealJourneyEvidenceRoot,
  waitForHeldProviderResponse,
  writeRealProviderEvidence,
} from "./public-real-journey-support.js";

const OPT_IN = "ARBOR_RUN_REAL_PUBLIC_S2";
const EVIDENCE_ROOT = "ARBOR_PUBLIC_REAL_EVIDENCE_ROOT";
const JOURNEY_BUDGET_MS = 20 * 60_000;
const configReadiness = discoverProductionProviderConfig();
const buildMissing = repositoryBuildAssets();
const evidenceRootReadiness = validateRealJourneyEvidenceRoot(
  process.env[EVIDENCE_ROOT],
);
const skipReason =
  process.env[OPT_IN] !== "1"
    ? `set ${OPT_IN}=1 to explicitly opt in`
    : !configReadiness.ready
      ? configReadiness.reason
      : !evidenceRootReadiness.ready
        ? evidenceRootReadiness.reason
        : buildMissing.length > 0
          ? `REAL NOT QUALIFIED: build ${buildMissing.join(" and ")}`
          : undefined;

const redact = (text: string): string =>
  text
    .replace(/bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/gu, "[REDACTED]")
    .replace(
      /((?:api[_-]?key|secret|credential|token)["']?\s*[:=]\s*["']?)[^"'\s,;]+/giu,
      "$1[REDACTED]",
    )
    .slice(0, 8_000);

const waitForExactWorkApproval = async (
  client: ReturnType<typeof makeDeadlinePublicClient>,
  project: { readonly rootWorkspaceId: string; readonly projectId: string },
  marker: string,
  deadlineAt: number,
) => {
  let last: unknown;
  while (Date.now() < deadlineAt) {
    const [inbox, transcript] = await Promise.all([
      client.view<{
        unconsumed: Array<{ entryKey: string; kind: string; summary: string }>;
      }>("inbox-view", { workspaceId: project.rootWorkspaceId }),
      client.view<{
        entries: Array<{
          kind: string;
          body?: string;
          messageId?: string;
          responseStatus?: { state: string; revision: number };
        }>;
      }>("transcript", {
        workspaceId: project.rootWorkspaceId,
        limit: 20,
        conversationOnly: true,
      }),
    ]);
    const entry = inbox.unconsumed.find(
      (candidate) =>
        candidate.kind === "Governance" &&
        candidate.summary.includes(marker) &&
        /^cap:cap_[^:]+:\d+$/u.test(candidate.entryKey),
    );
    const exact =
      entry === undefined
        ? null
        : /^cap:(cap_[^:]+):(\d+)$/u.exec(entry.entryKey);
    if (exact !== null)
      return { approvalId: exact[1] as string, revision: Number(exact[2]) };
    const human = [...transcript.entries]
      .reverse()
      .find(
        (entry) =>
          entry.kind === "HumanConversationTurn" &&
          entry.body?.includes(marker),
      );
    const response = transcript.entries.find(
      (entry) =>
        entry.kind === "AssistantConversationTurn" &&
        entry.messageId === human?.messageId,
    );
    last = {
      status: human?.responseStatus ?? null,
      response: response?.body ?? null,
      inbox: inbox.unconsumed,
    };
    if (
      ["Answered", "NeedsAttention", "Cancelled"].includes(
        human?.responseStatus?.state ?? "",
      )
    ) {
      throw new Error(
        `REAL public S2 terminal Root turn without exact Work approval; public=${JSON.stringify(last)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `REAL NOT QUALIFIED: exact Work approval not observed; public=${JSON.stringify(last)}`,
  );
};

const waitForWork = async (
  client: ReturnType<typeof makeDeadlinePublicClient>,
  workspaceId: string,
  marker: string,
  deadlineAt: number,
) =>
  waitForPublic(
    () =>
      client.view<{
        workId?: string;
        objective?: string;
        status: string;
        revision: number;
        activeExecution?: { executionId: string; admittedAt: string };
      } | null>("current-work", { workspaceId }),
    (work) =>
      work?.workId !== undefined && work.objective?.includes(marker) === true,
    Math.max(1, deadlineAt - Date.now()),
  );

const readInvocationFacts = (
  databaseFile: string,
  executionId: string,
): Array<{
  invocation_id: string;
  tool_name: string;
  settlement_kind: string | null;
}> => {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return database
      .prepare(
        "SELECT invocation_id, tool_name, settlement_kind FROM tool_invocations WHERE execution_id = ? ORDER BY invocation_id",
      )
      .all(executionId) as Array<{
      invocation_id: string;
      tool_name: string;
      settlement_kind: string | null;
    }>;
  } finally {
    database.close();
  }
};

interface ExecutionStopSnapshot {
  readonly executionId: string;
  readonly stop_requested_at: string | null;
  readonly settlement_kind: string | null;
  readonly settlement_json: string | null;
  readonly settled_at: string | null;
  readonly providerTurnCount: number;
}

const readExecutionStopSnapshot = (
  databaseFile: string,
  executionId: string,
): ExecutionStopSnapshot => {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const execution = database
      .prepare(
        "SELECT execution_id, stop_requested_at, settlement_kind, settlement_json, settled_at FROM executions WHERE execution_id = ?",
      )
      .get(executionId) as
      | Omit<ExecutionStopSnapshot, "providerTurnCount">
      | undefined;
    if (execution === undefined) {
      throw new Error("read-only stop oracle found no exact Execution");
    }
    const providerTurns = database
      .prepare(
        "SELECT COUNT(*) AS count FROM provider_turns WHERE execution_id = ?",
      )
      .get(executionId) as { count: number };
    return { ...execution, providerTurnCount: providerTurns.count };
  } finally {
    database.close();
  }
};

const heldResponseContainsActionCall = (capture: ProviderCapture): boolean => {
  if (capture.responseBodyBase64 === undefined) return false;
  const response = Buffer.from(capture.responseBodyBase64, "base64").toString(
    "utf8",
  );
  return /"(?:tool_calls|function_call)"\s*:/u.test(response);
};

const capturedSystemPrompt = (capture: ProviderCapture): string => {
  const messages = capture.request?.messages;
  if (!Array.isArray(messages)) return "";
  return messages
    .filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" && message !== null,
    )
    .filter(
      (message) => message.role === "system" || message.role === "developer",
    )
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? ""),
    )
    .join("\n");
};

const approveExactPatchIfPending = async (input: {
  readonly client: ReturnType<typeof makeDeadlinePublicClient>;
  readonly project: {
    readonly projectId: string;
    readonly rootWorkspaceId: string;
  };
  readonly workId: string;
  readonly marker: string;
  readonly deadlineAt: number;
}): Promise<void> => {
  const inbox = await input.client.view<{
    unconsumed: Array<{
      entryKey: string;
      kind: string;
      target?: {
        kind: string;
        approvalId: string;
        revision: number;
        executionId: string;
        toolName: string;
        targetResourceSpaceIds: ReadonlyArray<string>;
        capabilities: ReadonlyArray<string>;
      };
    }>;
  }>("inbox-view", { workspaceId: input.project.rootWorkspaceId });
  const approvals = inbox.unconsumed.filter(
    (entry) =>
      entry.kind === "Governance" && /^eap:.+:\d+$/u.test(entry.entryKey),
  );
  if (approvals.length > 1) {
    throw new Error(
      `REAL NOT QUALIFIED: multiple executable approvals for ${input.marker}`,
    );
  }
  const entry = approvals[0];
  if (entry === undefined) return;
  const match = /^eap:(.+):(\d+)$/u.exec(entry.entryKey);
  const target = entry.target;
  const active = await input.client.view<{
    workId?: string;
    activeExecution?: { executionId: string };
  } | null>("current-work", { workspaceId: input.project.rootWorkspaceId });
  if (
    match === null ||
    target?.kind !== "ExecutableApproval" ||
    target.approvalId !== match[1] ||
    target.revision !== Number(match[2]) ||
    target.executionId !== active?.activeExecution?.executionId ||
    target.toolName !== "patch" ||
    target.capabilities.length !== 1 ||
    target.capabilities[0] !== "fs:write" ||
    target.targetResourceSpaceIds.length !== 1 ||
    target.targetResourceSpaceIds[0] !== "filesystem" ||
    active?.workId !== input.workId ||
    Date.now() >= input.deadlineAt
  ) {
    throw new Error(
      `REAL NOT QUALIFIED: executable approval was not exact fs:write patch scope for ${input.marker}`,
    );
  }
  await input.client.command(
    input.project.projectId,
    "ResolveExecutableApproval",
    {
      approvalId: target.approvalId,
      expectedRevision: target.revision,
      decision: "Approve",
      reason: `approve exact bounded fs:write patch ${input.marker}`,
    },
  );
};

const runJourney = async (input: {
  readonly config: RealProviderConfig;
  readonly evidenceRoot: string;
  readonly marker: string;
  readonly mode: "normal-steer" | "immediate-stop";
}): Promise<void> => {
  const deadlineAt = Date.now() + JOURNEY_BUDGET_MS;
  const run = await startRealProviderFixture({
    config: input.config,
    evidenceRoot: input.evidenceRoot,
    journeyId: input.marker.toLowerCase(),
    responseGate: true,
  });
  const { fixture, captureFile } = run;
  const releasedHeldRequestIds = new Set<string>();
  const releaseTrackedProviderResponse = (requestId: string): void => {
    releaseProviderResponse(run, requestId);
    releasedHeldRequestIds.add(requestId);
    pendingHeldRequestIds.delete(requestId);
  };
  const pendingHeldRequestIds = new Set<string>();
  const waitForTrackedHeldProviderResponse = async (
    input: Parameters<typeof waitForHeldProviderResponse>[1],
  ): Promise<ProviderCapture> => {
    const capture = await waitForHeldProviderResponse(run, input);
    pendingHeldRequestIds.add(capture.requestId);
    return capture;
  };
  let pass = false;
  let failure: string | undefined;
  const state: Record<string, unknown> = {
    mode: input.mode,
    fixtureDirectory: fixture.directory,
    databaseFile: fixture.databaseFile,
    workspaceDirectory: fixture.workspaceDirectory,
    failureRetention:
      "fixture and private evidence are retained on any failure",
  };
  try {
    const client = makeDeadlinePublicClient(fixture, deadlineAt);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      `Real public S2 ${input.marker}`,
      { resourceSelection: "Profile" },
    );
    state.project = project;
    const workspaceBaseline = captureWorkspaceSnapshot(
      fixture.workspaceDirectory,
    );
    state.workspaceBaseline = workspaceBaseline;
    await client.command(project.projectId, "GrantPermission", {
      permissionGrantId: functionalId("pgr"),
      issuer: "user:local",
      subject: { _tag: "WorkspaceAgent", workspaceId: project.rootWorkspaceId },
      capability: "fs:write",
      target: project.rootWorkspaceId,
      expiresAt: new Date(deadlineAt).toISOString(),
    });
    const fileName = `${input.mode}-${input.marker.toLowerCase()}.txt`;
    const initialContent = `S2 initial ${input.marker}`;
    await submitHumanMessage(
      client,
      project,
      `请在当前项目工作区创建文件 ${fileName}，唯一一行内容严格为 ${initialContent}，并读回核对。如果需要审批请先提出。不要使用 shell、网络或其他工作区。任务标记 ${input.marker}`,
    );
    const approval = await waitForExactWorkApproval(
      client,
      project,
      input.marker,
      deadlineAt,
    );
    const workGateSelector = {
      requiredAdvertisedToolName: "patch",
      requiredMessageText: input.marker,
    } as const;
    armProviderResponseGate(run, workGateSelector);
    await client.command(project.projectId, "ResolveControlApproval", {
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: "Approve",
      reason: `approve bounded S2 Work ${input.marker}`,
    });
    const work = await waitForWork(
      client,
      project.rootWorkspaceId,
      input.marker,
      deadlineAt,
    );
    if (work === null || work.workId === undefined)
      throw new Error("public current-work omitted Work identity");
    const rootStarts = Math.max(
      0,
      ...startedProviderRequests(readProviderCaptures(captureFile)).map(
        (capture) => capture.sequence,
      ),
    );
    const firstHeldResponse = await waitForTrackedHeldProviderResponse({
      afterSequence: rootStarts - 1,
      deadlineAt,
      selector: workGateSelector,
    });
    expect(capturedSystemPrompt(firstHeldResponse)).toContain(
      "In a WorkspaceWork turn bound to a current Work, you are the executing agent responsible for advancing that Work",
    );
    expect(capturedSystemPrompt(firstHeldResponse)).not.toContain(
      "RootConversation intentionally has no executable Work tools",
    );
    state.workId = work.workId;
    state.workRevisionAtAdmission = work.revision;

    const beforeReadStarts = startedProviderRequests(
      readProviderCaptures(captureFile),
    ).length;
    const beforeReadRevision = work.revision;
    const readOnlyViews = await Promise.all([
      client.view("responsibility-tree", { projectId: project.projectId }),
      client.view("workspace-detail", { workspaceId: project.rootWorkspaceId }),
      client.view("current-work", { workspaceId: project.rootWorkspaceId }),
      client.view("work-detail", {
        projectId: project.projectId,
        workspaceId: project.rootWorkspaceId,
        workId: work.workId,
      }),
      client.view("transcript", {
        workspaceId: project.rootWorkspaceId,
        limit: 20,
        conversationOnly: true,
      }),
    ]);
    const workAfterRead = await client.view<typeof work>("current-work", {
      workspaceId: project.rootWorkspaceId,
    });
    expect(workAfterRead?.revision).toBe(work.revision);
    expect(JSON.stringify(readOnlyViews)).toContain(work.workId);
    expect(readOnlyViews[3]).toMatchObject({
      workId: work.workId,
      workspaceId: project.rootWorkspaceId,
      revision: work.revision,
    });
    expect(
      startedProviderRequests(readProviderCaptures(captureFile)),
    ).toHaveLength(beforeReadStarts);
    state.readOnlyViewNames = [
      "responsibility-tree",
      "workspace-detail",
      "current-work",
      "work-detail",
      "transcript",
    ];
    state.readOnlyViewsReturned = readOnlyViews.map(
      (view) => view !== undefined && view !== null,
    );
    state.providerStartsBeforeAndAfterRead = beforeReadStarts;
    state.revisionBeforeAndAfterRead = work.revision;

    const proofPath = join(fixture.workspaceDirectory, fileName);
    if (input.mode === "normal-steer") {
      const correctionMarker = `S2-CORRECTION-${input.marker}`;
      const correctedContent = `S2 corrected ${input.marker}`;
      await client.command(project.projectId, "SteerWork", {
        workId: work.workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: work.revision,
        steer: {
          severity: "Normal",
          operation: {
            kind: "ContractAmendment",
            amendment: {
              objective: `在当前项目工作区创建文件 ${fileName}，唯一一行内容严格为 ${correctedContent}，并读回核对。${correctionMarker}`,
              why: `用户以 Normal Steer 将目标内容纠正为 ${correctedContent}；保留当前任务脉络并按新合同完成。${correctionMarker}`,
              constraints: [
                "只使用 patch 创建或修正目标文件，并用 read 读回核对。",
                "不得使用 shell 或网络。",
                "不得访问或创建其他 Workspace，也不得分派子 Work。",
              ],
              completionExpectation: `当前项目工作区根目录存在 ${fileName}，其内容逐字符严格等于 ${correctedContent}。`,
              verificationMission: {
                goal: `独立核验 ${fileName} 存在且内容与纠正后的要求逐字符一致。`,
                criteria: [
                  {
                    criterionId: "file-exists",
                    requirement: `当前项目工作区根目录存在 ${fileName}。`,
                    required: true,
                  },
                  {
                    criterionId: "exact-content",
                    requirement: `read 读回内容逐字符严格等于 ${correctedContent}。`,
                    required: true,
                  },
                ],
                riskRequirements: [
                  "不得使用 shell。",
                  "不得使用网络。",
                  "不得访问或创建其他 Workspace，也不得分派子 Work。",
                ],
              },
            },
          },
        },
        provenance: { source: "HumanInput" },
      });
      const steeredCurrentWork = await client.view<{
        workId?: string;
        revision: number;
      } | null>("current-work", { workspaceId: project.rootWorkspaceId });
      expect(steeredCurrentWork?.workId).toBe(work.workId);
      expect(steeredCurrentWork?.revision).toBe(work.revision + 1);
      state.normalSteerMarker = correctionMarker;
      state.normalSteerReceipt = "Committed";
      const correctionRequestSelector = {
        ...workGateSelector,
        requiredMessageText: correctionMarker,
      } as const;
      updateProviderResponseGateSelector(run, correctionRequestSelector);
      let lastSequence = firstHeldResponse.sequence;
      releaseTrackedProviderResponse(firstHeldResponse.requestId);
      let correctionRequest: ProviderCapture | undefined;
      while (Date.now() < deadlineAt && correctionRequest === undefined) {
        await approveExactPatchIfPending({
          client,
          project,
          workId: work.workId,
          marker: input.marker,
          deadlineAt,
        });
        try {
          correctionRequest = await waitForTrackedHeldProviderResponse({
            afterSequence: lastSequence,
            deadlineAt: Math.min(deadlineAt, Date.now() + 1_000),
            selector: correctionRequestSelector,
          });
        } catch {
          // Hook attaches request messages to response-held/complete records,
          // not request-start records. Keep exact-scope approvals progressing
          // while waiting for the actual corrected Work request to return.
        }
      }
      if (correctionRequest === undefined)
        throw new Error(
          "REAL NOT QUALIFIED: correction absent from the subsequent real Provider request",
        );
      lastSequence = correctionRequest.sequence;
      state.correctionProviderRequestId = correctionRequest.requestId;
      state.correctionInRealProviderRequest = true;
      releaseTrackedProviderResponse(correctionRequest.requestId);
      let correctedContentObserved = false;
      let verification:
        | {
            verdict: string;
            verificationId?: string;
            targetWorkRevision?: number;
          }
        | undefined;
      while (
        Date.now() < deadlineAt &&
        (!correctedContentObserved || verification?.verdict !== "Pass")
      ) {
        await approveExactPatchIfPending({
          client,
          project,
          workId: work.workId,
          marker: input.marker,
          deadlineAt,
        });
        try {
          const held = await waitForTrackedHeldProviderResponse({
            afterSequence: lastSequence,
            deadlineAt: Math.min(deadlineAt, Date.now() + 1_000),
            selector: workGateSelector,
          });
          lastSequence = held.sequence;
          releaseTrackedProviderResponse(held.requestId);
        } catch {
          // Check public lifecycle state between genuine upstream responses.
        }
        correctedContentObserved =
          existsSync(proofPath) &&
          readFileSync(proofPath, "utf8") === correctedContent;
        try {
          const latest = await client.view<{
            verdict: string;
            verificationId?: string;
            targetWorkRevision?: number;
          }>("verification", { workId: work.workId });
          if (latest.verdict === "Pass" && latest.verificationId !== undefined)
            verification = latest;
        } catch {
          // No verification projection until the producer claims completion.
        }
      }
      if (
        !correctedContentObserved ||
        verification?.verdict !== "Pass" ||
        verification.verificationId === undefined
      ) {
        throw new Error(
          "REAL NOT QUALIFIED: corrected effect and independent Verification PASS did not converge",
        );
      }
      const workspaceAfterSteer = captureWorkspaceSnapshot(
        fixture.workspaceDirectory,
      );
      for (const [path, entry] of Object.entries(workspaceBaseline.entries)) {
        expect(workspaceAfterSteer.entries[path]).toEqual(entry);
      }
      const newWorkspaceEntries = Object.keys(workspaceAfterSteer.entries)
        .filter((path) => !Object.hasOwn(workspaceBaseline.entries, path))
        .sort();
      expect(newWorkspaceEntries).toEqual([fileName]);
      expect(workspaceAfterSteer.entries[fileName]).toMatchObject({
        kind: "file",
        size: Buffer.byteLength(correctedContent, "utf8"),
      });
      state.workspaceAfterNormalSteer = workspaceAfterSteer;
      const beforeAcceptance = await client.view<{
        lifecycle: string;
        revision: number;
      }>("work-detail", {
        projectId: project.projectId,
        workspaceId: project.rootWorkspaceId,
        workId: work.workId,
      });
      expect(beforeAcceptance.lifecycle).toBe("Open");
      expect(verification.targetWorkRevision).toBe(beforeAcceptance.revision);
      expect(beforeReadRevision).toBe(work.revision);
      expect(beforeAcceptance.revision).toBeGreaterThan(work.revision);
      await client.command(project.projectId, "AcceptWorkOutcome", {
        acceptanceId: functionalId("acc"),
        workId: work.workId,
        targetWorkRevision: verification.targetWorkRevision,
        verificationId: verification.verificationId,
      });
      const completed = await waitForPublic(
        () =>
          client.view<{
            lifecycle: string;
            revision: number;
            acceptedResult?: unknown;
          }>("work-detail", {
            projectId: project.projectId,
            workspaceId: project.rootWorkspaceId,
            workId: work.workId,
          }),
        (detail) =>
          detail.lifecycle === "Completed" &&
          detail.acceptedResult !== undefined,
        Math.max(1, deadlineAt - Date.now()),
      );
      state.finalWork = completed;
      state.verification = verification;
      expect(verification.verdict).toBe("Pass");
      const globalAfterAcceptance = await client.view<{
        nodes: Array<{
          workspaceId: string;
          currentWork: { workId?: string } | null;
        }>;
      }>("responsibility-tree", { projectId: project.projectId });
      expect(
        globalAfterAcceptance.nodes.find(
          (node) => node.workspaceId === project.rootWorkspaceId,
        )?.currentWork ?? null,
      ).toBeNull();
      state.globalAfterAcceptance = globalAfterAcceptance;
    } else {
      let lastSequence = firstHeldResponse.sequence;
      releaseTrackedProviderResponse(firstHeldResponse.requestId);
      while (
        Date.now() < deadlineAt &&
        !(
          existsSync(proofPath) &&
          readFileSync(proofPath, "utf8") === initialContent
        )
      ) {
        await approveExactPatchIfPending({
          client,
          project,
          workId: work.workId,
          marker: input.marker,
          deadlineAt,
        });
        try {
          const nextHeld = await waitForTrackedHeldProviderResponse({
            afterSequence: lastSequence,
            deadlineAt: Math.min(deadlineAt, Date.now() + 1_000),
            selector: workGateSelector,
          });
          lastSequence = nextHeld.sequence;
          releaseTrackedProviderResponse(nextHeld.requestId);
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (
        !(
          existsSync(proofPath) &&
          readFileSync(proofPath, "utf8") === initialContent
        )
      )
        throw new Error(
          "REAL NOT QUALIFIED: bounded Work effect missing before deadline",
        );
      let heldAfterEffect: ProviderCapture | undefined;
      while (Date.now() < deadlineAt && heldAfterEffect === undefined) {
        try {
          heldAfterEffect = await waitForTrackedHeldProviderResponse({
            afterSequence: lastSequence,
            deadlineAt: Math.min(deadlineAt, Date.now() + 3_000),
            selector: workGateSelector,
          });
        } catch {
          const current = await client.view<{
            workId?: string;
            status: string;
            activeExecution?: { executionId: string };
          } | null>("current-work", { workspaceId: project.rootWorkspaceId });
          if (
            current?.workId !== work.workId ||
            current.activeExecution === undefined
          ) {
            throw new Error(
              "REAL NOT QUALIFIED: Work settled or stopped before a second genuine response gate could establish the StopExecution boundary",
            );
          }
        }
      }
      if (heldAfterEffect === undefined) {
        throw new Error(
          "REAL NOT QUALIFIED: deadline waiting for post-effect provider response",
        );
      }
      if (!heldResponseContainsActionCall(heldAfterEffect)) {
        throw new Error(
          "REAL NOT QUALIFIED: post-effect held real Provider response did not contain an action call to fence",
        );
      }
      lastSequence = heldAfterEffect.sequence;
      const workspaceAtStop = captureWorkspaceSnapshot(
        fixture.workspaceDirectory,
      );
      const active = await waitForWork(
        client,
        project.rootWorkspaceId,
        input.marker,
        deadlineAt,
      );
      if (
        active === null ||
        active.workId === undefined ||
        active.activeExecution?.executionId === undefined
      )
        throw new Error(
          "REAL NOT QUALIFIED: no active execution at StopExecution boundary",
        );
      const targetExecutionId = active.activeExecution.executionId;
      expect(active.revision).toBe(work.revision);
      const toolFactsAtStop = readInvocationFacts(
        fixture.databaseFile,
        targetExecutionId,
      );
      const executionAtStop = readExecutionStopSnapshot(
        fixture.databaseFile,
        targetExecutionId,
      );
      expect(executionAtStop.stop_requested_at).toBeNull();
      expect(executionAtStop.settlement_kind).toBeNull();
      expect(
        toolFactsAtStop.some(
          (fact) =>
            fact.tool_name === "patch" && fact.settlement_kind === "Success",
        ),
      ).toBe(true);
      expect(
        toolFactsAtStop.every((fact) => fact.settlement_kind !== null),
      ).toBe(true);
      const stopReceipt = await client.command(
        project.projectId,
        "StopExecution",
        { executionId: targetExecutionId },
      );
      const stopRequestedSnapshot = readExecutionStopSnapshot(
        fixture.databaseFile,
        targetExecutionId,
      );
      expect(stopRequestedSnapshot.stop_requested_at).not.toBeNull();
      expect(stopRequestedSnapshot.settlement_kind).toBeNull();
      state.publicStopCommand = {
        commandType: "StopExecution",
        executionId: targetExecutionId,
        resolution: "Committed",
      };
      state.stopScope =
        "StopExecution fences this exact Execution; the Work remains Open at the same revision. This does not qualify the currently unwired CriticalSteer composite or assert a permanent Work pause; any future distinct Execution/revision is not counted as activity by this stopped execution.";
      state.auxiliaryOracle =
        "ExactExecutionReadOnlySQLiteStop/ProviderTurn/ToolInvocationSnapshot; primary outcome read from public Work/Workspace views";
      state.stopCommandReceipt = stopReceipt;
      state.executionAfterStopCommit = stopRequestedSnapshot;
      state.heldActualProviderResponse = {
        requestId: heldAfterEffect.requestId,
        sequence: heldAfterEffect.sequence,
        status: heldAfterEffect.status,
        actualUpstreamBodyCapturedBeforeStop: true,
        responseReleasedAfterStopCommit: true,
      };
      releaseTrackedProviderResponse(heldAfterEffect.requestId);
      const quiesced = await waitForPublic(
        async () => {
          const current = await client.view<{
            workId?: string;
            revision: number;
            status: string;
            activeExecution?: { executionId: string };
          } | null>("current-work", { workspaceId: project.rootWorkspaceId });
          return {
            current,
            execution: readExecutionStopSnapshot(
              fixture.databaseFile,
              targetExecutionId,
            ),
          };
        },
        ({ current, execution }) =>
          execution.stop_requested_at !== null &&
          execution.settlement_kind === "Interrupted" &&
          current?.activeExecution?.executionId !== targetExecutionId,
        Math.max(1, deadlineAt - Date.now()),
      );
      const currentAfterStop = quiesced.current;
      expect(quiesced.execution.stop_requested_at).not.toBeNull();
      expect(quiesced.execution.settlement_kind).toBe("Interrupted");
      expect(
        JSON.parse(quiesced.execution.settlement_json ?? "{}"),
      ).toMatchObject({
        _tag: "Interrupted",
        result: { _tag: "StopRequested" },
      });
      expect(quiesced.execution.providerTurnCount).toBe(
        executionAtStop.providerTurnCount,
      );
      expect(
        readInvocationFacts(fixture.databaseFile, targetExecutionId),
      ).toEqual(toolFactsAtStop);
      expect(readFileSync(proofPath, "utf8")).toBe(initialContent);
      state.executionAtStop = executionAtStop;
      state.executionAfterQuiescence = quiesced.execution;
      state.workspaceSnapshotAtStop = workspaceAtStop;
      expect(currentAfterStop?.workId).toBe(active.workId);
      expect(currentAfterStop?.revision).toBe(active.revision);
      expect(currentAfterStop?.status).toBe("Open");
      expect(currentAfterStop?.activeExecution?.executionId).not.toBe(
        targetExecutionId,
      );
      const stoppedWork = await client.view<{
        lifecycle: string;
        revision: number;
        acceptedResult?: unknown;
      }>("work-detail", {
        projectId: project.projectId,
        workspaceId: project.rootWorkspaceId,
        workId: active.workId,
      });
      expect(stoppedWork.lifecycle).toBe("Open");
      expect(stoppedWork.revision).toBe(active.revision);
      expect(stoppedWork.acceptedResult).toBeUndefined();
      await fixture.restart({
        daemonEnvironment: {
          ARBOR_PUBLIC_S1_CAPTURE_FILE: captureFile,
          ARBOR_PUBLIC_S1_RESPONSE_GATE_DIR: "",
        },
      });
      const restarted = makeDeadlinePublicClient(fixture, deadlineAt);
      const afterRestart = await restarted.view<typeof currentAfterStop>(
        "current-work",
        { workspaceId: project.rootWorkspaceId },
      );
      expect(afterRestart?.workId).toBe(active.workId);
      expect(afterRestart?.revision).toBe(active.revision);
      expect(afterRestart?.activeExecution?.executionId).not.toBe(
        targetExecutionId,
      );
      const executionAfterRestart = readExecutionStopSnapshot(
        fixture.databaseFile,
        targetExecutionId,
      );
      expect(executionAfterRestart).toEqual(quiesced.execution);
      expect(
        readInvocationFacts(fixture.databaseFile, targetExecutionId),
      ).toEqual(toolFactsAtStop);
      state.afterStop = currentAfterStop;
      state.afterRestart = afterRestart;
      state.executionAfterRestart = executionAfterRestart;
      state.proofFileRetainedAfterStop = true;
    }
    expect(fixture.providerCalls).toHaveLength(0);
    expect(fixture.daemonErrors).toEqual([]);
    pass = true;
  } catch (error) {
    failure =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  } finally {
    const capturesAtTeardown = readProviderCaptures(captureFile);
    const unreleased = new Set(
      [
        ...pendingHeldRequestIds,
        ...capturesAtTeardown
          .filter((capture) => capture.event === "response-held")
          .map((capture) => capture.requestId),
      ].filter((requestId) => !releasedHeldRequestIds.has(requestId)),
    );
    if (pass && unreleased.size > 0) {
      pass = false;
      failure = `real-provider journey completed with ${unreleased.size} gated responses not explicitly released`;
    }
    for (const requestId of unreleased) {
      try {
        releaseTrackedProviderResponse(requestId);
      } catch (error) {
        pass = false;
        failure = `${failure ?? ""}\nfailed to release held real response during teardown: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    state.teardownReleasedHeldResponseCount = unreleased.size;
    const finalized = await finishRealProviderFixture(
      run,
      pass ? "PASS" : "FAIL",
    );
    if (finalized.status === "FAIL") {
      pass = false;
      failure = `${failure ?? ""}\n${finalized.error ?? "fixture finalization failed"}`;
    }
    const evidencePath = writeRealProviderEvidence({
      run,
      journeyId: `public-s2-${input.marker}`,
      config: input.config,
      status: pass ? "PASS" : "FAIL",
      state,
      ...(failure === undefined ? {} : { error: failure }),
    });
    console.info(`REAL public S2 evidence: ${evidencePath}`);
    if (finalized.fixtureRetained) {
      console.error(
        `REAL public S2 failure retained fixture at ${fixture.directory}`,
      );
    }
  }
  if (!pass)
    throw new Error(
      `REAL public S2 failed: ${redact(failure ?? "unknown failure")}`,
    );
};

const runOptedInScenario = async (
  mode: "normal-steer" | "immediate-stop",
): Promise<void> => {
  if (buildMissing.length > 0)
    throw new Error(
      `REAL NOT QUALIFIED: missing build assets ${buildMissing.join(", ")}`,
    );
  if (!configReadiness.ready)
    throw new Error(
      "REAL NOT QUALIFIED: production provider config unavailable",
    );
  if (!evidenceRootReadiness.ready)
    throw new Error(`REAL NOT QUALIFIED: ${evidenceRootReadiness.reason}`);
  const marker = `S2-${mode === "normal-steer" ? "NORMAL" : "STOP"}-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  await runJourney({
    config: configReadiness.config,
    evidenceRoot: evidenceRootReadiness.path,
    marker,
    mode,
  });
};

it.skipIf(skipReason !== undefined)(
  skipReason === undefined
    ? "REAL public S2 global read and Normal Steer correction"
    : `REAL NOT QUALIFIED: ${skipReason}`,
  () => runOptedInScenario("normal-steer"),
);

it.skipIf(skipReason !== undefined)(
  skipReason === undefined
    ? "REAL public S2 exact StopExecution quiescence and restart"
    : `REAL NOT QUALIFIED: ${skipReason}`,
  () => runOptedInScenario("immediate-stop"),
);
