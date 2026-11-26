import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { durableSnapshot } from "../../support/ah-durable-snapshot.js";
import {
  createFunctionalProject,
  functionalId,
  submitHumanMessage,
  waitForApproval,
  waitForExecutableApproval,
  waitForPublic,
} from "../../support/public-client.js";
import {
  isP9SandboxUnavailableTerminal,
  type P4OutcomeProbe,
  readP9OutcomeSourceForProbe,
} from "./p9-oracle.js";
import {
  child,
  decodeToolObservation,
  durableSandboxRead,
  freshExecutionDiagnosticSnapshot,
  freshWorkspacePurpose,
  insertProductionPrimaryWorktree,
  p1OwnedDomainSnapshot,
  policyPayload,
  type V6eScenarioState,
  type WorkspaceDetailForSandbox,
} from "./support.js";

export const v6ePhaseFirstOutcome = async (
  s: V6eScenarioState,
): Promise<void> => {
  const { executableProbeLines, schedulerProbeLines, stdoutLines } = s;
  const fixture = s.fixture!;
  const executionId = s.executionId;
  const firstInvocationId = s.firstInvocationId;
  await fixture.crash();
  await fixture.restart({
    entry: child,
    daemonEnvironment: {
      ARBOR_AH_BOUNDARY: "AH7AfterToolIntentCommit",
      ARBOR_TICK_INTERVAL_MS: "25",
      ARBOR_AH_BOUNDARY_SKIP_COUNT: "1",
      ARBOR_SCHEDULER_PROBE: "1",
    },
  });
  const firstSettled = await waitForPublic(
    async () => {
      const p4Outcome = executableProbeLines.find(
        (event) =>
          event.boundary === "P4ExecutableToolRuntimeOutcome" &&
          event.executionId === executionId &&
          event.invocationId === firstInvocationId,
      );
      if (p4Outcome === undefined) return undefined;
      const probe = p4Outcome as unknown as P4OutcomeProbe;
      return {
        probe,
        source: readP9OutcomeSourceForProbe(fixture.databaseFile, probe),
      };
    },
    (value) =>
      value !== undefined &&
      value.source.invocation?.settled_at !== null &&
      value.source.invocation !== undefined &&
      (value.source.action?.state === "Applied" ||
        value.source.action?.state === "TerminalRejected") &&
      ["StepEffectsCommitted", "NextStepReady", "SettlementProposed"].includes(
        value.source.step?.state ?? "",
      ),
    45_000,
  ).catch((error: unknown) => {
    const durable = durableSnapshot(fixture.databaseFile);
    throw new Error(
      `first unavailable action did not settle after live lease expiry; state=${JSON.stringify(durableSandboxRead(fixture.databaseFile, executionId, firstInvocationId))}; scheduler=${JSON.stringify(schedulerProbeLines.slice(-20))}; executable=${JSON.stringify(executableProbeLines.slice(-20))}; actions=${JSON.stringify(durable.actions)}; invocations=${JSON.stringify(durable.toolInvocations)}; stdout=${stdoutLines.slice(-30).join(" | ")}; wait=${String(error)}`,
      { cause: error },
    );
  });
  if (firstSettled === undefined)
    throw new Error("P4 ExpectedFailure source snapshot was unavailable");
  const firstInvocationState = firstSettled.source.invocation;
  const firstActionState = firstSettled.source.action;
  const firstStepState = firstSettled.source.step;
  if (
    firstInvocationState === undefined ||
    firstActionState === undefined ||
    firstStepState === undefined
  )
    throw new Error(
      `P4 outcome probe did not bind to its original Action/Step: ${JSON.stringify(firstSettled)}`,
    );
  expect(firstInvocationState.observation_json).not.toBeNull();
  expect(firstInvocationState.settlement_kind).toBe("ExpectedFailure");
  const firstObservation = decodeToolObservation(
    firstInvocationState.observation_json,
  );
  expect(firstObservation._tag).toBe("ExpectedFailure");
  const p9Terminal = isP9SandboxUnavailableTerminal({
    probe: firstSettled.probe,
    invocation: firstInvocationState,
    action: firstActionState,
    step: firstStepState,
    unavailableFact: firstSettled.source.unavailableFact,
    effectAttempts: firstSettled.source.effectAttempts,
    artifacts: firstSettled.source.artifacts,
  });
  if (firstObservation.sandboxProviderUnavailable !== undefined) {
    expect(p9Terminal).toBe(true);
    expect(firstActionState.state).toBe("TerminalRejected");
    expect(firstStepState.state).toMatch(
      /^(StepEffectsCommitted|NextStepReady|SettlementProposed)$/u,
    );
    expect(firstObservation).toMatchObject({
      _tag: "ExpectedFailure",
      sandboxProviderUnavailable: {
        providerId: "windows-restricted-appcontainer-job",
        providerVersion: "t3d-v1",
        failureCode: "ProviderVersionMismatch",
        effectDisposition: "NoEffect",
      },
    });
  } else {
    expect(p9Terminal).toBe(false);
    expect(firstActionState.state).toBe("Applied");
  }
  Object.assign(s, {
    firstSettled,
    firstActionState,
    firstStepState,
    p9Terminal,
  });
};

export const v6ePhaseFreshRootPreDrift = async (
  s: V6eScenarioState,
): Promise<void> => {
  const { marker, probeLines, scriptedProviderTrace, diagnosticState } = s;
  const fixture = s.fixture!;
  const client = s.client!;
  const project = s.project!;
  const executionId = s.executionId;
  const firstSettled = s.firstSettled!;
  const firstStepState = s.firstStepState!;
  const firstActionState = s.firstActionState;
  expect(firstActionState).toMatchObject({
    state: "TerminalRejected",
    action_index: firstSettled.probe.actionIndex,
    logical_step_no: firstSettled.probe.recoveryBindingIdentity?.logicalStepNo,
  });
  expect(firstStepState.state).toMatch(
    /^(StepEffectsCommitted|NextStepReady|SettlementProposed)$/u,
  );
  const p9Store = new DatabaseSync(fixture.databaseFile, {
    readOnly: true,
  });
  try {
    const unavailableEvidence = p9Store
      .prepare(
        `SELECT f.provider_id, f.provider_version, f.probe_evidence_ref,
                    f.failure_code, q.state AS queue_state
               FROM sandbox_provider_unavailable_facts f
               JOIN sandbox_provider_unavailable_attention_queue q
                 ON q.attention_fact_id = f.attention_fact_id
                AND q.project_id = f.project_id
              WHERE f.execution_id = ? AND f.policy_revision = 1`,
      )
      .get(executionId) as
      | {
          readonly provider_id?: string;
          readonly provider_version?: string;
          readonly probe_evidence_ref?: string | null;
          readonly failure_code?: string;
          readonly queue_state?: string;
        }
      | undefined;
    expect(unavailableEvidence).toMatchObject({
      provider_id: "windows-restricted-appcontainer-job",
      provider_version: "t3d-v1",
      failure_code: "ProviderVersionMismatch",
    });
    expect(unavailableEvidence?.probe_evidence_ref).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
    expect(unavailableEvidence?.queue_state).toMatch(
      /^(Pending|Claimed|Consumed)$/u,
    );
  } finally {
    p9Store.close();
  }
  const committedProbeCount = probeLines.filter(
    (value) => value.boundary === "AH7AfterToolIntentCommit",
  ).length;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  expect(
    probeLines.filter((value) => value.boundary === "AH7AfterToolIntentCommit"),
  ).toHaveLength(committedProbeCount);
  expect(s.providerCalls).toBe(1);
  const providerCallsBeforeFreshRoot = s.providerCalls;
  // Keep the P9 terminal proof intact. Qualify drift through a separate
  // public root Work with its own pre-intent CandidateRead; never mint a
  // second ProviderTurn for this terminal Step.
  const freshProjectRootDirectory = resolve(
    fixture.directory,
    "fresh-project-root",
  );
  mkdirSync(freshProjectRootDirectory, { recursive: true });
  writeFileSync(resolve(freshProjectRootDirectory, "proof.txt"), marker);
  execFileSync("git", ["init", "--quiet"], {
    cwd: freshProjectRootDirectory,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Arbor Test"], {
    cwd: freshProjectRootDirectory,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", "arbor-test@example.invalid"], {
    cwd: freshProjectRootDirectory,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "proof.txt"], {
    cwd: freshProjectRootDirectory,
    stdio: "ignore",
  });
  execFileSync("git", ["commit", "--quiet", "-m", "fresh sandbox fixture"], {
    cwd: freshProjectRootDirectory,
    stdio: "ignore",
  });
  await fixture.restart({
    entry: child,
    projectRootDirectory: freshProjectRootDirectory,
    daemonEnvironment: {
      ARBOR_AH_BOUNDARY: "disabled",
      ARBOR_TICK_INTERVAL_MS: "25",
      ARBOR_SCHEDULER_PROBE: "1",
    },
  });
  const freshProject = await createFunctionalProject(
    client,
    freshProjectRootDirectory,
    freshWorkspacePurpose,
    { resourceSelection: "Profile" },
  );
  diagnosticState.phase = "fresh-project-created";
  diagnosticState.freshProjectId = freshProject.projectId;
  diagnosticState.freshWorkspaceId = freshProject.rootWorkspaceId;
  diagnosticState.freshProjectRootDirectory = freshProjectRootDirectory;
  const freshProfileOwnershipStore = new DatabaseSync(fixture.databaseFile, {
    readOnly: true,
  });
  try {
    const claims = freshProfileOwnershipStore
      .prepare(
        `SELECT resource_space_id, canonical_region,
                      source_address_snapshot, resource_boundary_revision
                 FROM resource_ownership
                WHERE workspace_id = ? AND released_at IS NULL`,
      )
      .all(freshProject.rootWorkspaceId) as unknown as ReadonlyArray<{
      readonly resource_space_id: string;
      readonly canonical_region: string;
      readonly source_address_snapshot: string;
      readonly resource_boundary_revision: number;
    }>;
    expect(claims).toHaveLength(1);
    expect(claims[0]?.resource_space_id).toBe("filesystem");
    expect(JSON.parse(claims[0]?.source_address_snapshot ?? "null")).toEqual({
      _tag: "FileTree",
      path: freshProjectRootDirectory,
    });
    expect(JSON.parse(claims[0]?.canonical_region ?? "null")).toMatchObject({
      resourceSpaceId: "filesystem",
      normalizedRegion: {
        kind: "FileTree",
        path: freshProjectRootDirectory,
      },
    });
  } finally {
    freshProfileOwnershipStore.close();
  }
  await insertProductionPrimaryWorktree({
    databaseFile: fixture.databaseFile,
    projectId: freshProject.projectId,
    workspaceId: freshProject.rootWorkspaceId,
    path: freshProjectRootDirectory,
  });
  await client.command(freshProject.projectId, "GrantPermission", {
    permissionGrantId: functionalId("pgr"),
    issuer: "user:local",
    subject: {
      _tag: "WorkspaceAgent",
      workspaceId: freshProject.rootWorkspaceId,
    },
    capability: "shell:exec",
    target: freshProject.rootWorkspaceId,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  await submitHumanMessage(
    client,
    freshProject,
    `请为 ${marker} 创建一个工作并运行一次 sandbox shell 命令。`,
  );
  diagnosticState.phase = "fresh-human-message-submitted";
  const freshControlApproval = await waitForApproval(
    client,
    freshProject,
    marker,
  );
  await client.command(freshProject.projectId, "ResolveControlApproval", {
    approvalId: freshControlApproval.approvalId,
    expectedRevision: freshControlApproval.revision,
    decision: "Approve",
    reason: "V6 registry drift fresh root Work admission",
  });
  diagnosticState.phase = "fresh-root-control-approval-resolved";
  const freshWork = await waitForPublic(
    () =>
      client.view<{
        readonly workId?: string;
        readonly activeExecution?: { readonly executionId: string };
      } | null>("current-work", {
        workspaceId: freshProject.rootWorkspaceId,
      }),
    (work) =>
      work?.workId !== undefined &&
      work.activeExecution?.executionId !== undefined,
  );
  if (freshWork === null)
    throw new Error("fresh public Current Work was absent");
  const freshExecutionId = freshWork.activeExecution?.executionId;
  if (freshExecutionId === undefined)
    throw new Error("fresh public Work omitted its Execution");
  diagnosticState.phase = "fresh-current-work-active";
  diagnosticState.freshWorkId = freshWork.workId;
  diagnosticState.freshExecutionId = freshExecutionId;
  let freshPreDriftDetail: WorkspaceDetailForSandbox;
  try {
    diagnosticState.phase = "waiting-for-fresh-pre-intent-candidate-read";
    freshPreDriftDetail = await waitForPublic(
      () =>
        client.view<WorkspaceDetailForSandbox>("workspace-detail", {
          workspaceId: freshProject.rootWorkspaceId,
        }),
      (detail) => detail.sandboxPolicyCandidateRead !== undefined,
    );
    diagnosticState.phase = "fresh-pre-intent-candidate-read-observed";
  } catch (error) {
    const [
      inboxResult,
      currentWorkResult,
      transcriptResult,
      candidateDetailResult,
    ] = await Promise.all([
      client
        .view("inbox-view", {
          workspaceId: freshProject.rootWorkspaceId,
        })
        .then((value) => ({ value }))
        .catch((readError: unknown) => ({ error: String(readError) })),
      client
        .view("current-work", {
          workspaceId: freshProject.rootWorkspaceId,
        })
        .then((value) => ({ value }))
        .catch((readError: unknown) => ({ error: String(readError) })),
      client
        .view("transcript", {
          workspaceId: freshProject.rootWorkspaceId,
          limit: 40,
        })
        .then((value) => ({ value }))
        .catch((readError: unknown) => ({ error: String(readError) })),
      client
        .view("workspace-detail", {
          workspaceId: freshProject.rootWorkspaceId,
        })
        .then((value) => ({ value }))
        .catch((readError: unknown) => ({ error: String(readError) })),
    ]);
    const transcriptEntries =
      "value" in transcriptResult &&
      typeof transcriptResult.value === "object" &&
      transcriptResult.value !== null &&
      "entries" in transcriptResult.value &&
      Array.isArray(transcriptResult.value.entries)
        ? (transcriptResult.value.entries as Array<{
            readonly kind?: string;
            readonly messageId?: string;
            readonly body?: string;
            readonly responseStatus?: unknown;
          }>)
        : [];
    const matchingHumanTurn = transcriptEntries.find(
      (entry) =>
        entry.kind === "HumanConversationTurn" && entry.body?.includes(marker),
    );
    let storeSnapshot: unknown;
    try {
      storeSnapshot = freshExecutionDiagnosticSnapshot(
        fixture.databaseFile,
        freshExecutionId,
        matchingHumanTurn?.messageId,
      );
    } catch (snapshotError) {
      storeSnapshot = {
        snapshotError:
          snapshotError instanceof Error
            ? snapshotError.message
            : String(snapshotError),
      };
    }
    const publicFailureSnapshot = {
      inbox: inboxResult,
      currentWork: currentWorkResult,
      transcript: transcriptResult,
      workspaceDetail: candidateDetailResult,
      matchingHumanTurn: matchingHumanTurn ?? null,
      responseStatus: matchingHumanTurn?.responseStatus ?? null,
    };
    const providerRequestToolProfiles = scriptedProviderTrace.map(
      ({
        requestNo,
        inferredProfileFromTools,
        availableToolNames,
        markerPresent,
        workAssignedLiteralPresent,
        rootAssignmentPredicate,
        shellPredicate,
        selectedBranch,
      }) => ({
        requestNo,
        inferredProfileFromTools,
        availableToolNames,
        markerPresent,
        workAssignedLiteralPresent,
        rootAssignmentPredicate,
        shellPredicate,
        selectedBranch,
      }),
    );
    diagnosticState.failureCapture = {
      point: "fresh pre-intent workspace-detail CandidateRead",
      publicFailureSnapshot,
      storeSnapshot,
      providerRequestToolProfiles,
    };
    throw new Error(
      `fresh pre-intent CandidateRead timeout; public=${JSON.stringify(publicFailureSnapshot)}; store=${JSON.stringify(storeSnapshot)}; providerRoutes=${JSON.stringify(providerRequestToolProfiles)}; providerCallCount=${fixture.providerCalls.length}; daemonErrors=${fixture.daemonErrors.join(" | ")}`,
      { cause: error },
    );
  }
  const freshPreDriftRead = freshPreDriftDetail.sandboxPolicyCandidateRead;
  if (freshPreDriftRead === undefined)
    throw new Error("fresh public CandidateRead was absent before drift");
  const freshExecutableApproval = await waitForExecutableApproval(
    client,
    freshProject.rootWorkspaceId,
    marker,
  );
  diagnosticState.freshExecutableApprovalId =
    freshExecutableApproval.approvalId;
  const preDriftCandidate = freshPreDriftRead.candidates.find(
    (candidate) =>
      candidate.kind === "OsEnforced" &&
      candidate.providerId === "windows-restricted-appcontainer-job" &&
      candidate.profile === "ReadOnly" &&
      candidate.networkMode === "Disabled",
  );
  if (preDriftCandidate?.kind !== "OsEnforced")
    throw new Error("fresh pre-drift Supported candidate was absent");
  expect(preDriftCandidate.providerRegistryRevision).toBe(1);
  const freshPreIntentState = freshExecutionDiagnosticSnapshot(
    fixture.databaseFile,
    freshExecutionId,
  );
  expect(freshPreIntentState.execution).toMatchObject({
    execution_id: freshExecutionId,
    episode_kind: "WorkEpisode",
    episode_ref: freshWork.workId,
    episode_revision:
      freshPreDriftRead.commonPreconditions.expectedEpisodeRevision,
    settled_at: null,
    settlement_kind: null,
  });
  expect(freshPreIntentState.invocations).toEqual([]);
  expect(freshPreIntentState.recoveryBindings).toEqual([]);
  expect(freshPreIntentState.actions).toHaveLength(1);
  expect(freshPreIntentState.actions[0]).toMatchObject({
    route_kind: "Executable",
    action_kind: "shell",
    state: "Pending",
    action_index: 0,
  });
  const freshSourceAction = freshPreIntentState.actions[0] as {
    readonly logical_step_no: number;
    readonly repair_attempt: number;
    readonly action_index: number;
  };
  expect(
    freshPreIntentState.steps.find(
      (step) =>
        step.logical_step_no === freshSourceAction.logical_step_no &&
        step.repair_attempt === freshSourceAction.repair_attempt,
    ),
  ).toMatchObject({
    state: "ActionsInProgress",
    next_action_index: freshSourceAction.action_index,
  });
  expect(freshPreIntentState.executableApprovals).toHaveLength(1);
  const freshPreIntentApproval = freshPreIntentState.executableApprovals[0];
  expect(freshPreIntentApproval).toMatchObject({
    approval_id: freshExecutableApproval.approvalId,
    execution_id: freshExecutionId,
    state: "Pending",
    revision: freshExecutableApproval.revision,
    consumed_by: null,
  });
  expect(freshPreIntentApproval?.tool_invocation_id).toMatch(/^tin_/u);
  expect(freshPreIntentState.sandboxDecisions).toEqual([]);
  expect(
    freshPreDriftRead.commonPreconditions.latestCommittedPolicyRevision,
  ).toBe(0);
  expect(
    JSON.parse(String(freshPreIntentState.agentExecutionState?.episode_json)),
  ).toEqual(freshPreDriftRead.commonPreconditions.episodeBinding);
  expect(freshPreIntentState.execution).toMatchObject({
    episode_kind: "WorkEpisode",
    episode_ref: freshPreDriftRead.commonPreconditions.episodeBinding.workId,
    episode_revision:
      freshPreDriftRead.commonPreconditions.episodeBinding.targetWorkRevision,
  });
  const p1GrantExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  await client.command(freshProject.projectId, "GrantPermission", {
    permissionGrantId: functionalId("pgr"),
    issuer: "user:local",
    subject: {
      _tag: "HumanPrincipal",
      principal: "user:operator",
    },
    capability: "DecideSandboxPolicy",
    target: freshExecutionId,
    expiresAt: p1GrantExpiresAt,
  });
  const freshOldPayload = policyPayload({
    read: freshPreDriftRead,
    projectId: freshProject.projectId,
    workspaceId: freshProject.rootWorkspaceId,
    executionId: freshExecutionId,
    expiresAt: p1GrantExpiresAt,
  });
  Object.assign(s, {
    providerCallsBeforeFreshRoot,
    freshProjectRootDirectory,
    freshProject,
    freshExecutionId,
    freshPreDriftRead,
    freshExecutableApproval,
    preDriftCandidate,
    freshPreIntentState,
    freshPreIntentApproval,
    p1GrantExpiresAt,
    freshOldPayload,
  });
};
