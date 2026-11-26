import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { Effect } from "effect";
import { expect } from "vitest";
import {
  fixedWindowsNativeProductionArtifactPaths,
  inspectWindowsNativeQualificationForRegistryEntryV3,
} from "../../../../adapters/sandbox-windows/dist/index.js";
import { sandboxPolicyCurrentHostV1 } from "../../../../apps/single-workspace/src/current-sandbox-authority-snapshot-port.js";
import { loadSandboxAuthorityBundleSnapshotCurrent } from "../../../../apps/single-workspace/src/sandbox-authority-bundle.js";
import { SANDBOX_ENV_ALLOWLIST } from "../../../../packages/ports/src/index.js";
import { durableSnapshot } from "../../support/ah-durable-snapshot.js";
import { startProductionFixture } from "../../support/production-fixture.js";
import {
  createFunctionalProject,
  functionalId,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../../support/public-client.js";
import {
  installSandboxPolicyV3SyntheticArtifacts,
  sandboxPolicyV3TestPair,
  writeSandboxPolicyV3TestPair,
} from "../../support/sandbox-policy-v3-source.js";
import {
  artifactFixtureCleanups,
  child,
  durableSandboxRead,
  fixtureDiagnostics,
  fixtures,
  insertProductionPrimaryWorktree,
  operatorCommand,
  policyPayload,
  safeInitialShellCommand,
  shellCommandForWorkspacePurpose,
  type V6eScenarioState,
  type WorkspaceDetailForSandbox,
} from "./support.js";

export const v6ePhaseSeedAndFirstDecision = async (
  s: V6eScenarioState,
): Promise<void> => {
  const {
    marker,
    daemonEnvironment,
    probeLines,
    executableProbeLines,
    preparationProbeLines,
    schedulerProbeLines,
    stdoutLines,
    scriptedProviderTrace,
    diagnosticState,
  } = s;
  let shellResponseRelease!: () => void;
  let shellRequestResolve!: (value: Record<string, unknown>) => void;
  const shellResponseGate = new Promise<void>((resolveGate) => {
    shellResponseRelease = resolveGate;
  });
  const shellRequestObserved = new Promise<Record<string, unknown>>(
    (resolveObserved) => {
      shellRequestResolve = resolveObserved;
    },
  );
  const fixture = await startProductionFixture({
    firstDaemonEntry: child,
    admitWorkspaceDirectory: true,
    preserveDirectoryOnStop: true,
    daemonEnvironment,
    reply: (call) => {
      const context = JSON.stringify(call.messages);
      const availableNames = call.tools
        .map((tool) => tool.function?.name)
        .filter((name): name is string => name !== undefined);
      const available = new Set(availableNames);
      const targetWorkTurn = available.has("shell");
      const rootAssignmentPredicate =
        context.includes(marker) &&
        available.has("assign_work") &&
        !targetWorkTurn &&
        !context.includes("WorkAssigned(");
      const priorToolDenial = call.messages.some(
        (message) =>
          message.role === "tool" &&
          typeof message.content === "string" &&
          message.content.startsWith("[Denied] tool denied:"),
      );
      const shellPredicate =
        context.includes(marker) && available.has("shell") && !priorToolDenial;
      const selectedBranch = rootAssignmentPredicate
        ? "root-assign-work"
        : shellPredicate
          ? "workspace-shell"
          : priorToolDenial
            ? "stop-after-exact-tool-denial"
            : "fallback-text";
      scriptedProviderTrace.push({
        requestNo: scriptedProviderTrace.length + 1,
        inferredProfileFromTools: targetWorkTurn
          ? "WorkspaceWork/tool-capable"
          : available.has("assign_work")
            ? "RootConversation/assign-capable"
            : "other",
        availableToolNames: availableNames,
        markerPresent: context.includes(marker),
        workAssignedLiteralPresent: context.includes("WorkAssigned("),
        priorToolDenial,
        rootAssignmentPredicate,
        shellPredicate,
        selectedBranch,
        messages: call.messages,
      });
      if (rootAssignmentPredicate) {
        return {
          _tag: "ToolCall",
          name: "assign_work",
          arguments: {
            objective: `Report the current repository status for ${marker} using the allowlisted read-only shell command.`,
            why: "qualify V6 P4 policy recovery with a real AgentLoop action",
            constraints: [],
            completionExpectation: `Return the current git status for ${marker}`,
            verificationMission: {
              goal: `Verify the read-only sandbox status command for ${marker}`,
              criteria: [
                {
                  criterionId: "sandbox-command",
                  requirement: `The shell call returns the current git status for ${marker}`,
                  required: true,
                },
              ],
              riskRequirements: [],
            },
            reason: "V6 E2 functional qualification",
          },
        };
      }
      if (shellPredicate) {
        s.providerCalls += 1;
        return {
          _tag: "ToolCall",
          name: "shell",
          arguments: {
            command: shellCommandForWorkspacePurpose({
              context,
              safeCommand: safeInitialShellCommand,
            }),
            cwd: { mount: "workspace", path: "." },
            timeoutMs: 5_000,
          },
        };
      }
      return {
        _tag: "Text",
        text: priorToolDenial
          ? `The exact P4 tool action was denied; stop this attempt for ${marker}.`
          : `Waiting for ${marker}`,
      };
    },
    onDaemonStdout: (line) => {
      stdoutLines.push(line);
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (value.tag === "AH_PROBE") probeLines.push(value);
        if (value.tag === "P4_EXECUTABLE_PROBE")
          executableProbeLines.push(value);
        if (value.tag === "P1_SANDBOX_PREPARATION_PROBE")
          preparationProbeLines.push(value);
        if (value.tag === "SCHEDULER_PROBE") schedulerProbeLines.push(value);
      } catch {
        // ProductionFixture also forwards normal readiness output.
      }
    },
    beforeResponse: async (call) => {
      const tools = new Set(
        call.tools
          .map((tool) => tool.function?.name)
          .filter((name): name is string => name !== undefined),
      );
      if (tools.has("shell")) {
        shellRequestResolve(call as unknown as Record<string, unknown>);
        await shellResponseGate;
      }
      return "respond";
    },
    setupProbe: async (event) => {
      if (event.stage !== "after-clone") return;
      const sourceDir = resolve(event.directory, "sandbox-policy-v3-source");
      const sourcePair = sandboxPolicyV3TestPair({
        bundleRevision: 1,
        registryRevision: 1,
      });
      artifactFixtureCleanups.push(
        installSandboxPolicyV3SyntheticArtifacts(sourcePair),
      );
      s.sourceFilename = writeSandboxPolicyV3TestPair(sourceDir, sourcePair);
      const loaded = await Effect.runPromise(
        loadSandboxAuthorityBundleSnapshotCurrent(
          {
            readVerifiedSandboxAuthorityBundle: () =>
              Effect.succeed({
                sourceIdentity: sourcePair.sourceIdentity,
                canonicalJson: sourcePair.bundleCanonicalJson,
              }),
            readSandboxAuthorityHighWater: () =>
              Effect.succeed(sourcePair.highWaterCanonicalJson),
            commitSandboxAuthorityHighWater: () => Effect.succeed(false),
            appendSandboxAuthorityAudit: () => Effect.succeed(true),
          },
          new Date().toISOString(),
          SANDBOX_ENV_ALLOWLIST,
        ),
      );
      if (loaded._tag !== "Available" || loaded.snapshot.bundle.version !== 3)
        throw new Error(
          `synthetic P5 V3 pair rejected: ${JSON.stringify(loaded)}`,
        );
      const currentHost = sandboxPolicyCurrentHostV1();
      const supportedRow = sourcePair.bundle.providerRegistry.entries[0];
      if (currentHost === undefined || supportedRow === undefined)
        throw new Error("synthetic D2 evidence omitted current host or row");
      const inspection = inspectWindowsNativeQualificationForRegistryEntryV3(
        fixedWindowsNativeProductionArtifactPaths(),
        supportedRow,
        loaded.snapshot,
        currentHost,
        new Date().toISOString(),
      );
      if (inspection._tag !== "ManifestVerified")
        throw new Error(`synthetic D2 evidence rejected: ${inspection.reason}`);
      daemonEnvironment.ARBOR_SANDBOX_AUTHORITY_SOURCE_FILE = s.sourceFilename;
    },
  });
  fixtures.push(fixture);
  s.fixture = fixture;
  fixtureDiagnostics.set(fixture, () => ({
    ...diagnosticState,
    scriptedProviderTrace,
    p4IntentProbes: probeLines,
    executableProbes: executableProbeLines,
    p1PreparationProbes: preparationProbeLines,
    schedulerProbes: schedulerProbeLines,
    daemonStdoutTail: stdoutLines.slice(-80),
  }));
  if (s.sourceFilename === undefined)
    throw new Error("schema-50 V3 source fixture setup was incomplete");
  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    "V6 E registry drift",
    { resourceSelection: "Profile" },
  );
  s.client = client;
  s.project = project;
  diagnosticState.phase = "primary-project-created";
  diagnosticState.primaryProjectId = project.projectId;
  diagnosticState.primaryWorkspaceId = project.rootWorkspaceId;
  execFileSync("git", ["init", "--quiet"], {
    cwd: fixture.workspaceDirectory,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Arbor Test"], {
    cwd: fixture.workspaceDirectory,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", "arbor-test@example.invalid"], {
    cwd: fixture.workspaceDirectory,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "proof.txt"], {
    cwd: fixture.workspaceDirectory,
    stdio: "ignore",
  });
  execFileSync("git", ["commit", "--quiet", "-m", "sandbox fixture"], {
    cwd: fixture.workspaceDirectory,
    stdio: "ignore",
  });
  await insertProductionPrimaryWorktree({
    databaseFile: fixture.databaseFile,
    projectId: project.projectId,
    workspaceId: project.rootWorkspaceId,
    path: fixture.workspaceDirectory,
  });
  await client.command(project.projectId, "GrantPermission", {
    permissionGrantId: functionalId("pgr"),
    issuer: "user:local",
    subject: {
      _tag: "WorkspaceAgent",
      workspaceId: project.rootWorkspaceId,
    },
    capability: "shell:exec",
    target: project.rootWorkspaceId,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  await submitHumanMessage(
    client,
    project,
    `请为 ${marker} 创建一个工作并运行一次 sandbox shell 命令。`,
  );
  const approval = await waitForApproval(client, project, marker);
  await client.command(project.projectId, "ResolveControlApproval", {
    approvalId: approval.approvalId,
    expectedRevision: approval.revision,
    decision: "Approve",
    reason: "V6 E2 public Work admission",
  });
  const admittedWork = await waitForPublic(
    () =>
      client.view<{
        readonly workId?: string;
        readonly status: string;
        readonly activeExecution?: { readonly executionId: string };
      } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
    (work) =>
      work?.workId !== undefined &&
      work.activeExecution?.executionId !== undefined,
  ).catch((error: unknown) => {
    throw new Error(
      `V6 E2 Work admission absent: ${String(error)}; provider=${JSON.stringify(fixture.providerCalls)}; daemon=${fixture.daemonErrors.join(" | ")}`,
      { cause: error },
    );
  });
  if (admittedWork === null)
    throw new Error("public Current Work omitted its admitted Work");
  const pregrantedExecutionId = admittedWork.activeExecution?.executionId;
  if (pregrantedExecutionId === undefined)
    throw new Error("public Current Work omitted its active Execution");
  await shellRequestObserved;
  const grantId = functionalId("pgr");
  const grantExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  await client.command(project.projectId, "GrantPermission", {
    permissionGrantId: grantId,
    issuer: "user:local",
    subject: { _tag: "HumanPrincipal", principal: "user:operator" },
    capability: "DecideSandboxPolicy",
    target: pregrantedExecutionId,
    expiresAt: grantExpiresAt,
  });
  shellResponseRelease();
  const firstProbe = await waitForPublic(
    async () =>
      probeLines.find((value) => value.boundary === "AH7AfterToolIntentCommit"),
    (value) => value !== undefined,
    15_000,
  ).catch((error: unknown) => {
    const durable = durableSnapshot(fixture.databaseFile);
    const pendingShellActions = durable.actions.filter(
      (row) => row.action_kind === "shell" && row.state === "Pending",
    );
    const pendingExecutions = new Set(
      pendingShellActions.map((row) => row.execution_id),
    );
    const actionInvocations = durable.toolInvocations.filter((row) =>
      pendingExecutions.has(row.execution_id),
    );
    const providerSummary = fixture.providerCalls.map((call) => ({
      messages: call.messages.map((message) => ({
        role: message.role,
        content: message.content?.slice(0, 800),
      })),
      user: call.messages.find((message) => message.role === "user")?.content,
      tools: call.tools.map((tool) => tool.function?.name),
      priorToolResult: call.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.content),
    }));
    throw new Error(
      `RED: executable action has not reached the P4 intent boundary; pendingShellActions=${JSON.stringify(pendingShellActions)}; matchingToolInvocations=${JSON.stringify(actionInvocations)}; AH7ProbeCount=${probeLines.length}; executableProbe=${JSON.stringify(executableProbeLines)}; s.providerCalls=${s.providerCalls}; modelRequests=${JSON.stringify(providerSummary)}; loop=${JSON.stringify({ steps: durable.steps, actions: durable.actions, invocations: durable.toolInvocations })}; stdout=${stdoutLines.slice(-20).join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}; wait=${String(error)}`,
      { cause: error },
    );
  });
  if (firstProbe === undefined)
    throw new Error("AH7 P4 intent probe was not captured");
  const executionId = String(firstProbe.executionId ?? "");
  if (!executionId.startsWith("exe_"))
    throw new Error(
      `AH7 probe omitted execution identity: ${JSON.stringify(firstProbe)}`,
    );
  expect(executionId).toBe(pregrantedExecutionId);
  const firstInvocationId = String(firstProbe.invocationId ?? "");
  if (!firstInvocationId.startsWith("tin_"))
    throw new Error(
      `first AH7 probe omitted invocation identity: ${JSON.stringify(firstProbe)}`,
    );
  const firstPendingState = durableSandboxRead(
    fixture.databaseFile,
    executionId,
    firstInvocationId,
  );
  expect(firstPendingState.invocation).toMatchObject({
    invocation_id: firstInvocationId,
    effect_admission_state: "NotAdmitted",
    recovery_binding_state: "Bound",
    settled_at: null,
    observation_json: null,
  });
  const initialDetail = await client.view<WorkspaceDetailForSandbox>(
    "workspace-detail",
    { workspaceId: project.rootWorkspaceId },
  );
  const initialRead = initialDetail.sandboxPolicyCandidateRead;
  if (initialRead === undefined)
    throw new Error(
      `P10 candidate read missing after first P4 intent: ${JSON.stringify(initialDetail)}`,
    );
  const oldPayload = policyPayload({
    read: initialRead,
    projectId: project.projectId,
    workspaceId: project.rootWorkspaceId,
    executionId,
    expiresAt: grantExpiresAt,
  });
  const initialPolicyCommandId = functionalId("cmd");
  let firstDecision: Record<string, unknown>;
  try {
    firstDecision = await operatorCommand(
      fixture.baseUrl,
      project.projectId,
      "DecideSandboxPolicy",
      oldPayload,
      initialPolicyCommandId,
    );
  } catch (error) {
    throw new Error(
      `first exact OS P1 decision failed: ${String(error)}; preparation=${JSON.stringify(preparationProbeLines)}; daemon=${fixture.daemonErrors.join(" | ")}; stdout=${stdoutLines.slice(-25).join(" | ")}`,
      { cause: error },
    );
  }
  expect(firstDecision).toMatchObject({
    body: { resolution: "Committed" },
  });
  const policyState = durableSandboxRead(
    fixture.databaseFile,
    executionId,
    firstInvocationId,
  );
  expect(policyState.decisions).toEqual({ count: 1 });
  expect(policyState.decisionEvents).toEqual({ count: 1 });

  Object.assign(s, { executionId, firstInvocationId, initialRead, oldPayload });
};
