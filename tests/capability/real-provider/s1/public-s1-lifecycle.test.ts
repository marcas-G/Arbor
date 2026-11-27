// REAL public S1 lifecycle journey — moved verbatim from
// ../public-s1-lifecycle.test.ts (B5 split).
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../../../functional/support/production-fixture.js";
import {
  createFunctionalProject,
  functionalId,
  makePublicClient,
  submitHumanMessage,
  waitForPublic,
} from "../../../functional/support/public-client.js";
import { removeFunctionalFixtureDirectory } from "../../../functional/support/schema44-bootstrap.js";
import {
  createP39PrivateTestFile,
  makeP39PrivateTestDirectory,
} from "../../../support/windows-deployment-qualification.js";
import { isChatCompletionsPath } from "../provider-capture-path.js";
import {
  advertisedToolNames,
  completedProviderRequestIds,
  type ProviderCapture,
  readProviderCaptures,
  startedProviderRequests,
  systemPromptText,
} from "./support/captures.js";
import {
  buildAssetsMissingAtLoad,
  CAPTURE_ENDPOINT_ENV,
  CAPTURE_FILE_ENV,
  evidenceRootReadiness,
  fetchHook,
  JOURNEY_BUDGET_MS,
  missingBuildAssets,
  readinessAtLoad,
  skipReason,
} from "./support/config.js";
import {
  approveExactPatchIfRequired,
  currentState,
  setActiveFixture,
  waitForExactWorkApproval,
} from "./support/journey.js";
import {
  captureWorkspaceFileSnapshot,
  type PublicScenarioState,
  readVerifierObservationOracle,
  redactText,
  remainingJourneyTime,
  safeEndpoint,
  writeEvidence,
} from "./support/oracles.js";

const realS1TestTitle =
  skipReason !== undefined
    ? `REAL NOT QUALIFIED: ${skipReason}`
    : buildAssetsMissingAtLoad.length > 0
      ? "REAL NOT QUALIFIED: build apps/single-workspace and apps/web before the real journey"
      : "REAL public S1: Work effect, independent Verification, human Acceptance, Completed, and restart";

it.skipIf(skipReason !== undefined)(realS1TestTitle, async () => {
  const missingAssets = missingBuildAssets();
  if (missingAssets.length > 0) {
    throw new Error(
      `REAL NOT QUALIFIED: missing ${missingAssets.join(", ")}; run pnpm build and pnpm --filter @arbor/web build before starting the daemon or Provider request`,
    );
  }
  if (!readinessAtLoad.ready) {
    throw new Error(
      "REAL NOT QUALIFIED: production provider config disappeared after discovery",
    );
  }
  const config = readinessAtLoad.config;
  const journeyDeadlineAt = Date.now() + JOURNEY_BUDGET_MS;
  const marker = `REAL-S1-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const proofName = `proof-${marker.toLowerCase()}.txt`;
  const proofContent = `S1-PUBLIC-REAL-PROOF:${marker}`;
  const hookUrl = pathToFileURL(fetchHook).href;
  let captureFile: string | undefined;
  let privateEvidenceDirectory: string | undefined;
  let fixture: ProductionFixture | undefined;
  let state: PublicScenarioState = {};
  let result: "PASS" | "FAIL" = "FAIL";
  let errorDetail: string | undefined;
  try {
    if (!evidenceRootReadiness.ready) {
      throw new Error(`REAL NOT QUALIFIED: ${evidenceRootReadiness.reason}`);
    }
    const evidenceRoot = evidenceRootReadiness.path;
    privateEvidenceDirectory = makeP39PrivateTestDirectory(
      evidenceRoot,
      "evidence-",
    );
    const previousCapturePath = process.env[CAPTURE_FILE_ENV];
    try {
      fixture = await startProductionFixture({
        admitWorkspaceDirectory: true,
        preserveDirectoryOnStop: true,
        reply: () => {
          throw new Error(
            "REAL NOT QUALIFIED: the scripted provider endpoint received a request",
          );
        },
        daemonEnvironment: {
          ARBOR_CONFIG: config.path,
          ARBOR_MODEL_BASE_URL: "",
          ARBOR_MODEL_NAME: "",
          ARBOR_MODEL_API_KEY_VAR: "",
          [CAPTURE_ENDPOINT_ENV]: safeEndpoint(config.endpoint),
          NODE_OPTIONS:
            `${process.env.NODE_OPTIONS ?? ""} --import=${hookUrl}`.trim(),
        },
        setupProbe: (event) => {
          if (event.stage !== "after-clone") return;
          if (privateEvidenceDirectory === undefined) {
            throw new Error("private evidence directory was not prepared");
          }
          captureFile = join(
            privateEvidenceDirectory,
            "provider-captures.jsonl",
          );
          createP39PrivateTestFile(captureFile);
          process.env[CAPTURE_FILE_ENV] = captureFile;
        },
      });
      setActiveFixture(fixture);
    } finally {
      if (previousCapturePath === undefined)
        delete process.env[CAPTURE_FILE_ENV];
      else process.env[CAPTURE_FILE_ENV] = previousCapturePath;
    }
    if (captureFile === undefined) {
      throw new Error(
        "isolated fixture did not prepare the private provider capture file",
      );
    }
    if (privateEvidenceDirectory === undefined) {
      throw new Error("private evidence directory was not prepared");
    }
    const capturePath = captureFile;
    setActiveFixture(fixture);
    state = {
      retainedPaths: {
        fixtureDirectory: fixture.directory,
        databaseFile: fixture.databaseFile,
        workspaceDirectory: fixture.workspaceDirectory,
        captureFile,
        evidenceDirectory: privateEvidenceDirectory,
        failureCleanup:
          "Journey failures after daemon start retain the P39-private fixture directory/database and run-local P39-private capture/evidence directory until human review. Provider capture is written directly to the run-local private directory; fixture startup failures follow bounded helper cleanup and retain the private evidence record.",
        passCleanup:
          "After all public assertions and bounded fixture stop pass, the test removes only the fixture directory/database; the run-local P39-private capture/evidence directory is retained for qualification review.",
      },
    };
    const client = makePublicClient(fixture.baseUrl, {
      deadlineAt: journeyDeadlineAt,
    });
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      `Real public S1 ${marker}`,
      { resourceSelection: "Profile" },
    );
    state = { ...state, project };
    const workspaceBaseline = captureWorkspaceFileSnapshot(
      fixture.workspaceDirectory,
    );
    state = { ...state, workspaceBaseline };

    await client.command(project.projectId, "GrantPermission", {
      permissionGrantId: functionalId("pgr"),
      issuer: "user:local",
      subject: {
        _tag: "WorkspaceAgent",
        workspaceId: project.rootWorkspaceId,
      },
      capability: "fs:write",
      target: project.rootWorkspaceId,
      expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    });
    await submitHumanMessage(
      client,
      project,
      `请在当前项目工作区直接完成目标 ${marker}：只用 patch 创建文件 ${proofName}，唯一一行内容严格为 ${proofContent}，然后用 read 读回核对。不得创建或提议其他 Workspace、分派子 Work、调用 shell 或网络工具、访问其他工作区，也不要等待其他 Work 或尚未发生的 Verification。如果这项 patch 需要我的批准，请提交该项精确审批并在批准后继续当前 Work。只有文件内容精确匹配后才提交完成声明，供独立核验。verificationMission 的 required criteria 只设置两个可由独立 Verifier 直接观察的结果：文件存在、内容逐字符精确匹配；patch/read/不得调用 shell 或网络/不得扩展 Workspace 等过程约束放入 Work constraints，并在 verificationMission.riskRequirements 中逐条原样保留，不要把 Verifier 看不到的生产执行记录或过程声明设为 criterion。`,
    );
    const approval = await waitForExactWorkApproval(
      client,
      project,
      marker,
      journeyDeadlineAt,
    );
    const rootProviderTurnMaybe = await waitForPublic<ProviderCapture | null>(
      async () =>
        readProviderCaptures(capturePath).find(
          (capture) =>
            capture.event === "response-complete" &&
            isChatCompletionsPath(capture.path) &&
            capture.request !== undefined,
        ) ?? null,
      (capture) => capture !== null,
      remainingJourneyTime(journeyDeadlineAt),
    );
    if (rootProviderTurnMaybe === null) {
      throw new Error(
        "real RootConversation Provider request was not captured",
      );
    }
    const rootProviderTurn = rootProviderTurnMaybe;
    const rootSystemPrompt = systemPromptText(rootProviderTurn);
    expect(rootSystemPrompt).toContain(
      "RootConversation intentionally has no executable Work tools",
    );
    expect(rootSystemPrompt).not.toContain(
      "In a WorkspaceWork turn bound to a current Work",
    );
    expect(rootSystemPrompt).toContain(
      "do not create Work just because the user asked a question",
    );
    expect(rootSystemPrompt).toContain(
      "do not promise a tool, resource, or permission that canonical profile/context does not expose",
    );
    state = {
      ...state,
      rootPromptEvidence: {
        providerRequestId: rootProviderTurn.requestId,
        promptAssetRef: "prompt:root-conversation:goal-placement:v8",
        systemPromptSha256: createHash("sha256")
          .update(rootSystemPrompt)
          .digest("hex"),
        routingClauseObserved: true,
        ordinaryConversationBoundaryObserved: true,
        noAssumedResourceOrPermissionClauseObserved: true,
      },
    };
    await client.command(project.projectId, "ResolveControlApproval", {
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: "Approve",
      reason: `approve exact public S1 Work for ${marker}`,
    });
    const currentWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          objective?: string;
          revision: number;
          status: string;
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      // The project is disposable and has no prior Work, so the first
      // current Open Work is the one created by this message. Do not require
      // the model to copy the human marker verbatim into its normalized
      // objective; the exact target file, Work id, revision and later public
      // Verification are the identity oracles for this journey.
      (value) => value?.workId !== undefined && value.status === "Open",
      remainingJourneyTime(journeyDeadlineAt),
    );
    if (currentWork?.workId === undefined) {
      throw new Error(`public current-work did not expose Work ${marker}`);
    }
    state = { ...state, workId: currentWork.workId };
    const proofPath = join(fixture.workspaceDirectory, proofName);
    const workProviderTurnMaybe = await waitForPublic<ProviderCapture | null>(
      async () =>
        readProviderCaptures(capturePath).find((capture) => {
          const names = advertisedToolNames(capture);
          return (
            capture.event === "response-complete" &&
            names.includes("patch") &&
            names.includes("claim_completion")
          );
        }) ?? null,
      (capture) => capture !== null,
      remainingJourneyTime(journeyDeadlineAt),
    );
    if (workProviderTurnMaybe === null) {
      throw new Error("real WorkspaceWork Provider request was not captured");
    }
    const workProviderTurn = workProviderTurnMaybe;
    const workSystemPrompt = systemPromptText(workProviderTurn);
    expect(workSystemPrompt).toContain(
      "In a WorkspaceWork turn bound to a current Work, you are the executing agent responsible for advancing that Work",
    );
    expect(workSystemPrompt).not.toContain(
      "RootConversation intentionally has no executable Work tools",
    );
    state = {
      ...state,
      workPromptEvidence: {
        providerRequestId: workProviderTurn.requestId,
        promptAssetRef: "prompt:base-agent-protocol:base-loop:v3",
        systemPromptSha256: createHash("sha256")
          .update(workSystemPrompt)
          .digest("hex"),
        activeWorkExecutionRoleObserved: true,
        rootConversationActionNotLeaked: true,
      },
    };
    await approveExactPatchIfRequired({
      client,
      project,
      workId: currentWork.workId,
      marker,
      proofPath,
      proofContent,
      databaseFile: fixture.databaseFile,
      captureFile,
      deadlineAt: journeyDeadlineAt,
      recordPrematureWorkWait: (evidence) => {
        state = { ...state, prematureWorkWait: evidence };
      },
    });

    await waitForPublic(
      async () => readFileSync(proofPath, "utf8"),
      (content) => content === proofContent,
      remainingJourneyTime(journeyDeadlineAt),
    );
    const workspaceAfterWork = captureWorkspaceFileSnapshot(
      fixture.workspaceDirectory,
    );
    state = { ...state, workspaceAfterWork };
    for (const [path, baselineEntry] of Object.entries(
      workspaceBaseline.entries,
    )) {
      expect(workspaceAfterWork.entries[path]).toEqual(baselineEntry);
    }
    const newEntries = Object.keys(workspaceAfterWork.entries)
      .filter((path) => !Object.hasOwn(workspaceBaseline.entries, path))
      .sort();
    expect(newEntries).toEqual([proofName]);
    expect(workspaceAfterWork.entries[proofName]).toMatchObject({
      kind: "file",
      size: Buffer.byteLength(proofContent, "utf8"),
      sha256: createHash("sha256").update(proofContent, "utf8").digest("hex"),
      bytesBase64: Buffer.from(proofContent, "utf8").toString("base64"),
    });

    const verified = await waitForPublic(
      () => currentState(client, project, currentWork.workId as string),
      ({ verification }) =>
        verification.verdict === "Pass" &&
        verification.verificationId !== undefined &&
        verification.evidenceRefs.length > 0,
      remainingJourneyTime(journeyDeadlineAt),
    );
    const verificationId = verified.verification.verificationId;
    const targetWorkRevision = verified.verification.targetWorkRevision;
    if (verificationId === undefined || targetWorkRevision === undefined) {
      throw new Error(
        "public Verification PASS omitted exact Work identity/revision",
      );
    }
    state = { ...state, verificationId };
    expect(verified.work.lifecycle).toBe("Open");
    expect(verified.work.revision).toBe(targetWorkRevision);
    expect(verified.verification.acceptance).toBeUndefined();
    const verifierObservationOracle = readVerifierObservationOracle({
      databaseFile: fixture.databaseFile,
      workId: currentWork.workId,
      verificationId,
    });
    expect(verifierObservationOracle.oracleLayer).toBe(
      "ReadOnlySQLiteAuxiliary",
    );
    expect(verifierObservationOracle.primaryJourneyLayer).toBe(
      "PublicCommandsAndViews",
    );
    expect(verifierObservationOracle.verifierExecutionId).not.toBe(
      verifierObservationOracle.producerExecutionId,
    );
    expect(
      verifierObservationOracle.observations.some(
        (observation) =>
          observation.toolName === "read" &&
          observation.settlementKind === "Success" &&
          observation.toolResultStatus === "Succeeded",
      ),
    ).toBe(true);
    state = { ...state, verifierObservationOracle };

    // Verification PASS is not yet human Acceptance. Keep the public
    // workflow in that deliberate interval long enough for several
    // scheduler ticks and prove that the same Open revision is held instead
    // of asking the model to run it again.
    const providerStartsAfterVerification = startedProviderRequests(
      readProviderCaptures(capturePath),
    ).length;
    await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
    expect(
      startedProviderRequests(readProviderCaptures(capturePath)),
    ).toHaveLength(providerStartsAfterVerification);

    await client.command(project.projectId, "AcceptWorkOutcome", {
      acceptanceId: functionalId("acc"),
      workId: currentWork.workId,
      targetWorkRevision,
      verificationId,
    });
    const accepted = await waitForPublic(
      () => currentState(client, project, currentWork.workId as string),
      ({ verification, work }) =>
        verification.acceptance !== undefined && work.lifecycle === "Completed",
      remainingJourneyTime(journeyDeadlineAt),
    );
    if (accepted.verification.acceptance === undefined) {
      throw new Error("public Acceptance did not appear after commit");
    }
    expect(accepted.verification.acceptance.actor).toBe("user:local");
    expect(accepted.work.acceptedResult).toMatchObject({
      verificationId,
      targetWorkRevision,
      verdict: "Pass",
    });
    expect(
      await client.view<unknown>("current-work", {
        workspaceId: project.rootWorkspaceId,
      }),
    ).toBeNull();
    state = { ...state, acceptedWork: accepted.work };

    const capturesBeforeRestart = await waitForPublic(
      async () => readProviderCaptures(capturePath),
      (captures) => {
        const starts = startedProviderRequests(captures);
        const finished = completedProviderRequestIds(captures);
        return (
          starts.length > 0 &&
          starts.every((start) => finished.has(start.requestId))
        );
      },
      Math.min(60_000, remainingJourneyTime(journeyDeadlineAt)),
    );
    const startsBeforeRestart = startedProviderRequests(capturesBeforeRestart);
    const completedBeforeRestart = capturesBeforeRestart.filter(
      (capture) => capture.event === "response-complete",
    );
    expect(completedBeforeRestart).toHaveLength(startsBeforeRestart.length);
    expect(
      capturesBeforeRestart.some(
        (capture) =>
          capture.event === "request-failed" ||
          capture.event === "response-capture-failed",
      ),
    ).toBe(false);
    expect(
      completedBeforeRestart.every(
        (capture) =>
          capture.status !== undefined &&
          capture.status >= 200 &&
          capture.status < 300,
      ),
    ).toBe(true);
    const callsBeforeRestart = startsBeforeRestart.length;
    state = { ...state, providerCallCountBeforeRestart: callsBeforeRestart };
    await fixture.restart({
      daemonEnvironment: { [CAPTURE_FILE_ENV]: capturePath },
    });
    const restartedClient = makePublicClient(fixture.baseUrl, {
      deadlineAt: journeyDeadlineAt,
    });
    const restarted = await waitForPublic(
      () =>
        currentState(restartedClient, project, currentWork.workId as string),
      ({ verification, work }) =>
        verification.acceptance?.acceptanceId ===
          accepted.verification.acceptance?.acceptanceId &&
        work.lifecycle === "Completed",
      remainingJourneyTime(journeyDeadlineAt),
    );
    expect(restarted.verification).toMatchObject({
      verificationId,
      targetWorkRevision,
      verdict: "Pass",
    });
    expect(restarted.work.acceptedResult).toEqual(accepted.work.acceptedResult);
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
    const capturesAfterRestart = readProviderCaptures(capturePath);
    expect(capturesAfterRestart.length).toBeGreaterThan(0);
    const startsAfterRestart = startedProviderRequests(capturesAfterRestart);
    expect(startsAfterRestart).toHaveLength(callsBeforeRestart);
    const finishedAfterRestart =
      completedProviderRequestIds(capturesAfterRestart);
    expect(
      startsAfterRestart.every((start) =>
        finishedAfterRestart.has(start.requestId),
      ),
    ).toBe(true);
    expect(
      capturesAfterRestart.every(
        (capture) =>
          capture.event !== "request-failed" &&
          capture.event !== "response-capture-failed",
      ),
    ).toBe(true);
    expect(fixture.providerCalls).toHaveLength(0);
    expect(fixture.daemonErrors).toEqual([]);

    const bodies = capturesAfterRestart
      .filter(
        (capture) =>
          capture.event === "response-complete" &&
          capture.responseBodyBase64 !== undefined,
      )
      .map((capture) =>
        Buffer.from(capture.responseBodyBase64 as string, "base64").toString(
          "utf8",
        ),
      );
    const wire = bodies.join("\n");
    for (const action of [
      "patch",
      "claim_completion",
      "record_verification_evidence",
      "conclude_verification",
    ]) {
      expect(
        wire,
        `real provider response did not contain ${action}`,
      ).toContain(action);
    }
    expect(wire).not.toMatch(/"name"\s*:\s*"shell"/u);
    expect(wire).not.toMatch(
      /"name"\s*:\s*"(?:spawn_specialist|spawn_agent)"/u,
    );
    expect(
      capturesAfterRestart.some(
        (capture) => capture.request?.model === config.wireModelName,
      ),
    ).toBe(true);
    state = { ...state, restartRead: restarted };
    result = "PASS";
  } catch (error) {
    const diagnostics = {
      fixtureDirectory: fixture?.directory ?? null,
      databaseFile: fixture?.databaseFile ?? null,
      workspaceDirectory: fixture?.workspaceDirectory ?? null,
      captureFile: captureFile ?? null,
      evidenceDirectory: privateEvidenceDirectory ?? null,
      capturedRequestStarts:
        captureFile === undefined
          ? 0
          : startedProviderRequests(readProviderCaptures(captureFile)).length,
      scriptedFallbackCalls: fixture?.providerCalls.length ?? 0,
      daemonErrors: fixture?.daemonErrors.map(redactText) ?? [],
      daemon: fixture?.daemonProcessSnapshot() ?? null,
    };
    errorDetail = `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n${JSON.stringify(diagnostics)}`;
    result = "FAIL";
  } finally {
    let teardownFailure: unknown;
    if (fixture !== undefined) {
      setActiveFixture(undefined);
      try {
        await fixture.stop();
      } catch (error) {
        teardownFailure = error;
        result = "FAIL";
        errorDetail = `${errorDetail === undefined ? "" : `${errorDetail}\n`}fixture stop failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
      }
      if (result === "PASS" && teardownFailure === undefined) {
        try {
          removeFunctionalFixtureDirectory(fixture.directory);
        } catch (error) {
          teardownFailure = error;
          result = "FAIL";
          errorDetail = `fixture directory cleanup failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
        }
      }
    }
    if (privateEvidenceDirectory !== undefined) {
      const captures =
        captureFile === undefined ? [] : readProviderCaptures(captureFile);
      const evidencePath = writeEvidence({
        evidenceDirectory: privateEvidenceDirectory,
        config,
        captures,
        publicScenario: state,
        result,
        ...(errorDetail === undefined ? {} : { error: errorDetail }),
      });
      console.info(`REAL public S1 evidence: ${evidencePath}`);
    }
  }
  if (result === "FAIL") {
    throw new Error(
      `REAL public S1 failed: ${redactText(errorDetail ?? "qualification failed without diagnostics")}`,
    );
  }
});
