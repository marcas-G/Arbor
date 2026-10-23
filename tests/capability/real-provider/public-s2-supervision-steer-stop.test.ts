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
  waitForHeldProviderResponse,
  writeRealProviderEvidence,
} from "./public-real-journey-support.js";

const OPT_IN = "ARBOR_RUN_REAL_PUBLIC_S2";
const EVIDENCE_ROOT = "ARBOR_PUBLIC_S2_EVIDENCE_ROOT";
const JOURNEY_BUDGET_MS = 20 * 60_000;
const configReadiness = discoverProductionProviderConfig();
const buildMissing = repositoryBuildAssets();
const skipReason =
  process.env[OPT_IN] !== "1"
    ? `set ${OPT_IN}=1 to explicitly opt in`
    : !configReadiness.ready
      ? configReadiness.reason
      : process.env[EVIDENCE_ROOT] === undefined ||
          !existsSync(process.env[EVIDENCE_ROOT])
        ? `set ${EVIDENCE_ROOT} to an existing private .test-results run directory`
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
  readonly mode: "normal-steer" | "critical-stop";
}): Promise<void> => {
  const deadlineAt = Date.now() + JOURNEY_BUDGET_MS;
  const run = await startRealProviderFixture({
    config: input.config,
    evidenceRoot: input.evidenceRoot,
    journeyId: input.marker.toLowerCase(),
    responseGate: true,
  });
  const { fixture, captureFile } = run;
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
    armProviderResponseGate(run);
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
    const firstHeldResponse = await waitForHeldProviderResponse(run, {
      afterSequence: rootStarts - 1,
      deadlineAt,
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
          guidance: `纠正：该文件唯一一行应改为 ${correctedContent}。保留当前任务脉络，核验实际内容后再结束。${correctionMarker}`,
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
      let lastSequence = firstHeldResponse.sequence;
      releaseProviderResponse(run, firstHeldResponse.requestId);
      let correctionRequest: ProviderCapture | null = null;
      while (Date.now() < deadlineAt && correctionRequest === null) {
        await approveExactPatchIfPending({
          client,
          project,
          workId: work.workId,
          marker: input.marker,
          deadlineAt,
        });
        correctionRequest =
          readProviderCaptures(captureFile).find(
            (capture) =>
              capture.event === "request-start" &&
              capture.sequence > lastSequence &&
              JSON.stringify(capture.request?.messages ?? []).includes(
                correctionMarker,
              ),
          ) ?? null;
        if (correctionRequest === null)
          await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (correctionRequest === null)
        throw new Error(
          "REAL NOT QUALIFIED: correction absent from the subsequent real Provider request",
        );
      state.correctionProviderRequestId = correctionRequest.requestId;
      state.correctionInRealProviderRequest = true;
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
          const held = await waitForHeldProviderResponse(run, {
            afterSequence: lastSequence,
            deadlineAt: Math.min(deadlineAt, Date.now() + 1_000),
          });
          lastSequence = held.sequence;
          releaseProviderResponse(run, held.requestId);
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
        )?.currentWork,
      ).toBeNull();
      state.globalAfterAcceptance = globalAfterAcceptance;
    } else {
      let lastSequence = firstHeldResponse.sequence;
      releaseProviderResponse(run, firstHeldResponse.requestId);
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
          const nextHeld = await waitForHeldProviderResponse(run, {
            afterSequence: lastSequence,
            deadlineAt: Math.min(deadlineAt, Date.now() + 1_000),
          });
          lastSequence = nextHeld.sequence;
          releaseProviderResponse(run, nextHeld.requestId);
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
          heldAfterEffect = await waitForHeldProviderResponse(run, {
            afterSequence: lastSequence,
            deadlineAt: Math.min(deadlineAt, Date.now() + 3_000),
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
              "REAL NOT QUALIFIED: Work settled or stopped before a second genuine response gate could establish the Critical Stop boundary",
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
          "REAL NOT QUALIFIED: no active execution at Critical Stop boundary",
        );
      const toolFactsAtStop = readInvocationFacts(
        fixture.databaseFile,
        active.activeExecution.executionId,
      );
      expect(
        toolFactsAtStop.some(
          (fact) =>
            fact.tool_name === "patch" && fact.settlement_kind === "Success",
        ),
      ).toBe(true);
      expect(
        toolFactsAtStop.every((fact) => fact.settlement_kind !== null),
      ).toBe(true);
      const criticalMarker = `S2-CRITICAL-${input.marker}`;
      await client.command(project.projectId, "SteerWork", {
        workId: active.workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: active.revision,
        steer: {
          severity: "Critical",
          guidance: `立即停止当前执行。方向已经不安全；不要继续发起动作，保留已发生的真实结果。${criticalMarker}`,
        },
        provenance: { source: "HumanInput" },
      });
      state.criticalSteerMarker = criticalMarker;
      state.auxiliaryOracle =
        "ReadOnlySQLiteToolInvocationSettlementSnapshot; primary assertions remain public commands and views";
      state.criticalSteerCommittedAt = new Date().toISOString();
      state.heldActualProviderResponse = {
        requestId: heldAfterEffect.requestId,
        sequence: heldAfterEffect.sequence,
        status: heldAfterEffect.status,
        actualUpstreamBodyCapturedBeforeStop: true,
        responseReleasedAfterStop: true,
      };
      const startsAtStop = startedProviderRequests(
        readProviderCaptures(captureFile),
      ).length;
      releaseProviderResponse(run, heldAfterEffect.requestId);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const startsAfterQuiescence = startedProviderRequests(
        readProviderCaptures(captureFile),
      ).length;
      expect(startsAfterQuiescence).toBe(startsAtStop);
      expect(captureWorkspaceSnapshot(fixture.workspaceDirectory)).toEqual(
        workspaceAtStop,
      );
      expect(readFileSync(proofPath, "utf8")).toBe(initialContent);
      expect(
        readInvocationFacts(
          fixture.databaseFile,
          active.activeExecution.executionId,
        ),
      ).toEqual(toolFactsAtStop);
      const currentAfterStop = await client.view<{
        workId?: string;
        revision: number;
        status: string;
        activeExecution?: { executionId: string };
      } | null>("current-work", { workspaceId: project.rootWorkspaceId });
      expect(currentAfterStop?.workId).toBe(active.workId);
      expect(currentAfterStop?.revision).toBe(active.revision + 1);
      expect(currentAfterStop?.status).toBe("Open");
      expect(currentAfterStop?.activeExecution).toBeUndefined();
      const stoppedWork = await client.view<{
        lifecycle: string;
        acceptedResult?: unknown;
      }>("work-detail", {
        projectId: project.projectId,
        workspaceId: project.rootWorkspaceId,
        workId: active.workId,
      });
      expect(stoppedWork.lifecycle).toBe("Open");
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
      expect(afterRestart?.activeExecution).toBeUndefined();
      expect(
        startedProviderRequests(readProviderCaptures(captureFile)),
      ).toHaveLength(startsAtStop);
      state.afterStop = currentAfterStop;
      state.afterRestart = afterRestart;
      state.providerStartsAtAndAfterStop = startsAtStop;
      state.workspaceSnapshotRetainedAfterStop = true;
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

it.skipIf(skipReason !== undefined)(
  skipReason === undefined
    ? "REAL public S2 global read, normal steer, and critical stop"
    : `REAL NOT QUALIFIED: ${skipReason}`,
  async () => {
    if (buildMissing.length > 0)
      throw new Error(
        `REAL NOT QUALIFIED: missing build assets ${buildMissing.join(", ")}`,
      );
    if (!configReadiness.ready)
      throw new Error(
        "REAL NOT QUALIFIED: production provider config unavailable",
      );
    const evidenceRoot = process.env[EVIDENCE_ROOT];
    if (evidenceRoot === undefined || !existsSync(evidenceRoot))
      throw new Error(
        `REAL NOT QUALIFIED: ${EVIDENCE_ROOT} must be an existing private directory`,
      );
    const normalMarker = `S2-NORMAL-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
    const criticalMarker = `S2-STOP-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
    await runJourney({
      config: configReadiness.config,
      evidenceRoot,
      marker: normalMarker,
      mode: "normal-steer",
    });
    await runJourney({
      config: configReadiness.config,
      evidenceRoot,
      marker: criticalMarker,
      mode: "critical-stop",
    });
  },
);
