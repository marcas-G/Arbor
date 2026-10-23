import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  createFunctionalProject,
  type FunctionalProject,
  functionalId,
  type PublicClient,
  waitForPublic,
} from "../../functional/support/public-client.js";
import {
  armProviderResponseGate,
  captureWorkspaceSnapshot,
  discoverProductionProviderConfig,
  finishRealProviderFixture,
  makeDeadlinePublicClient,
  type ProviderCapture,
  providerCaptureMatchesSelector,
  readProviderCaptures,
  redactRealProviderDiagnostic,
  releaseProviderResponse,
  repositoryBuildAssets,
  type StartedRealProviderFixture,
  startedProviderRequests,
  startRealProviderFixture,
  validateRealJourneyEvidenceRoot,
  waitForHeldProviderResponse,
  writeRealProviderEvidence,
} from "./public-real-journey-support.js";

/**
 * Bounded S3 slice: covers nested responsibility, dependency-first wait,
 * exact write approval recovery, delivery, Verification, and acceptance.
 * It does not qualify all information-block or escalation outcomes in S3.
 */

const OPT_IN_ENV = "ARBOR_RUN_REAL_PUBLIC_S3";
const EVIDENCE_ROOT_ENV = "ARBOR_PUBLIC_REAL_EVIDENCE_ROOT";
const JOURNEY_BUDGET_MS = 20 * 60_000;
const TEST_TIMEOUT_MS = 22 * 60_000;
const readinessAtLoad = discoverProductionProviderConfig();
const missingAssetsAtLoad = repositoryBuildAssets();
const evidenceRootReadiness = validateRealJourneyEvidenceRoot(
  process.env[EVIDENCE_ROOT_ENV],
);
const skipReason =
  process.env[OPT_IN_ENV] !== "1"
    ? `set ${OPT_IN_ENV}=1 to explicitly opt in`
    : !readinessAtLoad.ready
      ? readinessAtLoad.reason
      : !evidenceRootReadiness.ready
        ? evidenceRootReadiness.reason
        : missingAssetsAtLoad.length > 0
          ? `build required production assets: ${missingAssetsAtLoad.join(", ")}`
          : undefined;

let activeRun: StartedRealProviderFixture | undefined;

afterEach(async () => {
  const run = activeRun;
  activeRun = undefined;
  await run?.fixture.stop();
});

interface WorkspaceNode {
  readonly workspaceId: string;
  readonly parentWorkspaceId: string | null;
  readonly name: string;
  readonly currentWork?: {
    readonly workId?: string;
    readonly objective: string;
    readonly status?: string;
  };
}

interface PublicDependency {
  readonly dependencyId: string;
  readonly consumerWorkId: string;
  readonly binding: { readonly _tag?: string; readonly workspaceId?: string };
  readonly state: string;
  readonly satisfiedBy?: string;
}

interface ExactExecutableApproval {
  readonly approvalId: string;
  readonly revision: number;
  readonly executionId: string;
  readonly toolName: string;
  readonly targetResourceSpaceIds: ReadonlyArray<string>;
  readonly capabilities: ReadonlyArray<string>;
}

interface ExactChildPermissionGrant {
  readonly subjectWorkspaceId: string;
  readonly capability: "fs:write";
  readonly targetWorkspaceId: string;
  readonly expiresAt: string;
}

const capturedToolCalls = (
  capture: ProviderCapture,
): ReadonlyArray<{ readonly name: string; readonly arguments?: unknown }> => {
  if (capture.responseBodyBase64 === undefined) return [];
  const body = Buffer.from(capture.responseBodyBase64, "base64").toString(
    "utf8",
  );
  const fragments = new Map<number, { name: string; argumentsText: string }>();
  const absorb = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const calls = (
      value as {
        choices?: Array<{
          delta?: { tool_calls?: unknown[] };
          message?: { tool_calls?: unknown[] };
        }>;
      }
    ).choices?.[0];
    const toolCalls =
      calls?.delta?.tool_calls ?? calls?.message?.tool_calls ?? [];
    for (const rawCall of toolCalls) {
      if (typeof rawCall !== "object" || rawCall === null) continue;
      const call = rawCall as {
        index?: number;
        function?: { name?: unknown; arguments?: unknown };
      };
      const index = call.index ?? fragments.size;
      const fragment = fragments.get(index) ?? { name: "", argumentsText: "" };
      if (typeof call.function?.name === "string") {
        fragment.name += call.function.name;
      }
      if (typeof call.function?.arguments === "string") {
        fragment.argumentsText += call.function.arguments;
      } else if (call.function?.arguments !== undefined) {
        fragment.argumentsText += JSON.stringify(call.function.arguments);
      }
      fragments.set(index, fragment);
    }
  };
  for (const line of body.split(/\r?\n/u)) {
    if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
    try {
      absorb(JSON.parse(line.slice(6)) as unknown);
    } catch {
      // Non-JSON stream metadata is outside the tool-call oracle.
    }
  }
  if (fragments.size === 0 && body.trimStart().startsWith("{")) {
    try {
      absorb(JSON.parse(body) as unknown);
    } catch {
      return [];
    }
  }
  return [...fragments.values()].map((fragment) => {
    let parsedArguments: unknown;
    try {
      parsedArguments = JSON.parse(fragment.argumentsText) as unknown;
    } catch {
      parsedArguments = fragment.argumentsText;
    }
    return {
      name: fragment.name,
      ...(fragment.argumentsText.length > 0
        ? { arguments: parsedArguments }
        : {}),
    };
  });
};

const releaseHeldProviderResponses = async (input: {
  readonly run: StartedRealProviderFixture;
  readonly released: Set<string>;
  readonly beforeDependencyWait: boolean;
  readonly selector: {
    readonly requiredAdvertisedToolName: string;
    readonly requiredMessageText: string;
  };
  readonly sequenceCursor: { value: number };
  readonly deadlineAt: number;
}) => {
  try {
    const held = await waitForHeldProviderResponse(input.run, {
      afterSequence: input.sequenceCursor.value,
      deadlineAt: Math.min(input.deadlineAt, Date.now() + 100),
      selector: input.selector,
    });
    input.sequenceCursor.value = held.sequence;
    if (!providerCaptureMatchesSelector(held, input.selector)) {
      throw new Error(
        "S3 held Provider response did not match its gate selector",
      );
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith(
        "REAL NOT QUALIFIED: deadline waiting for a genuine held Provider response",
      )
    ) {
      throw error;
    }
  }
  const captures = readProviderCaptures(input.run.captureFile);
  const responseReleased = new Set(
    captures
      .filter((capture) => capture.event === "response-released")
      .map((capture) => capture.requestId),
  );
  for (const capture of captures) {
    if (
      capture.event !== "response-held" ||
      input.released.has(capture.requestId) ||
      responseReleased.has(capture.requestId) ||
      !providerCaptureMatchesSelector(capture, input.selector)
    ) {
      continue;
    }
    const names = capturedToolCalls(capture).map((call) => call.name);
    const canProceedToDependencyWait =
      names.length === 0 ||
      names.every((name) =>
        [
          "propose_workspace",
          "declare_dependency",
          "wait",
          "list_workspaces",
          "read_workspace",
          "send_message",
          "read",
          "list",
        ].includes(name),
      );
    if (!input.beforeDependencyWait || canProceedToDependencyWait) {
      input.released.add(capture.requestId);
      await releaseProviderResponse(input.run, capture.requestId);
    }
  }
  return captures;
};

const proposalKey = (
  entryKey: string,
): { readonly proposalId: string; readonly revision: number } | undefined => {
  const match = /^gov:(fpr_[^:]+):(\d+)$/u.exec(entryKey);
  return match === null
    ? undefined
    : { proposalId: match[1] as string, revision: Number(match[2]) };
};

const controlApprovalKey = (
  entryKey: string,
): { readonly approvalId: string; readonly revision: number } | undefined => {
  const match = /^cap:(cap_[^:]+):(\d+)$/u.exec(entryKey);
  return match === null
    ? undefined
    : { approvalId: match[1] as string, revision: Number(match[2]) };
};

const executableApprovalKey = (entry: {
  readonly entryKey: string;
  readonly target?: {
    readonly kind?: string;
    readonly approvalId?: string;
    readonly revision?: number;
    readonly executionId?: string;
    readonly toolName?: string;
    readonly targetResourceSpaceIds?: ReadonlyArray<string>;
    readonly capabilities?: ReadonlyArray<string>;
  };
}): ExactExecutableApproval | undefined => {
  const match = /^eap:([^:]+):(\d+)$/u.exec(entry.entryKey);
  const target = entry.target;
  if (
    match === null ||
    target?.kind !== "ExecutableApproval" ||
    target.approvalId !== match[1] ||
    target.revision !== Number(match[2]) ||
    typeof target.executionId !== "string" ||
    typeof target.toolName !== "string" ||
    target.targetResourceSpaceIds === undefined ||
    target.capabilities === undefined
  ) {
    return undefined;
  }
  return {
    approvalId: match[1] as string,
    revision: Number(match[2]),
    executionId: target.executionId as string,
    toolName: target.toolName as string,
    targetResourceSpaceIds: target.targetResourceSpaceIds,
    capabilities: target.capabilities,
  };
};

const responseCompletedIds = (captures: ReadonlyArray<ProviderCapture>) =>
  new Set(
    captures
      .filter(
        (capture) =>
          capture.event === "response-complete" ||
          capture.event === "response-released" ||
          capture.event === "response-capture-failed" ||
          capture.event === "request-failed",
      )
      .map((capture) => capture.requestId),
  );

const parentOf = (
  nodes: ReadonlyArray<WorkspaceNode>,
  workspaceId: string,
): WorkspaceNode | undefined => {
  const node = nodes.find((candidate) => candidate.workspaceId === workspaceId);
  return node?.parentWorkspaceId === null
    ? undefined
    : nodes.find(
        (candidate) => candidate.workspaceId === node?.parentWorkspaceId,
      );
};

const readTree = (client: PublicClient, projectId: string) =>
  client.view<{ nodes: Array<WorkspaceNode> }>("responsibility-tree", {
    projectId,
  });

const approvePendingGovernance = async (input: {
  readonly client: PublicClient;
  readonly projectId: string;
  readonly workspaceIds: ReadonlyArray<string>;
  readonly marker: string;
  readonly handled: Set<string>;
}) => {
  let formationDecisions = 0;
  let controlApprovals = 0;
  for (const workspaceId of input.workspaceIds) {
    const inbox = await input.client.view<{
      unconsumed: Array<{ entryKey: string; kind: string; summary: string }>;
    }>("inbox-view", { workspaceId });
    for (const entry of inbox.unconsumed) {
      if (
        entry.kind !== "Governance" ||
        !entry.summary.includes(input.marker)
      ) {
        continue;
      }
      const formation = proposalKey(entry.entryKey);
      if (formation !== undefined && !input.handled.has(entry.entryKey)) {
        input.handled.add(entry.entryKey);
        await input.client.command(input.projectId, "RecordDecision", {
          proposalId: formation.proposalId,
          expectedProposalRevision: formation.revision,
          outcome: { _tag: "Approve" },
        });
        formationDecisions += 1;
        continue;
      }
      const control = controlApprovalKey(entry.entryKey);
      if (control !== undefined && !input.handled.has(entry.entryKey)) {
        input.handled.add(entry.entryKey);
        await input.client.command(input.projectId, "ResolveControlApproval", {
          approvalId: control.approvalId,
          expectedRevision: control.revision,
          decision: "Approve",
          reason: `approve the exact S3 organization or Work decision ${input.marker}`,
        });
        controlApprovals += 1;
      }
    }
  }
  return { formationDecisions, controlApprovals };
};

const approveExactWriteRequests = async (input: {
  readonly client: PublicClient;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly workspaceDirectory: string;
  readonly childFile: string;
  readonly marker: string;
  readonly handled: Set<string>;
  readonly receipts: Array<ExactExecutableApproval>;
  readonly stages: Array<Record<string, unknown>>;
  readonly deadlineAt: number;
}) => {
  const inbox = await input.client.view<{
    unconsumed: Array<{
      entryKey: string;
      kind: string;
      summary: string;
      target?: {
        readonly kind?: string;
        readonly approvalId?: string;
        readonly revision?: number;
        readonly executionId?: string;
        readonly toolName?: string;
        readonly targetResourceSpaceIds?: ReadonlyArray<string>;
        readonly capabilities?: ReadonlyArray<string>;
      };
    }>;
  }>("inbox-view", { workspaceId: input.workspaceId });
  for (const entry of inbox.unconsumed) {
    if (entry.kind !== "Governance" || !entry.entryKey.startsWith("eap:")) {
      continue;
    }
    const approval = executableApprovalKey(entry);
    if (approval === undefined || input.handled.has(entry.entryKey)) continue;
    if (
      approval.toolName !== "patch" ||
      approval.capabilities.length !== 1 ||
      approval.capabilities[0] !== "fs:write" ||
      approval.targetResourceSpaceIds.length !== 1 ||
      approval.targetResourceSpaceIds[0] !== "filesystem"
    ) {
      throw new Error(
        `S3 encountered an executable approval outside the exact child filesystem write request for ${input.marker}`,
      );
    }
    const current = await input.client.view<{
      workId?: string;
      status?: string;
      activeExecution?: { executionId: string };
    } | null>("current-work", { workspaceId: input.workspaceId });
    if (
      current?.activeExecution?.executionId !== approval.executionId ||
      current.workId === undefined ||
      current.status !== "Open" ||
      captureWorkspaceSnapshot(input.workspaceDirectory).entries[
        input.childFile
      ] !== undefined
    ) {
      throw new Error(
        `S3 exact write approval did not interrupt the child's active Open Work before artifact creation for ${input.marker}`,
      );
    }
    input.handled.add(entry.entryKey);
    input.receipts.push(approval);
    input.stages.push({
      phase: "ChildExactWriteApprovalRequired",
      workId: current.workId,
      currentExecutionId: approval.executionId,
      approval,
      childArtifactExists: false,
    });
    await input.client.command(input.projectId, "ResolveExecutableApproval", {
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: "Approve",
      reason: `approve only the exact child fs:write patch request for ${input.marker}`,
    });
    const resumed = await waitForPublic(
      () =>
        input.client.view<{
          workId?: string;
          status?: string;
          activeExecution?: { executionId: string };
        } | null>("current-work", { workspaceId: input.workspaceId }),
      (value) =>
        value !== null &&
        value.workId === current.workId &&
        value.status === "Open" &&
        value.activeExecution?.executionId === approval.executionId,
      Math.max(1, Math.min(5_000, input.deadlineAt - Date.now())),
    );
    input.stages.push({
      phase: "ChildExactWriteApprovalResumedSameExecution",
      workId: resumed?.workId,
      executionId: resumed?.activeExecution?.executionId,
      approvalId: approval.approvalId,
    });
  }
};

const realS3Title =
  skipReason === undefined
    ? "REAL public S3: Parent/Child dependency, exact permission approval, delivery, verification, and acceptance"
    : `REAL NOT QUALIFIED: ${skipReason}`;

it.skipIf(skipReason !== undefined)(
  realS3Title,
  async () => {
    if (!readinessAtLoad.ready || !evidenceRootReadiness.ready) {
      throw new Error(
        "REAL NOT QUALIFIED: Provider readiness changed after discovery",
      );
    }
    const deadlineAt = Date.now() + JOURNEY_BUDGET_MS;
    const marker = `REAL-S3-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
    const parentName = `S3 Parent ${marker}`;
    const childName = `S3 Child ${marker}`;
    const parentFile = `parent-result-${marker.toLowerCase()}.txt`;
    const childFile = `child-evidence-${marker.toLowerCase()}.txt`;
    const childWorkMarker = `S3_CHILD_WORK_${marker}`;
    const responseGateSelector = {
      requiredAdvertisedToolName: "patch",
      requiredMessageText: childWorkMarker,
    };
    const heldSequenceCursor = { value: 0 };
    const childEvidencePrefix = `S3-CHILD-EVIDENCE:${marker};nonce=`;
    const handledInbox = new Set<string>();
    const executableApprovals: Array<ExactExecutableApproval> = [];
    let childPermissionGrant: ExactChildPermissionGrant | undefined;
    let run: StartedRealProviderFixture | undefined;
    let project: FunctionalProject | undefined;
    let client: PublicClient | undefined;
    let publicSnapshot: unknown = null;
    const stageEvidence: Array<Record<string, unknown>> = [];
    let artifactEvidence: Record<string, unknown> | undefined;
    let result: "PASS" | "FAIL" = "FAIL";
    let failure: string | undefined;
    let originalError: unknown;
    try {
      run = await startRealProviderFixture({
        config: readinessAtLoad.config,
        evidenceRoot: evidenceRootReadiness.path,
        journeyId: `real-public-s3-${marker.toLowerCase()}`,
        responseGate: true,
      });
      activeRun = run;
      armProviderResponseGate(run, responseGateSelector);
      const fixture = run.fixture;
      client = makeDeadlinePublicClient(fixture, deadlineAt);
      project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `Real public S3 ${marker}`,
        { resourceSelection: "Profile" },
      );
      const baseline = captureWorkspaceSnapshot(fixture.workspaceDirectory);

      const request =
        `请为目标 ${marker} 自主建立清晰、长期的父子责任，并为两个职责各附一个边界明确的初始工作：父工作区名称应含“${parentName}”，负责整合子方证据并交付文件 ${parentFile}，并把标记 ${childWorkMarker} 作为其等待的子工作依据；子工作区名称应含“${childName}”，子方初始工作应包含标记 ${childWorkMarker}，并负责生成唯一文件 ${childFile}。子文件必须只有一行，格式为“${childEvidencePrefix}”后接由子方在执行时自行生成的12位小写字母或数字。父工作区必须依赖这个子工作区的正式交付，等待真实交付到达后读取子文件，将它的完整实际内容原样写入父结果后再完成。` +
        `只在项目已经准入的资源边界内工作，不扩大目录或权限范围。` +
        `若子工作写入受阻，请把精确的单次写入请求提交给我审批；只在审批对应的当前子 Work、活动执行和文件写权限后继续。若缺少必要信息或能力，不要编造产物、不要声称验证通过，也不要把通信当成交付；应明确请求补充或保留 Fail/Unknown。所有产物须经过独立验证，父方只在验证通过且确认结果足够后接受。`;
      const releasedProviderResponses = new Set<string>();
      await client.command(project.projectId, "SubmitHumanMessage", {
        messageId: functionalId("msg"),
        targetWorkspaceId: project.rootWorkspaceId,
        bodyRef: request,
      });

      let parent: WorkspaceNode | undefined;
      let child: WorkspaceNode | undefined;
      let formationDecisionCount = 0;
      while (Date.now() < deadlineAt && child === undefined) {
        await releaseHeldProviderResponses({
          run,
          released: releasedProviderResponses,
          beforeDependencyWait: true,
          selector: responseGateSelector,
          sequenceCursor: heldSequenceCursor,
          deadlineAt,
        });
        const tree = await readTree(client, project.projectId);
        const decisions = await approvePendingGovernance({
          client,
          projectId: project.projectId,
          workspaceIds: tree.nodes.map((node) => node.workspaceId),
          marker,
          handled: handledInbox,
        });
        formationDecisionCount += decisions.formationDecisions;
        parent = tree.nodes.find((node) => node.name.includes(parentName));
        child = tree.nodes.find(
          (node) =>
            node.name.includes(childName) &&
            node.parentWorkspaceId === parent?.workspaceId,
        );
        if (child === undefined) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 250));
        }
      }
      if (parent === undefined || child === undefined) {
        throw new Error(
          `S3 did not form the approved nested Parent/Child workspaces before the bounded deadline; tree=${JSON.stringify(await readTree(client, project.projectId))}`,
        );
      }
      if (formationDecisionCount < 2) {
        throw new Error(
          "S3 did not observe exact human approval for both workspaces",
        );
      }

      const parentWorkId = parent.currentWork?.workId;
      const childWorkId = child.currentWork?.workId;
      if (parentWorkId === undefined || childWorkId === undefined) {
        throw new Error(
          "S3 formed a Workspace without its approved initial Work",
        );
      }
      childPermissionGrant = {
        subjectWorkspaceId: child.workspaceId,
        capability: "fs:write",
        targetWorkspaceId: child.workspaceId,
        expiresAt: new Date(deadlineAt).toISOString(),
      };
      await client.command(project.projectId, "GrantPermission", {
        permissionGrantId: functionalId("pgr"),
        issuer: "user:local",
        subject: {
          _tag: "WorkspaceAgent",
          workspaceId: childPermissionGrant.subjectWorkspaceId,
        },
        capability: childPermissionGrant.capability,
        target: childPermissionGrant.targetWorkspaceId,
        expiresAt: childPermissionGrant.expiresAt,
      });
      let dependencyBeforeDelivery: PublicDependency | undefined;
      let waitingParent: {
        workId?: string;
        activeExecution?: { executionId: string };
      } | null = null;
      while (Date.now() < deadlineAt) {
        await releaseHeldProviderResponses({
          run,
          released: releasedProviderResponses,
          beforeDependencyWait: true,
          selector: responseGateSelector,
          sequenceCursor: heldSequenceCursor,
          deadlineAt,
        });
        const dependencyView = await client.view<{
          rows: Array<PublicDependency>;
        }>("dependency-view", { projectId: project.projectId });
        dependencyBeforeDelivery = dependencyView.rows.find(
          (row) =>
            row.consumerWorkId === parentWorkId &&
            row.binding.workspaceId === child.workspaceId &&
            row.state === "Unsatisfied",
        );
        waitingParent = await client.view<{
          workId?: string;
          activeExecution?: { executionId: string };
        } | null>("current-work", { workspaceId: parent.workspaceId });
        if (
          dependencyBeforeDelivery !== undefined &&
          waitingParent?.workId === parentWorkId &&
          waitingParent.activeExecution === undefined
        ) {
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      expect(dependencyBeforeDelivery?.state).toBe("Unsatisfied");
      expect(waitingParent?.workId).toBe(parentWorkId);
      expect(waitingParent?.activeExecution).toBeUndefined();
      const requestsAtDependencyWait = startedProviderRequests(
        readProviderCaptures(run.captureFile),
      ).length;
      const preDeliveryActions = readProviderCaptures(run.captureFile)
        .filter((capture) => capture.event === "response-held")
        .flatMap(capturedToolCalls)
        .map((call) => call.name);
      expect(preDeliveryActions).toContain("declare_dependency");
      expect(preDeliveryActions).toContain("wait");
      expect(
        captureWorkspaceSnapshot(fixture.workspaceDirectory).entries[childFile],
      ).toBeUndefined();
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
      const stillWaiting = await client.view<{
        rows: Array<PublicDependency>;
      }>("dependency-view", { projectId: project.projectId });
      expect(
        stillWaiting.rows.find(
          (row) =>
            row.consumerWorkId === parentWorkId &&
            row.binding.workspaceId === child.workspaceId,
        )?.state,
      ).toBe("Unsatisfied");
      expect(
        startedProviderRequests(readProviderCaptures(run.captureFile)).length,
      ).toBe(requestsAtDependencyWait);
      expect(
        captureWorkspaceSnapshot(fixture.workspaceDirectory).entries[childFile],
      ).toBeUndefined();
      stageEvidence.push({
        phase: "ParentDependencyWaitBeforeChildArtifact",
        dependency: dependencyBeforeDelivery,
        parentCurrent: waitingParent,
        providerRequestsAtWait: requestsAtDependencyWait,
        artifactExistsAtWait: false,
      });
      await releaseHeldProviderResponses({
        run,
        released: releasedProviderResponses,
        beforeDependencyWait: false,
        selector: responseGateSelector,
        sequenceCursor: heldSequenceCursor,
        deadlineAt,
      });

      const approvedChildWrites = new Set<string>();
      let parentAccepted = false;
      while (Date.now() < deadlineAt) {
        await releaseHeldProviderResponses({
          run,
          released: releasedProviderResponses,
          beforeDependencyWait: false,
          selector: responseGateSelector,
          sequenceCursor: heldSequenceCursor,
          deadlineAt,
        });
        await approveExactWriteRequests({
          client,
          projectId: project.projectId,
          workspaceId: child.workspaceId,
          workspaceDirectory: fixture.workspaceDirectory,
          childFile,
          marker,
          handled: approvedChildWrites,
          receipts: executableApprovals,
          stages: stageEvidence,
          deadlineAt,
        });
        const dependency = await client.view<{ rows: Array<PublicDependency> }>(
          "dependency-view",
          { projectId: project.projectId },
        );
        const parentCurrent = await client.view<{
          workId?: string;
          status?: string;
        } | null>("current-work", { workspaceId: parent.workspaceId });
        const childCurrent = await client.view<{
          workId?: string;
          status?: string;
        } | null>("current-work", { workspaceId: child.workspaceId });
        const verified = await client.view<{
          verdict?: string;
          verificationId?: string;
          targetWorkRevision?: number;
          acceptance?: { actor: string; acceptanceId: string };
        }>("verification", { workId: childWorkId });
        const parentVerified = await client.view<{
          verdict?: string;
          verificationId?: string;
          targetWorkRevision?: number;
          acceptance?: { actor: string; acceptanceId: string };
        }>("verification", { workId: parentWorkId });
        if (
          !parentAccepted &&
          parentVerified.verdict === "Pass" &&
          parentVerified.acceptance === undefined &&
          parentVerified.verificationId !== undefined &&
          parentVerified.targetWorkRevision !== undefined
        ) {
          await client.command(project.projectId, "AcceptWorkOutcome", {
            acceptanceId: functionalId("acc"),
            workId: parentWorkId,
            targetWorkRevision: parentVerified.targetWorkRevision,
            verificationId: parentVerified.verificationId,
          });
          parentAccepted = true;
        }
        const satisfied = dependency.rows.find(
          (row) =>
            row.consumerWorkId === parentWorkId &&
            row.binding.workspaceId === child.workspaceId &&
            row.state === "Satisfied" &&
            row.satisfiedBy?.startsWith("del_") === true,
        );
        if (
          satisfied !== undefined &&
          childCurrent === null &&
          parentCurrent === null &&
          verified.verdict === "Pass" &&
          verified.verificationId !== undefined &&
          verified.targetWorkRevision !== undefined &&
          verified.acceptance !== undefined &&
          verified.acceptance.actor !== "user:local" &&
          parentVerified.verdict === "Pass" &&
          parentVerified.verificationId !== undefined &&
          parentVerified.targetWorkRevision !== undefined &&
          parentVerified.acceptance !== undefined
        ) {
          publicSnapshot = {
            tree: await readTree(client, project.projectId),
            dependency: satisfied,
            parentVerification: parentVerified,
            childVerification: verified,
            executableApprovals,
            childPermissionGrant,
            handledInbox: [...handledInbox],
            stageEvidence,
          };
          break;
        }
        if (verified.verdict === "Fail" || verified.verdict === "Unknown") {
          expect(childCurrent?.workId).toBe(childWorkId);
          expect(childCurrent?.status).toBe("Open");
          expect(verified.acceptance).toBeUndefined();
          expect(parentCurrent?.workId).toBe(parentWorkId);
          const attention = await client.view<{ rows: Array<unknown> }>(
            "attention",
            {
              projectId: project.projectId,
            },
          );
          publicSnapshot = {
            dependency,
            parentCurrent,
            childCurrent,
            verified,
            attention,
          };
          throw new Error(
            `S3 is explicitly blocked with ${verified.verdict}; no completion or acceptance will be inferred`,
          );
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }

      if (executableApprovals.length === 0) {
        throw new Error(
          "S3 did not exercise the exact child filesystem write approval branch",
        );
      }
      const after = captureWorkspaceSnapshot(fixture.workspaceDirectory);
      expect(after.entries[childFile]?.kind).toBe("file");
      const childFileBase64 = after.entries[childFile]?.bytesBase64;
      expect(childFileBase64).toBeDefined();
      const childFact = Buffer.from(childFileBase64 ?? "", "base64").toString(
        "utf8",
      );
      const childFactLine = childFact.trim();
      expect(
        childFact.split(/\r?\n/u).filter((line) => line.length > 0),
      ).toEqual([childFactLine]);
      expect(childFactLine.startsWith(childEvidencePrefix)).toBe(true);
      expect(childFactLine.slice(childEvidencePrefix.length)).toMatch(
        /^[a-z0-9]{12}$/u,
      );
      expect(after.entries[parentFile]).toMatchObject({ kind: "file" });
      const parentFileBase64 = after.entries[parentFile]?.bytesBase64;
      expect(parentFileBase64).toBeDefined();
      const parentFileContent = Buffer.from(
        parentFileBase64 ?? "",
        "base64",
      ).toString("utf8");
      expect(parentFileContent).toContain(childFactLine);
      artifactEvidence = {
        childFile,
        childSha256: after.entries[childFile]?.sha256,
        childSize: after.entries[childFile]?.size,
        childFactLine,
        parentFile,
        parentSha256: after.entries[parentFile]?.sha256,
        parentContainsExactChildLine: parentFileContent.includes(childFactLine),
      };
      expect(
        Object.entries(baseline.entries).every(
          ([path, entry]) =>
            JSON.stringify(after.entries[path]) === JSON.stringify(entry),
        ),
      ).toBe(true);
      expect(
        Object.keys(after.entries)
          .filter((path) => !Object.hasOwn(baseline.entries, path))
          .sort(),
      ).toEqual([childFile, parentFile].sort());
      const dependency = (publicSnapshot as { dependency?: PublicDependency })
        .dependency;
      expect(dependency?.satisfiedBy).toMatch(/^del_/u);
      expect(dependency?.binding).toMatchObject({
        _tag: "WorkspaceBound",
        workspaceId: child.workspaceId,
      });
      expect(
        parentOf(
          (publicSnapshot as { tree: { nodes: WorkspaceNode[] } }).tree.nodes,
          child.workspaceId,
        )?.workspaceId,
      ).toBe(parent.workspaceId);
      const parentVerification = (
        publicSnapshot as {
          parentVerification: { verdict?: string; acceptance?: unknown };
        }
      ).parentVerification;
      expect(parentVerification.verdict).toBe("Pass");
      expect(parentVerification.acceptance).toBeDefined();

      const captures = await waitForPublic(
        async () => readProviderCaptures(run?.captureFile as string),
        (records) => {
          const completed = responseCompletedIds(records);
          const starts = startedProviderRequests(records);
          return (
            starts.length > 0 &&
            starts.every((item) => completed.has(item.requestId))
          );
        },
        Math.max(1, deadlineAt - Date.now()),
      );
      expect(startedProviderRequests(captures).length).toBeGreaterThan(0);
      expect(
        captures.some(
          (capture) =>
            capture.request?.model === readinessAtLoad.config.wireModelName,
        ),
      ).toBe(true);
      expect(
        captures.some((capture) => capture.event === "request-failed"),
      ).toBe(false);
      expect(
        captures.some((capture) => capture.event === "response-capture-failed"),
      ).toBe(false);
      expect(run.fixture.providerCalls).toHaveLength(0);
      expect(run.fixture.daemonErrors).toEqual([]);
      const capturedCalls = captures.flatMap(capturedToolCalls);
      const actionNames = capturedCalls.map((call) => call.name);
      const deliverableCalls = capturedCalls.filter(
        (call) => call.name === "produce_deliverable",
      );
      expect(
        deliverableCalls.some(
          (call) =>
            typeof call.arguments === "object" &&
            call.arguments !== null &&
            Array.isArray(
              (call.arguments as { artifacts?: unknown }).artifacts,
            ) &&
            (call.arguments as { artifacts: unknown[] }).artifacts.length > 0,
        ),
      ).toBe(true);
      for (const requiredAction of [
        "propose_workspace",
        "produce_deliverable",
        "deliver",
        "accept_result",
        "record_verification_evidence",
        "conclude_verification",
      ]) {
        expect(
          actionNames,
          `real Provider did not invoke ${requiredAction}`,
        ).toContain(requiredAction);
      }
      expect(actionNames).not.toContain("satisfy_dependency");
      expect(actionNames).toContain("patch");
      result = "PASS";
    } catch (error) {
      failure = redactRealProviderDiagnostic(
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
      );
      originalError = error;
    } finally {
      if (run !== undefined) {
        activeRun = undefined;
        const completion = await finishRealProviderFixture(run, result);
        result = completion.status;
        failure = completion.error ?? failure;
        const evidencePath = writeRealProviderEvidence({
          run,
          journeyId: `real-public-s3-${marker.toLowerCase()}`,
          config: readinessAtLoad.config,
          status: result,
          state: {
            projectId: project?.projectId ?? null,
            rootWorkspaceId: project?.rootWorkspaceId ?? null,
            publicSnapshot,
            stageEvidence,
            artifactEvidence,
            childPermissionGrant,
            executableApprovals,
            handledInbox: [...handledInbox],
          },
          ...(failure === undefined ? {} : { error: failure }),
        });
        console.info(`REAL public S3 private evidence: ${evidencePath}`);
      }
    }
    if (result === "FAIL") {
      if (originalError instanceof Error) throw originalError;
      throw new Error(
        `REAL public S3 failed: ${failure ?? "fixture setup or teardown failed"}`,
      );
    }
  },
  TEST_TIMEOUT_MS,
);
