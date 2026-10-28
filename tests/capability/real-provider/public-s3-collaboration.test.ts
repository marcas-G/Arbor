import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

interface VerificationModelActionEvidence {
  readonly workId: string;
  readonly verificationId: string;
  readonly executionIds: ReadonlyArray<string>;
  readonly providerTurnIds: ReadonlyArray<string>;
  readonly actions: ReadonlyArray<{
    readonly executionId: string;
    readonly actionKind: string;
    readonly state: string;
  }>;
}

const readVerificationModelActionEvidence = (
  databaseFile: string,
  workIds: ReadonlyArray<string>,
): ReadonlyArray<VerificationModelActionEvidence> => {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return workIds.map((workId) => {
      const verification = database
        .prepare(
          `SELECT verification_id, verification_execution_ids
             FROM verifications
            WHERE work_id = ? AND state = 'Concluded'
            ORDER BY updated_at DESC
            LIMIT 1`,
        )
        .get(workId) as
        | {
            verification_id: string;
            verification_execution_ids: string;
          }
        | undefined;
      if (verification === undefined) {
        throw new Error(
          `S3 missing concluded Verification execution evidence for ${workId}`,
        );
      }
      const decodedExecutionIds: unknown = JSON.parse(
        verification.verification_execution_ids,
      );
      if (
        !Array.isArray(decodedExecutionIds) ||
        decodedExecutionIds.length === 0 ||
        !decodedExecutionIds.every((value) => typeof value === "string")
      ) {
        throw new Error(
          `S3 invalid Verification execution evidence for ${workId}`,
        );
      }
      const executionIds = decodedExecutionIds as string[];
      const placeholders = executionIds.map(() => "?").join(", ");
      const providerTurnIds = database
        .prepare(
          `SELECT DISTINCT provider_turn_id
             FROM agent_loop_steps
            WHERE execution_id IN (${placeholders})
            ORDER BY provider_turn_id`,
        )
        .all(...executionIds)
        .map((row) => (row as { provider_turn_id: string }).provider_turn_id);
      const actions = database
        .prepare(
          `SELECT execution_id, action_kind, state
             FROM agent_loop_step_actions
            WHERE execution_id IN (${placeholders})
              AND action_kind IN ('record_verification_evidence', 'conclude_verification')
            ORDER BY execution_id, logical_step_no, repair_attempt, action_index`,
        )
        .all(...executionIds)
        .map((row) => {
          const action = row as {
            execution_id: string;
            action_kind: string;
            state: string;
          };
          return {
            executionId: action.execution_id,
            actionKind: action.action_kind,
            state: action.state,
          };
        });
      return {
        workId,
        verificationId: verification.verification_id,
        executionIds,
        providerTurnIds,
        actions,
      };
    });
  } finally {
    database.close();
  }
};

interface ExactChildPermissionGrant {
  readonly subjectWorkspaceId: string;
  readonly capability: "fs:write";
  readonly targetWorkspaceId: string;
  readonly expiresAt: string;
}

const capturedToolCalls = (
  capture: ProviderCapture,
): ReadonlyArray<{
  readonly id?: string;
  readonly name: string;
  readonly arguments?: unknown;
}> => {
  if (capture.responseBodyBase64 === undefined) return [];
  const body = Buffer.from(capture.responseBodyBase64, "base64").toString(
    "utf8",
  );
  const fragments = new Map<
    number,
    { id: string; name: string; argumentsText: string }
  >();
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
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      const index = call.index ?? fragments.size;
      const fragment = fragments.get(index) ?? {
        id: "",
        name: "",
        argumentsText: "",
      };
      if (typeof call.id === "string") fragment.id += call.id;
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
      ...(fragment.id.length > 0 ? { id: fragment.id } : {}),
      name: fragment.name,
      ...(fragment.argumentsText.length > 0
        ? { arguments: parsedArguments }
        : {}),
    };
  });
};

const providerToolResultFor = (
  captures: ReadonlyArray<ProviderCapture>,
  toolCallId: string,
): string | undefined => {
  for (const capture of captures) {
    const messages = capture.request?.messages;
    if (!Array.isArray(messages)) continue;
    for (const rawMessage of messages) {
      if (typeof rawMessage !== "object" || rawMessage === null) continue;
      const message = rawMessage as Record<string, unknown>;
      if (message.role === "tool" && message.tool_call_id === toolCallId) {
        return typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content ?? "");
      }
    }
  }
  return undefined;
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

const responseGateIsDrained = (captures: ReadonlyArray<ProviderCapture>) => {
  const released = new Set(
    captures
      .filter((capture) => capture.event === "response-released")
      .map((capture) => capture.requestId),
  );
  return captures
    .filter((capture) => capture.event === "response-held")
    .every((capture) => released.has(capture.requestId));
};

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
  readonly forbiddenFile: string;
  readonly captureFile: string;
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
    const captures = readProviderCaptures(input.captureFile);
    const forbiddenProbePaths = new Set([
      input.forbiddenFile,
      basename(input.forbiddenFile),
    ]);
    const forbiddenProbeCall = captures
      .flatMap(capturedToolCalls)
      .find(
        (call) =>
          call.name === "patch" &&
          typeof call.arguments === "object" &&
          call.arguments !== null &&
          forbiddenProbePaths.has(
            String(
              (call.arguments as { target?: { path?: unknown } }).target?.path,
            ),
          ),
      );
    if (
      forbiddenProbeCall?.id !== undefined &&
      providerToolResultFor(captures, forbiddenProbeCall.id) === undefined
    ) {
      input.stages.push({
        phase: "ForbiddenOwnershipProbeApprovalLeftUnresolved",
        toolCallId: forbiddenProbeCall.id,
        forbiddenFile: input.forbiddenFile,
        approvalId: approval.approvalId,
      });
      continue;
    }
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
    const parentRoot = `s3-${marker.toLowerCase()}`;
    const childRoot = `${parentRoot}/child`;
    const parentFile = `${parentRoot}/parent-result-${marker.toLowerCase()}.txt`;
    const childFile = `${childRoot}/child-evidence-${marker.toLowerCase()}.txt`;
    const forbiddenFile = `${parentRoot}/forbidden-child-probe-${marker.toLowerCase()}.txt`;
    // Executable target.path values are relative to the active Workspace's
    // ResourceBoundary mount. The Child boundary is parentRoot.
    const parentMountFile = basename(parentFile);
    const childMountFile = `child/${basename(childFile)}`;
    const forbiddenMountFile = basename(forbiddenFile);
    const childWorkMarker = `S3_CHILD_WORK_${marker}`;
    const childEvidencePrefix = `S3-CHILD-EVIDENCE:${marker};nonce=`;
    const responseGateSelector = {
      requiredAdvertisedToolName: "patch",
      requiredMessageText: childEvidencePrefix,
    };
    const heldSequenceCursor = { value: 0 };
    const handledInbox = new Set<string>();
    const executableApprovals: Array<ExactExecutableApproval> = [];
    let parentPermissionGranted = false;
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
      mkdirSync(join(fixture.workspaceDirectory, childRoot), {
        recursive: true,
      });
      const baseline = captureWorkspaceSnapshot(fixture.workspaceDirectory);

      const request =
        `目标 ${marker}。立即只提议一个父工作区“${parentName}”，不要先解释或列计划。resourceBoundaryDraft 使用当前 FileTree 下已有子目录 ${parentRoot} 的绝对 FileTree 地址，resourceOwnershipDelegation.addresses 使用同一地址。责任草案只填简短 purpose，其余可选数组留空。` +
        `父 initialWork 只需包含标记 ${childWorkMarker}，目标写“等待后续精确子任务指令；Child 的 Delivery 只表示到达，必须等 Child 独立 Verification PASS 并由 Parent 调用 accept_result 后，才能整合到 ResourceBoundary 内的 ${parentMountFile}”；在精确指令到达前下一次 ActionCall 只能调用 wait(disposition Blocked, Manual)，禁止 list/list_workspaces/read/update_plan。constraints 必须包含不得使用 shell/网络，以及“未成功 accept_result 前禁止 read Child、patch 父结果或 claim_completion”；verification criteria 只写父结果文件存在且非空，路径使用 ResourceBoundary mount-relative 的 ${parentMountFile}。不要在本次 proposal 中展开 Child 细节。`;
      const releasedProviderResponses = new Set<string>();
      await client.command(project.projectId, "SubmitHumanMessage", {
        messageId: functionalId("msg"),
        targetWorkspaceId: project.rootWorkspaceId,
        bodyRef: request,
      });

      let parent: WorkspaceNode | undefined;
      let child: WorkspaceNode | undefined;
      let formationDecisionCount = 0;
      let parentPlacementSteered = false;
      while (
        Date.now() < deadlineAt &&
        (child?.currentWork?.workId === undefined ||
          parent?.currentWork?.workId === undefined)
      ) {
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
        if (parent !== undefined && !parentPermissionGranted) {
          await client.command(project.projectId, "GrantPermission", {
            permissionGrantId: functionalId("pgr"),
            issuer: "user:local",
            subject: {
              _tag: "WorkspaceAgent",
              workspaceId: parent.workspaceId,
            },
            capability: "fs:write",
            target: parent.workspaceId,
            expiresAt: new Date(deadlineAt).toISOString(),
          });
          parentPermissionGranted = true;
        }
        if (
          parent !== undefined &&
          parent.currentWork?.workId !== undefined &&
          !parentPlacementSteered
        ) {
          const parentCurrent = await client.view<{
            workId?: string;
            revision: number;
          } | null>("current-work", { workspaceId: parent.workspaceId });
          if (parentCurrent?.workId === parent.currentWork.workId) {
            await client.command(project.projectId, "SteerWork", {
              workId: parentCurrent.workId,
              workspaceId: parent.workspaceId,
              expectedWorkRevision: parentCurrent.revision,
              steer: {
                severity: "Normal",
                operation: {
                  kind: "DirectionGuidance",
                  guidance: `立即执行，不要调用 update_plan、list、list_workspaces、read、wait、declare_dependency 或 send_message；下一次且本次唯一的 ActionCall 必须是提议直接子工作区“${childName}”。resourceBoundaryDraft 使用已存在目录 ${parentRoot} 的绝对 FileTree 地址；resourceOwnershipDelegation.addresses 只使用其子目录 ${childRoot}。Child initialWork 只写“等待后续精确执行指令”，并要求指令到达前下一次 ActionCall 只能 wait(disposition Blocked, Manual)，禁止 list/read/update_plan；保留最终 Verifier criteria：相对于 Child ResourceBoundary mount 的 ${childMountFile} 存在且唯一一行匹配 ${childEvidencePrefix}<12位小写字母或数字>。之后所有 Child patch/read target.path 都必须相对于该 mount，不能再加 ${parentRoot} 前缀。提议成功后立即结束本次 turn；不要在 Child canonical WorkspaceId 出现前声明任何 Dependency，尤其禁止 AnyProducer。不得使用 shell/网络。`,
                },
              },
              provenance: { source: "HumanInput" },
            });
            parentPlacementSteered = true;
          }
        }
        child = tree.nodes.find(
          (node) =>
            node.name.includes(childName) &&
            node.parentWorkspaceId === parent?.workspaceId,
        );
        if (
          child?.currentWork?.workId === undefined ||
          parent?.currentWork?.workId === undefined
        ) {
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
      const parentBeforeDependency = await client.view<{
        workId?: string;
        revision: number;
      } | null>("current-work", { workspaceId: parent.workspaceId });
      if (parentBeforeDependency?.workId !== parentWorkId) {
        throw new Error("S3 Parent Work disappeared before dependency steer");
      }
      await client.command(project.projectId, "SteerWork", {
        workId: parentWorkId,
        workspaceId: parent.workspaceId,
        expectedWorkRevision: parentBeforeDependency.revision,
        steer: {
          severity: "Normal",
          operation: {
            kind: "DirectionGuidance",
            guidance: `现在 Child canonical identity 已确定。立即 declare_dependency，producerBinding 必须精确为 {"_tag":"WorkspaceBound","workspaceId":"${child.workspaceId}"}，expected deliverable 为 kind s3-child-evidence、requiredArtifactRoles ["evidence"]，禁止 AnyProducer；随后 wait DependencyChanged。Delivery 到达但 readyResults 尚未出现时，必须 wait VerificationChanged，workId="${childWorkId}"、targetWorkRevision=0；Child Verification PASS 后调用 list_workspaces 取得唯一 readyResults 并 accept_result。只有 accept_result 成功后，才可 read Child mount-relative ${childMountFile}，patch Parent mount-relative ${parentMountFile} 写入完整内容，read 回读并 claim_completion。不要 update_plan、send_message 或创建额外 Work。`,
          },
        },
        provenance: { source: "HumanInput" },
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
            row.binding.workspaceId === child.workspaceId,
        );
        waitingParent = await client.view<{
          workId?: string;
          activeExecution?: { executionId: string };
        } | null>("current-work", { workspaceId: parent.workspaceId });
        if (dependencyBeforeDelivery !== undefined) {
          break;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      expect(dependencyBeforeDelivery).toBeDefined();
      const requestsAtDependencyWait = startedProviderRequests(
        readProviderCaptures(run.captureFile),
      ).length;
      const preDeliveryActions = readProviderCaptures(run.captureFile)
        .filter(
          (capture) =>
            capture.event === "response-held" ||
            capture.event === "response-complete" ||
            capture.event === "response-released",
        )
        .flatMap(capturedToolCalls)
        .map((call) => call.name);
      expect(preDeliveryActions).toContain("declare_dependency");
      expect(dependencyBeforeDelivery?.state).toBe("Unsatisfied");
      expect(preDeliveryActions).toContain("wait");
      expect(waitingParent?.activeExecution?.executionId).toBeDefined();
      const artifactExistsAtDependencyWait =
        captureWorkspaceSnapshot(fixture.workspaceDirectory).entries[childFile]
          ?.kind === "file";
      expect(artifactExistsAtDependencyWait).toBe(false);
      const stableWindowStartedAt = Date.now();
      const stableWindowMs = 750;
      const stabilitySamples: Array<Record<string, unknown>> = [];
      while (Date.now() - stableWindowStartedAt < stableWindowMs) {
        const dependencyView = await client.view<{
          rows: Array<PublicDependency>;
        }>("dependency-view", { projectId: project.projectId });
        const currentWork = await client.view<{
          workId?: string;
          objective: string;
          status?: string;
          revision: number;
          activeExecution?: { executionId: string };
        } | null>("current-work", { workspaceId: parent.workspaceId });
        const dependency = dependencyView.rows.find(
          (row) =>
            row.consumerWorkId === parentWorkId &&
            row.binding.workspaceId === child.workspaceId,
        );
        const artifactExists =
          captureWorkspaceSnapshot(fixture.workspaceDirectory).entries[
            childFile
          ]?.kind === "file";
        const providerRequestCount = startedProviderRequests(
          readProviderCaptures(run.captureFile),
        ).length;
        expect(dependency?.state).toBe("Unsatisfied");
        expect(artifactExists).toBe(false);
        expect(providerRequestCount).toBe(requestsAtDependencyWait);
        expect(currentWork).toMatchObject({
          workId: parentWorkId,
          status: "Open",
        });
        // Wait keeps the same active Execution durably suspended on the
        // unsatisfied dependency; it must not spin a successor Provider turn.
        expect(currentWork?.activeExecution?.executionId).toBe(
          waitingParent?.activeExecution?.executionId,
        );
        stabilitySamples.push({
          observedAtElapsedMs: Date.now() - stableWindowStartedAt,
          dependency,
          childArtifactExists: artifactExists,
          providerRequestCount,
          parentCurrentWork: currentWork,
        });
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, Math.min(100, stableWindowMs)),
        );
      }
      stageEvidence.push({
        phase: "ParentDependencyWaitBeforeChildDelivery",
        dependency: dependencyBeforeDelivery,
        parentCurrent: waitingParent,
        providerRequestsAtWait: requestsAtDependencyWait,
        artifactExistsAtWait: artifactExistsAtDependencyWait,
        formalDeliverySatisfiedAtObservation:
          dependencyBeforeDelivery?.state === "Satisfied",
        stableWindowMs: Date.now() - stableWindowStartedAt,
        stabilitySamples,
      });
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
      const childBeforeExecution = await client.view<{
        workId?: string;
        revision: number;
      } | null>("current-work", { workspaceId: child.workspaceId });
      if (childBeforeExecution?.workId !== childWorkId) {
        throw new Error("S3 Child Work disappeared before execution steer");
      }
      await client.command(project.projectId, "SteerWork", {
        workId: childWorkId,
        workspaceId: child.workspaceId,
        expectedWorkRevision: childBeforeExecution.revision,
        steer: {
          severity: "Normal",
          operation: {
            kind: "DirectionGuidance",
            guidance: `现在立即执行精确 Child 任务，不要调用 update_plan、list、list_workspaces、wait 或 send_message。所有 patch/read target.path 都相对于 Child ResourceBoundary mount。下一次 ActionCall 必须先尝试且仅尝试一次 patch 新文件 ${forbiddenMountFile}（该 mount-relative 路径位于 Child ResourceBoundary 内、但属于 Parent 的未委派 remainder），不得申请或等待该 forbidden probe 的审批；记录确切拒绝后继续。随后 patch 创建 ${childMountFile}，唯一一行内容为 ${childEvidencePrefix} 后接12位小写字母或数字；read 回读后立即 produce_deliverable kind s3-child-evidence、artifact role evidence 并 deliver，再 claim_completion 触发独立验证。不得把 ${parentRoot} 前缀附加到 mount-relative target.path，不得使用 shell/网络，不得用 send_message 代替交付。`,
          },
        },
        provenance: { source: "HumanInput" },
      });
      const parentAfterDependency = await client.view<{
        workId?: string;
        revision: number;
      } | null>("current-work", { workspaceId: parent.workspaceId });
      if (parentAfterDependency?.workId !== parentWorkId) {
        throw new Error(
          "S3 Parent Work disappeared before exact dependency continuation steer",
        );
      }
      await client.command(project.projectId, "SteerWork", {
        workId: parentWorkId,
        workspaceId: parent.workspaceId,
        expectedWorkRevision: parentAfterDependency.revision,
        steer: {
          severity: "Normal",
          operation: {
            kind: "DirectionGuidance",
            guidance: `依赖 ${dependencyBeforeDelivery?.dependencyId} 已经精确声明，禁止再次调用 declare_dependency。只等待该既有 DependencyChanged；Delivery 到达后，若 readyResults 尚未出现，只调用 wait VerificationChanged，workId="${childWorkId}"、targetWorkRevision=${childBeforeExecution.revision + 1}。Child Verification PASS 后调用 list_workspaces 取得唯一 readyResults 并 accept_result；accept_result 成功后结束本次 turn。禁止 update_plan、send_message、创建额外 Work、read Child、patch Parent 或 claim_completion。`,
          },
        },
        provenance: { source: "HumanInput" },
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
      let parentResultSteered = false;
      let parentIntegrationSteered = false;
      let daemonRestarts = 0;
      while (Date.now() < deadlineAt) {
        try {
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
            forbiddenFile,
            captureFile: run.captureFile,
            marker,
            handled: approvedChildWrites,
            receipts: executableApprovals,
            stages: stageEvidence,
            deadlineAt,
          });
          const dependency = await client.view<{
            rows: Array<PublicDependency>;
          }>("dependency-view", { projectId: project.projectId });
          const parentCurrent = await client.view<{
            workId?: string;
            revision: number;
            status?: string;
          } | null>("current-work", { workspaceId: parent.workspaceId });
          const childCurrent = await client.view<{
            workId?: string;
            revision: number;
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
            parentVerified.targetWorkRevision !== undefined &&
            parentCurrent?.workId === parentWorkId &&
            parentCurrent.revision === parentVerified.targetWorkRevision
          ) {
            try {
              await client.command(project.projectId, "AcceptWorkOutcome", {
                acceptanceId: functionalId("acc"),
                workId: parentWorkId,
                targetWorkRevision: parentVerified.targetWorkRevision,
                verificationId: parentVerified.verificationId,
              });
              parentAccepted = true;
            } catch (error) {
              if (
                !(error instanceof Error) ||
                !error.message.includes("VerificationAcceptanceMismatch")
              ) {
                throw error;
              }
            }
          }
          const satisfied = dependency.rows.find(
            (row) =>
              row.consumerWorkId === parentWorkId &&
              row.binding.workspaceId === child.workspaceId &&
              row.state === "Satisfied" &&
              row.satisfiedBy?.startsWith("del_") === true,
          );
          if (
            !parentResultSteered &&
            satisfied !== undefined &&
            parentCurrent?.workId === parentWorkId &&
            verified.verdict === "Pass" &&
            verified.acceptance === undefined
          ) {
            await client.command(project.projectId, "SteerWork", {
              workId: parentWorkId,
              workspaceId: parent.workspaceId,
              expectedWorkRevision: parentCurrent.revision,
              steer: {
                severity: "Normal",
                operation: {
                  kind: "DirectionGuidance",
                  guidance: `Dependency 已由真实 Delivery ${satisfied.satisfiedBy} 满足。禁止 update_plan、wait、send_message；调用 list_workspaces 获取唯一 readyResults ref，随后立即 accept_result，并在 accept_result 成功后结束本次 turn。不要在同一 response 中追加 read、patch 或 claim_completion。`,
                },
              },
              provenance: { source: "HumanInput" },
            });
            parentResultSteered = true;
          }
          if (
            !parentIntegrationSteered &&
            satisfied !== undefined &&
            parentCurrent?.workId === parentWorkId &&
            verified.verdict === "Pass" &&
            verified.acceptance?.actor === "runtime:system"
          ) {
            await client.command(project.projectId, "SteerWork", {
              workId: parentWorkId,
              workspaceId: parent.workspaceId,
              expectedWorkRevision: parentCurrent.revision,
              steer: {
                severity: "Normal",
                operation: {
                  kind: "DirectionGuidance",
                  guidance: `Child result 已由 accept_result 接受。现在只执行结果整合：read Child mount-relative ${childMountFile}，用 patch 把完整内容逐字写入 Parent ResourceBoundary mount-relative ${parentMountFile}，read 回读确认后 claim_completion。禁止再次调用 accept_result、deliver、update_plan、wait 或 send_message。`,
                },
              },
              provenance: { source: "HumanInput" },
            });
            parentIntegrationSteered = true;
          }
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
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (
            daemonRestarts < 3 &&
            (detail.includes("fetch failed") ||
              detail.includes("ECONNRESET") ||
              detail.includes("ECONNREFUSED"))
          ) {
            const stoppedDaemon = fixture.daemonProcessSnapshot();
            await fixture.restart();
            client = makeDeadlinePublicClient(fixture, deadlineAt);
            daemonRestarts += 1;
            await new Promise((resolveWait) => setTimeout(resolveWait, 500));
            stageEvidence.push({
              phase: "DaemonRestartDuringParentVerification",
              reason: detail,
              stoppedDaemon,
              restartedDaemon: fixture.daemonProcessSnapshot(),
              daemonErrors: fixture.daemonErrors.slice(-8),
            });
            continue;
          }
          throw error;
        }
      }

      const after = captureWorkspaceSnapshot(fixture.workspaceDirectory);
      expect(after.entries[childFile]?.kind).toBe("file");
      expect(after.entries[forbiddenFile]).toBeUndefined();
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
      if (client === undefined) {
        throw new Error(
          "S3 public client is unavailable at final verification",
        );
      }
      const finalClient = client;
      const [canonicalChildVerification, canonicalParentVerification] =
        await Promise.all(
          [childWorkId, parentWorkId].map((workId) =>
            finalClient.view<{
              verdict?: string;
              criteriaResults?: Array<{
                criterionId: string;
                verdict: string;
                evidenceRefs?: string[];
              }>;
              evidenceRefs?: string[];
              acceptance?: { actor: string; acceptanceId: string };
            }>("verification", { workId }),
          ),
        );
      if (
        canonicalChildVerification === undefined ||
        canonicalParentVerification === undefined
      ) {
        throw new Error("S3 final canonical Verification views are missing");
      }
      for (const verification of [
        canonicalChildVerification,
        canonicalParentVerification,
      ]) {
        expect(verification.verdict).toBe("Pass");
        expect(verification.criteriaResults?.length).toBeGreaterThan(0);
        expect(
          verification.criteriaResults?.every(
            (criterion) => criterion.verdict === "Pass",
          ),
        ).toBe(true);
        expect(verification.evidenceRefs?.length).toBeGreaterThan(0);
      }
      const verificationModelActions = readVerificationModelActionEvidence(
        run.fixture.databaseFile,
        [childWorkId, parentWorkId],
      );
      for (const evidence of verificationModelActions) {
        expect(evidence.providerTurnIds.length).toBeGreaterThan(0);
        expect(
          evidence.actions
            .filter((action) => action.state === "Applied")
            .map((action) => action.actionKind),
          `Verification ${evidence.verificationId} did not durably apply both model-authored verification controls`,
        ).toEqual(
          expect.arrayContaining([
            "record_verification_evidence",
            "conclude_verification",
          ]),
        );
      }
      stageEvidence.push({
        phase: "IndependentVerifierModelActionsApplied",
        verificationModelActions,
      });

      const captures = await waitForPublic(
        async () => readProviderCaptures(run?.captureFile as string),
        (records) => {
          const completed = responseCompletedIds(records);
          const starts = startedProviderRequests(records);
          return (
            starts.length > 0 &&
            starts.every((item) => completed.has(item.requestId)) &&
            responseGateIsDrained(records)
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
      expect(responseGateIsDrained(captures)).toBe(true);
      expect(run.fixture.providerCalls).toHaveLength(0);
      expect(run.fixture.daemonErrors).toEqual([]);
      const capturedCalls = captures.flatMap(capturedToolCalls);
      const actionNames = capturedCalls.map((call) => call.name);
      const forbiddenProbePaths = new Set([
        forbiddenFile,
        basename(forbiddenFile),
      ]);
      const forbiddenProbeCalls = capturedCalls.filter(
        (call) =>
          call.name === "patch" &&
          typeof call.arguments === "object" &&
          call.arguments !== null &&
          forbiddenProbePaths.has(
            String(
              (call.arguments as { target?: { path?: unknown } }).target?.path,
            ),
          ),
      );
      expect(forbiddenProbeCalls).toHaveLength(1);
      const forbiddenProbeCall = forbiddenProbeCalls[0];
      expect(forbiddenProbeCall?.id).toBeDefined();
      expect(
        (
          forbiddenProbeCall?.arguments as
            | { target?: { path?: unknown } }
            | undefined
        )?.target?.path,
      ).toBe(forbiddenMountFile);
      const forbiddenProbeResult =
        forbiddenProbeCall?.id === undefined
          ? undefined
          : providerToolResultFor(captures, forbiddenProbeCall.id);
      expect(forbiddenProbeResult).toBeDefined();
      expect(forbiddenProbeResult).toMatch(
        /ResourceAdmissionDenied|tool resource admission denied|region not owned|region outside ResourceBoundary/iu,
      );
      stageEvidence.push({
        phase: "ChildForbiddenOwnershipProbeDenied",
        forbiddenFile,
        toolCallId: forbiddenProbeCall?.id,
        toolResult: forbiddenProbeResult,
        forbiddenArtifactExists: after.entries[forbiddenFile] !== undefined,
      });
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
      expect(
        capturedCalls.some(
          (call) =>
            call.name === "patch" &&
            typeof call.arguments === "object" &&
            call.arguments !== null &&
            (call.arguments as { target?: { path?: unknown } }).target?.path ===
              childMountFile,
        ),
        "Child evidence write must use a Child ResourceBoundary mount-relative path",
      ).toBe(true);
      for (const requiredAction of [
        "propose_workspace",
        "produce_deliverable",
        "deliver",
      ]) {
        expect(
          actionNames,
          `real Provider did not invoke ${requiredAction}`,
        ).toContain(requiredAction);
      }
      const canonicalChildAcceptance = canonicalChildVerification.acceptance;
      expect(canonicalChildAcceptance).toMatchObject({
        actor: "runtime:system",
      });
      stageEvidence.push({
        phase: "ParentAcceptedCanonicalChildResult",
        acceptance: canonicalChildAcceptance,
        note: "terminal control calls are not guaranteed to reappear in a successor Provider request capture; canonical public Verification plus durable verifier ProviderTurn/action evidence and Acceptance are the oracle",
      });
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
