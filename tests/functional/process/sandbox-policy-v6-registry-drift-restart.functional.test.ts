import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClockLive,
  layer as sqliteLayer,
  TransactionPortLive,
  WorkspaceRepositoryLive,
  WorktreeStoreLive,
} from "../../../adapters/persistence-sqlite/src/index.js";
import {
  fixedWindowsNativeProductionArtifactPaths,
  inspectWindowsNativeQualificationForRegistryEntryV3,
} from "../../../adapters/sandbox-windows/dist/index.js";
import { sandboxPolicyCurrentHostV1 } from "../../../apps/single-workspace/src/current-sandbox-authority-snapshot-port.js";
import { loadSandboxAuthorityBundleSnapshotCurrent } from "../../../apps/single-workspace/src/sandbox-authority-bundle.js";
import {
  type EffectivePolicySummaryV1,
  encodeEffectivePolicySummaryV1,
} from "../../../packages/domain/src/index.js";
import {
  SANDBOX_ENV_ALLOWLIST,
  sha256Hex,
  TransactionPort,
  WorkspaceRepository,
  WorktreeStore,
} from "../../../packages/ports/src/index.js";
import { durableSnapshot } from "../support/ah-durable-snapshot.js";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  functionalId,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForExecutableApproval,
  waitForPublic,
} from "../support/public-client.js";
import {
  commitSandboxPolicyV3HighWater,
  installSandboxPolicyV3SyntheticArtifacts,
  sandboxPolicyV3TestPair,
  writeSandboxPolicyV3SourceFirst,
  writeSandboxPolicyV3TestPair,
} from "../support/sandbox-policy-v3-source.js";

interface SandboxCandidate {
  readonly kind: string;
  readonly candidateId: string;
  readonly sandboxHandleBindingDigest: string;
  readonly providerId?: string;
  readonly providerVersion?: string;
  readonly capabilityRevision?: number;
  readonly profile?: string;
  readonly networkMode?: string;
  readonly providerRegistryRevision?: number;
  readonly providerRegistryDigest?: string;
}

interface CandidateRead {
  readonly commonPreconditions: {
    readonly episodeBinding: Record<string, unknown>;
    readonly expectedEpisodeRevision: number;
    readonly latestCommittedPolicyRevision: number;
    readonly workspaceRevision: number;
    readonly resourceBoundaryRevision: number;
    readonly authorityBundleRevision: number;
    readonly authorityBundleDigest: string;
    readonly operatorConfigRevision: number;
    readonly operatorConfigDigest: string;
  };
  readonly candidates: ReadonlyArray<SandboxCandidate>;
}

interface WorkspaceDetailForSandbox {
  readonly sandboxPolicyCandidateRead?: CandidateRead;
  readonly sandboxPolicy?: {
    readonly kind?: string;
    readonly status?: string;
    readonly profile?: string;
    readonly providerId?: string;
    readonly providerVersion?: string;
    readonly networkMode?: string;
    readonly policyRevision?: number;
  };
}

const child = resolve(
  "tests/functional/support/sandbox-policy-v2-daemon-child.mjs",
);
const fixtures: ProductionFixture[] = [];
const artifactFixtureCleanups: Array<() => void> = [];

const decodeToolObservation = (value: unknown): Record<string, unknown> => {
  if (typeof value === "string")
    return JSON.parse(value) as Record<string, unknown>;
  if (value instanceof Uint8Array)
    return JSON.parse(new TextDecoder().decode(value)) as Record<
      string,
      unknown
    >;
  throw new Error("durable tool observation is not encoded bytes or text");
};

const durableSandboxRead = (
  databaseFile: string,
  executionId: string,
  invocationId?: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN");
    const data = {
      lease: db
        .prepare(
          "SELECT execution_id, generation FROM execution_leases WHERE execution_id = ?",
        )
        .get(executionId),
      actions: db
        .prepare(
          `SELECT logical_action_id, state, action_index, logical_step_no,
                  repair_attempt, disposition_json, result_ref, settlement_ref,
                  observation_source_ref, revision
             FROM agent_loop_step_actions WHERE execution_id = ? ORDER BY action_index`,
        )
        .all(executionId),
      step: db
        .prepare(
          `SELECT state, next_action_index, revision FROM agent_loop_steps
            WHERE execution_id = ? ORDER BY logical_step_no DESC LIMIT 1`,
        )
        .get(executionId),
      invocation: db
        .prepare(
          `SELECT invocation_id, effect_admission_state, recovery_binding_state,
                  recovery_binding_sha256, settled_at, settlement_kind,
                  observation_json
             FROM tool_invocations
            WHERE execution_id = ? AND (? IS NULL OR invocation_id = ?)
            ORDER BY intent_at DESC LIMIT 1`,
        )
        .get(executionId, invocationId ?? null, invocationId ?? null),
      decisions: db
        .prepare(
          `SELECT COUNT(*) AS count FROM sandbox_policy_decisions
            WHERE execution_id = ?`,
        )
        .get(executionId),
      decisionEvents: db
        .prepare(
          `SELECT COUNT(*) AS count FROM domain_events
            WHERE event_type = 'SandboxPolicyDecisionRecorded'
              AND aggregate_ref = ?`,
        )
        .get(executionId),
    };
    db.exec("COMMIT");
    return data;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
};

const p1OwnedDomainSnapshot = (
  databaseFile: string,
  executionId: string,
  executableApprovalId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN");
    const snapshot = {
      decisions: db
        .prepare(
          `SELECT project_id, workspace_id, execution_id, episode_binding_json,
                  policy_revision, expected_execution_revision,
                  expected_policy_revision, profile_id, provider_id,
                  network_policy_json, policy_digest, permission_grant_id,
                  grant_permission_command_id, operator_config_revision,
                  operator_config_digest, decision_command_id
             FROM sandbox_policy_decisions WHERE execution_id = ?
            ORDER BY policy_revision`,
        )
        .all(executionId),
      decisionEvents: db
        .prepare(
          `SELECT event_id, project_id, sequence, event_type, event_version,
                  occurred_at, aggregate_ref, caused_by_command_id,
                  payload_json
             FROM domain_events
            WHERE event_type = 'SandboxPolicyDecisionRecorded'
              AND aggregate_ref = ?
            ORDER BY sequence`,
        )
        .all(executionId),
      invocations: db
        .prepare(
          `SELECT invocation_id, tool_name, effect_admission_state,
                  recovery_binding_state, recovery_binding_sha256, settled_at,
                  settlement_kind, observation_json
             FROM tool_invocations WHERE execution_id = ?
            ORDER BY invocation_id`,
        )
        .all(executionId),
      approval: db
        .prepare(
          `SELECT approval_id, route_kind, execution_id, state, revision,
                  consumed_by
             FROM action_approvals
            WHERE approval_id = ? AND route_kind = 'Executable'`,
        )
        .get(executableApprovalId),
      actions: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, action_index,
                  logical_action_id, call_ref, state, result_ref,
                  settlement_ref, disposition_json, observation_source_ref,
                  revision
             FROM agent_loop_step_actions WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt, action_index`,
        )
        .all(executionId),
      steps: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, provider_turn_id, state,
                  revision, next_action_index, settlement_json
             FROM agent_loop_steps WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt`,
        )
        .all(executionId),
    };
    db.exec("COMMIT");
    return snapshot;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
};

const sandboxDecisionDebug = (databaseFile: string, executionId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT d.policy_revision, d.policy_digest, d.profile_id, d.provider_id,
                d.expires_at, d.episode_binding_json, c.result_json
           FROM sandbox_policy_decisions d
           JOIN commands c ON c.command_id = d.decision_command_id
          WHERE d.execution_id = ? ORDER BY d.policy_revision DESC LIMIT 1`,
      )
      .get(executionId);
  } finally {
    db.close();
  }
};

const insertProductionPrimaryWorktree = (input: {
  readonly databaseFile: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly path: string;
}) => {
  const infra = Layer.mergeAll(
    sqliteLayer({ filename: input.databaseFile }),
    ClockLive,
  );
  const app = Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(WorktreeStoreLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
  );
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const worktrees = yield* WorktreeStore;
        const workspaces = yield* WorkspaceRepository;
        const workspaceOption = yield* tx.transact(
          workspaces.findById(input.workspaceId as never),
        );
        if (workspaceOption._tag === "None")
          throw new Error("primary GitWorktree fixture Workspace is absent");
        const workspace = workspaceOption.value;
        const nextWorkspaceRevision = workspace.revision + 1;
        const nextBoundaryRevision = workspace.resourceBoundaryRevision + 1;
        const boundary = {
          basisResponsibilityRevision: workspace.responsibilityRevision,
          addresses: [{ _tag: "GitWorktree" as const, path: input.path }],
        };
        yield* tx.transact(
          Effect.gen(function* () {
            yield* workspaces.updateResourceBoundaryIfRevision(
              input.workspaceId as never,
              workspace.revision,
              boundary,
              nextBoundaryRevision as never,
              nextWorkspaceRevision as never,
            );
            yield* worktrees.insert({
              worktreeId: functionalId("wt") as never,
              projectId: input.projectId as never,
              workspaceId: input.workspaceId as never,
              address: { _tag: "GitWorktree", path: input.path },
              state: "Active",
              createdAt: new Date().toISOString(),
            });
          }),
        );
      }),
      app,
    ),
  );
};

const policyPayload = (input: {
  readonly read: CandidateRead;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly executionId: string;
  readonly expiresAt: string;
}) => {
  const osCandidate = input.read.candidates.find(
    (candidate) =>
      candidate.kind === "OsEnforced" &&
      candidate.providerId === "windows-restricted-appcontainer-job" &&
      candidate.profile === "ReadOnly" &&
      candidate.networkMode === "Disabled",
  );
  if (
    osCandidate === undefined ||
    osCandidate.providerVersion === undefined ||
    osCandidate.capabilityRevision === undefined ||
    osCandidate.providerRegistryRevision === undefined ||
    osCandidate.providerRegistryDigest === undefined
  )
    throw new Error("exact Supported Windows candidate missing");
  return {
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    executionId: input.executionId,
    episodeBinding: input.read.commonPreconditions.episodeBinding,
    expectedEpisodeRevision:
      input.read.commonPreconditions.expectedEpisodeRevision,
    expectedPolicyRevision:
      input.read.commonPreconditions.latestCommittedPolicyRevision,
    expectedWorkspaceRevision: input.read.commonPreconditions.workspaceRevision,
    expectedResourceBoundaryRevision:
      input.read.commonPreconditions.resourceBoundaryRevision,
    expectedSandboxHandleBindingDigest: osCandidate.sandboxHandleBindingDigest,
    expectedAuthorityBundleRevision:
      input.read.commonPreconditions.authorityBundleRevision,
    expectedAuthorityBundleDigest:
      input.read.commonPreconditions.authorityBundleDigest,
    expectedOperatorConfigRevision:
      input.read.commonPreconditions.operatorConfigRevision,
    expectedOperatorConfigDigest:
      input.read.commonPreconditions.operatorConfigDigest,
    expectedProviderRegistryRevision: osCandidate.providerRegistryRevision,
    expectedProviderRegistryDigest: osCandidate.providerRegistryDigest,
    profile: osCandidate.profile,
    providerId: osCandidate.providerId,
    providerVersion: osCandidate.providerVersion,
    capabilityRevision: osCandidate.capabilityRevision,
    networkPolicy: {
      kind: "OsEnforced",
      policy: { version: 1, mode: "Disabled", destinations: [] },
    },
    decisionExpiresAt: input.expiresAt,
  };
};

const operatorCommand = async (
  baseUrl: string,
  projectId: string,
  commandType: string,
  payload: unknown,
  commandId = functionalId("cmd"),
) => {
  const response = await fetch(`${baseUrl}/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer operator",
    },
    body: JSON.stringify({
      commandType,
      commandId,
      projectId,
      actor: "user:operator",
      issuedAt: new Date().toISOString(),
      payload,
    }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      `${commandType} operator command failed: ${JSON.stringify(body)}`,
    );
  return body;
};

afterEach(async () => {
  const cleanupErrors: unknown[] = [];
  for (const fixture of fixtures.splice(0)) {
    try {
      await fixture.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const cleanup of artifactFixtureCleanups.splice(0).reverse()) {
    try {
      cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0)
    throw new AggregateError(
      cleanupErrors,
      "sandbox V6 fixture and synthetic artifact cleanup failed",
      { cause: cleanupErrors[0] },
    );
});

describe("V6-E V3 exact provider tuple drift across daemon restart", () => {
  it.skipIf(process.platform !== "win32")(
    "preserves P9 terminal semantics and reapproves a fresh root candidate after registry drift",
    async () => {
      let sourceFilename: string | undefined;
      const daemonEnvironment: Record<string, string> = {};
      daemonEnvironment.ARBOR_AUTH_TOKENS =
        "local=user:local,operator=user:operator";
      daemonEnvironment.ARBOR_TICK_INTERVAL_MS = "25";
      daemonEnvironment.ARBOR_AH_BOUNDARY = "AH7AfterToolIntentCommit";
      const marker = `V6-E-${crypto.randomUUID().slice(0, 8)}`;
      const probeLines: Record<string, unknown>[] = [];
      const executableProbeLines: Record<string, unknown>[] = [];
      const preparationProbeLines: Record<string, unknown>[] = [];
      const schedulerProbeLines: Record<string, unknown>[] = [];
      const stdoutLines: string[] = [];
      let providerCalls = 0;
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
        daemonEnvironment,
        reply: (call) => {
          const context = JSON.stringify(call.messages);
          const available = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
          const targetWorkTurn = available.has("shell");
          if (
            context.includes(marker) &&
            available.has("assign_work") &&
            !targetWorkTurn &&
            !context.includes("WorkAssigned(")
          ) {
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
          if (context.includes(marker) && available.has("shell")) {
            providerCalls += 1;
            return {
              _tag: "ToolCall",
              name: "shell",
              arguments: {
                command,
                cwd: { mount: "workspace", path: "." },
                timeoutMs: 5_000,
              },
            };
          }
          return { _tag: "Text", text: `Waiting for ${marker}` };
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
            if (value.tag === "SCHEDULER_PROBE")
              schedulerProbeLines.push(value);
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
          const sourceDir = resolve(
            event.directory,
            "sandbox-policy-v3-source",
          );
          const sourcePair = sandboxPolicyV3TestPair({
            bundleRevision: 1,
            registryRevision: 1,
          });
          artifactFixtureCleanups.push(
            installSandboxPolicyV3SyntheticArtifacts(sourcePair),
          );
          sourceFilename = writeSandboxPolicyV3TestPair(sourceDir, sourcePair);
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
          if (
            loaded._tag !== "Available" ||
            loaded.snapshot.bundle.version !== 3
          )
            throw new Error(
              `synthetic P5 V3 pair rejected: ${JSON.stringify(loaded)}`,
            );
          const currentHost = sandboxPolicyCurrentHostV1();
          const supportedRow = sourcePair.bundle.providerRegistry.entries[0];
          if (currentHost === undefined || supportedRow === undefined)
            throw new Error(
              "synthetic D2 evidence omitted current host or row",
            );
          const inspection =
            inspectWindowsNativeQualificationForRegistryEntryV3(
              fixedWindowsNativeProductionArtifactPaths(),
              supportedRow,
              loaded.snapshot,
              currentHost,
              new Date().toISOString(),
            );
          if (inspection._tag !== "ManifestVerified")
            throw new Error(
              `synthetic D2 evidence rejected: ${inspection.reason}`,
            );
          daemonEnvironment.ARBOR_SANDBOX_AUTHORITY_SOURCE_FILE =
            sourceFilename;
        },
      });
      fixtures.push(fixture);
      if (sourceFilename === undefined)
        throw new Error("schema-50 V3 source fixture setup was incomplete");
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        "V6 E registry drift",
        { resourceSelection: "Profile" },
      );
      execFileSync("git", ["init", "--quiet"], {
        cwd: fixture.workspaceDirectory,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "Arbor Test"], {
        cwd: fixture.workspaceDirectory,
        stdio: "ignore",
      });
      execFileSync(
        "git",
        ["config", "user.email", "arbor-test@example.invalid"],
        {
          cwd: fixture.workspaceDirectory,
          stdio: "ignore",
        },
      );
      execFileSync("git", ["add", "proof.txt"], {
        cwd: fixture.workspaceDirectory,
        stdio: "ignore",
      });
      execFileSync("git", ["commit", "--quiet", "-m", "sandbox fixture"], {
        cwd: fixture.workspaceDirectory,
        stdio: "ignore",
      });
      const command = "git status --short";
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
          probeLines.find(
            (value) => value.boundary === "AH7AfterToolIntentCommit",
          ),
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
          user: call.messages.find((message) => message.role === "user")
            ?.content,
          tools: call.tools.map((tool) => tool.function?.name),
          priorToolResult: call.messages
            .filter((message) => message.role === "tool")
            .map((message) => message.content),
        }));
        throw new Error(
          `RED: executable action has not reached the P4 intent boundary; pendingShellActions=${JSON.stringify(pendingShellActions)}; matchingToolInvocations=${JSON.stringify(actionInvocations)}; AH7ProbeCount=${probeLines.length}; executableProbe=${JSON.stringify(executableProbeLines)}; providerCalls=${providerCalls}; modelRequests=${JSON.stringify(providerSummary)}; loop=${JSON.stringify({ steps: durable.steps, actions: durable.actions, invocations: durable.toolInvocations })}; stdout=${stdoutLines.slice(-20).join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}; wait=${String(error)}`,
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
        async () =>
          durableSandboxRead(
            fixture.databaseFile,
            executionId,
            firstInvocationId,
          ),
        (state) =>
          state.invocation?.settled_at !== null &&
          state.invocation !== undefined,
        45_000,
      ).catch((error: unknown) => {
        const durable = durableSnapshot(fixture.databaseFile);
        throw new Error(
          `first unavailable action did not settle after live lease expiry; state=${JSON.stringify(durableSandboxRead(fixture.databaseFile, executionId, firstInvocationId))}; scheduler=${JSON.stringify(schedulerProbeLines.slice(-20))}; executable=${JSON.stringify(executableProbeLines.slice(-20))}; actions=${JSON.stringify(durable.actions)}; invocations=${JSON.stringify(durable.toolInvocations)}; stdout=${stdoutLines.slice(-30).join(" | ")}; wait=${String(error)}`,
          { cause: error },
        );
      });
      expect(firstSettled.invocation?.observation_json).not.toBeNull();
      const p9Terminal =
        Array.isArray(firstSettled.actions) &&
        firstSettled.actions[0]?.state === "TerminalRejected" &&
        firstSettled.step?.state === "StepEffectsCommitted";
      expect(firstSettled.invocation?.settlement_kind).toBe("ExpectedFailure");
      const firstObservation = decodeToolObservation(
        firstSettled.invocation?.observation_json,
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
      if (p9Terminal) {
        expect(firstSettled.actions).toMatchObject([
          { state: "TerminalRejected", action_index: 0, logical_step_no: 0 },
        ]);
        expect(firstSettled.step).toMatchObject({
          state: "StepEffectsCommitted",
          next_action_index: 1,
        });
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
          probeLines.filter(
            (value) => value.boundary === "AH7AfterToolIntentCommit",
          ),
        ).toHaveLength(committedProbeCount);
        expect(providerCalls).toBe(1);
        // Keep the P9 terminal proof intact. Qualify drift through a separate
        // public root Work with its own pre-intent CandidateRead; never mint a
        // second ProviderTurn for this terminal Step.
        const freshProject = await createFunctionalProject(
          client,
          fixture.workspaceDirectory,
          "V6 E fresh candidate after registry drift",
          { resourceSelection: "Profile" },
        );
        const freshWorktreePath = resolve(
          fixture.workspaceDirectory,
          `fresh-${crypto.randomUUID()}`,
        );
        mkdirSync(freshWorktreePath, { recursive: true });
        writeFileSync(resolve(freshWorktreePath, "proof.txt"), marker);
        execFileSync("git", ["init", "--quiet"], {
          cwd: freshWorktreePath,
          stdio: "ignore",
        });
        execFileSync("git", ["config", "user.name", "Arbor Test"], {
          cwd: freshWorktreePath,
          stdio: "ignore",
        });
        execFileSync(
          "git",
          ["config", "user.email", "arbor-test@example.invalid"],
          { cwd: freshWorktreePath, stdio: "ignore" },
        );
        execFileSync("git", ["add", "proof.txt"], {
          cwd: freshWorktreePath,
          stdio: "ignore",
        });
        execFileSync("git", ["commit", "--quiet", "-m", "fresh sandbox fixture"], {
          cwd: freshWorktreePath,
          stdio: "ignore",
        });
        await insertProductionPrimaryWorktree({
          databaseFile: fixture.databaseFile,
          projectId: freshProject.projectId,
          workspaceId: freshProject.rootWorkspaceId,
          path: freshWorktreePath,
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
        const freshExecutableApproval = await waitForExecutableApproval(
          client,
          freshProject.rootWorkspaceId,
          `${marker} fresh Work`,
        );
        const freshPreDriftDetail = await waitForPublic(
          () =>
            client.view<WorkspaceDetailForSandbox>("workspace-detail", {
              workspaceId: freshProject.rootWorkspaceId,
            }),
          (detail) => detail.sandboxPolicyCandidateRead !== undefined,
        );
        const freshPreDriftRead = freshPreDriftDetail.sandboxPolicyCandidateRead;
        if (freshPreDriftRead === undefined)
          throw new Error("fresh public CandidateRead was absent before drift");
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
        const freshApprovalStore = new DatabaseSync(fixture.databaseFile, {
          readOnly: true,
        });
        try {
          const approvalBeforeDrift = freshApprovalStore
            .prepare(
              `SELECT state, revision, consumed_by, execution_id
                 FROM action_approvals
                WHERE approval_id = ? AND route_kind = 'Executable'`,
            )
            .get(freshExecutableApproval.approvalId);
          expect(approvalBeforeDrift).toMatchObject({
            state: "Pending",
            revision: freshExecutableApproval.revision,
            consumed_by: null,
            execution_id: freshExecutionId,
          });
        } finally {
          freshApprovalStore.close();
        }

        const driftPid = fixture.daemonProcessSnapshot()?.pid;
        await fixture.crash();
        if (sourceFilename === undefined)
          throw new Error("schema-50 V3 source path disappeared before drift");
        const driftedPair = sandboxPolicyV3TestPair({
          bundleRevision: 2,
          registryRevision: 2,
          includeRegistryDrift: true,
        });
        writeSandboxPolicyV3SourceFirst(sourceFilename, driftedPair);
        const sourceFirstPair = JSON.parse(
          readFileSync(sourceFilename, "utf8"),
        ) as {
          readonly sourceIdentity: string;
          readonly bundleCanonicalJson: string;
          readonly highWaterCanonicalJson: string;
        };
        const sourceFirst = await Effect.runPromise(
          loadSandboxAuthorityBundleSnapshotCurrent(
            {
              readVerifiedSandboxAuthorityBundle: () =>
                Effect.succeed({
                  sourceIdentity: sourceFirstPair.sourceIdentity,
                  canonicalJson: sourceFirstPair.bundleCanonicalJson,
                }),
              readSandboxAuthorityHighWater: () =>
                Effect.succeed(sourceFirstPair.highWaterCanonicalJson),
              commitSandboxAuthorityHighWater: () => Effect.succeed(false),
              appendSandboxAuthorityAudit: () => Effect.succeed(true),
            },
            new Date().toISOString(),
            SANDBOX_ENV_ALLOWLIST,
          ),
        );
        expect(sourceFirst).toMatchObject({ _tag: "Unavailable" });
        commitSandboxPolicyV3HighWater(sourceFilename, driftedPair);
        await fixture.restart({
          entry: child,
          daemonEnvironment: {
            ARBOR_AH_BOUNDARY: "disabled",
            ARBOR_TICK_INTERVAL_MS: "60000",
            ARBOR_SCHEDULER_PROBE: "1",
          },
        });
        expect(fixture.daemonProcessSnapshot()?.pid).not.toBe(driftPid);

        const refreshedFreshDetail = await waitForPublic(
          () =>
            client.view<WorkspaceDetailForSandbox>("workspace-detail", {
              workspaceId: freshProject.rootWorkspaceId,
            }),
          (detail) =>
            detail.sandboxPolicyCandidateRead?.commonPreconditions
              .authorityBundleRevision === 2,
        );
        const refreshedFreshRead =
          refreshedFreshDetail.sandboxPolicyCandidateRead;
        if (refreshedFreshRead === undefined)
          throw new Error("fresh CandidateRead was absent after restart");
        expect(
          refreshedFreshRead.commonPreconditions.authorityBundleDigest,
        ).not.toBe(freshPreDriftRead.commonPreconditions.authorityBundleDigest);
        const refreshedCandidate = refreshedFreshRead.candidates.find(
          (candidate) =>
            candidate.kind === "OsEnforced" &&
            candidate.providerId === "windows-restricted-appcontainer-job" &&
            candidate.profile === "ReadOnly" &&
            candidate.networkMode === "Disabled",
        );
        if (refreshedCandidate?.kind !== "OsEnforced")
          throw new Error("fresh post-drift Supported candidate was absent");
        expect(refreshedCandidate.providerRegistryRevision).toBe(2);
        expect(refreshedCandidate.providerRegistryDigest).not.toBe(
          preDriftCandidate.providerRegistryDigest,
        );
        expect(refreshedCandidate.profile).toBe(preDriftCandidate.profile);
        expect(refreshedCandidate.networkMode).toBe(
          preDriftCandidate.networkMode,
        );
        expect(refreshedCandidate.providerVersion).toBe(
          preDriftCandidate.providerVersion,
        );
        expect(refreshedCandidate.capabilityRevision).toBe(
          preDriftCandidate.capabilityRevision,
        );

        const staleFreshCommandId = functionalId("cmd");
        const staleFresh = await operatorCommand(
          fixture.baseUrl,
          freshProject.projectId,
          "DecideSandboxPolicy",
          freshOldPayload,
          staleFreshCommandId,
        );
        expect(staleFresh).toMatchObject({
          body: {
            resolution: "TerminalRejected",
            rejection: "StaleSandboxPolicyInputs",
          },
        });
        const untouchedFresh = durableSandboxRead(
          fixture.databaseFile,
          freshExecutionId,
        );
        expect(untouchedFresh.decisions).toEqual({ count: 0 });
        expect(untouchedFresh.decisionEvents).toEqual({ count: 0 });
        expect(untouchedFresh.actions).toHaveLength(1);
        expect(untouchedFresh.actions[0]).toMatchObject({
          state: "Pending",
          action_index: 0,
        });
        expect(untouchedFresh.invocation).toBeUndefined();

        const freshPayload = policyPayload({
          read: refreshedFreshRead,
          projectId: freshProject.projectId,
          workspaceId: freshProject.rootWorkspaceId,
          executionId: freshExecutionId,
          expiresAt: p1GrantExpiresAt,
        });
        expect(freshPayload.profile).toBe(preDriftCandidate.profile);
        expect(freshPayload.networkPolicy).toEqual({
          kind: "OsEnforced",
          policy: { version: 1, mode: "Disabled", destinations: [] },
        });
        const acceptedFresh = await operatorCommand(
          fixture.baseUrl,
          freshProject.projectId,
          "DecideSandboxPolicy",
          freshPayload,
        );
        expect(acceptedFresh).toMatchObject({ body: { resolution: "Committed" } });
        const acceptedFreshState = durableSandboxRead(
          fixture.databaseFile,
          freshExecutionId,
        );
        expect(acceptedFreshState.decisions).toEqual({ count: 1 });
        expect(acceptedFreshState.decisionEvents).toEqual({ count: 1 });
        expect(acceptedFreshState.actions).toEqual(untouchedFresh.actions);
        expect(acceptedFreshState.invocation).toBeUndefined();
        const approvalAfterFreshDecision = new DatabaseSync(
          fixture.databaseFile,
          { readOnly: true },
        );
        try {
          expect(
            approvalAfterFreshDecision
              .prepare(
                `SELECT state, revision, consumed_by, execution_id
                   FROM action_approvals
                  WHERE approval_id = ? AND route_kind = 'Executable'`,
              )
              .get(freshExecutableApproval.approvalId),
          ).toMatchObject({
            state: "Pending",
            revision: freshExecutableApproval.revision,
            consumed_by: null,
            execution_id: freshExecutionId,
          });
        } finally {
          approvalAfterFreshDecision.close();
        }
        const freshDecision = sandboxDecisionDebug(
          fixture.databaseFile,
          freshExecutionId,
        );
        expect(freshDecision).toMatchObject({
          profile_id: preDriftCandidate.profile,
          provider_id: preDriftCandidate.providerId,
        });
        expect(providerCalls).toBe(providerCallsAtPending + 1);
        expect(fixture.daemonErrors).toEqual([]);
        return;
      }

      expect(
        executableProbeLines.find(
          (event) =>
            event.boundary === "P4ExecutableToolRuntimeOutcome" &&
            event.invocationId === firstInvocationId,
        ),
      ).toMatchObject({ outcomeTag: "ExpectedFailure" });

      const probesBeforeSecond = probeLines.length;
      const secondProbe = await waitForPublic(
        async () =>
          probeLines
            .slice(probesBeforeSecond)
            .find((value) => value.boundary === "AH7AfterToolIntentCommit"),
        (value) => value !== undefined,
        30_000,
      ).catch((error: unknown) => {
        const durable = durableSnapshot(fixture.databaseFile);
        throw new Error(
          `second shell action did not reach P4 intent; providerCalls=${providerCalls}; decision=${JSON.stringify(sandboxDecisionDebug(fixture.databaseFile, executionId))}; probes=${JSON.stringify(probeLines)}; loop=${JSON.stringify({ steps: durable.steps, actions: durable.actions, invocations: durable.toolInvocations })}; stdout=${stdoutLines.slice(-30).join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}; wait=${String(error)}`,
          { cause: error },
        );
      });
      if (secondProbe === undefined)
        throw new Error("second AH7 P4 intent probe was not captured");
      const secondExecutionId = String(secondProbe.executionId ?? "");
      const secondInvocationId = String(secondProbe.invocationId ?? "");
      expect(secondExecutionId).toBe(executionId);
      expect(secondInvocationId).toMatch(/^tin_/u);
      expect(secondInvocationId).not.toBe(firstInvocationId);
      const decisionIntentOrder = new DatabaseSync(fixture.databaseFile, {
        readOnly: true,
      });
      try {
        const order = decisionIntentOrder
          .prepare(
            `SELECT d.issued_at AS decisionIssuedAt,
                    i.intent_at AS invocationIntentAt
               FROM sandbox_policy_decisions d
               JOIN tool_invocations i ON i.execution_id = d.execution_id
              WHERE d.execution_id = ? AND i.invocation_id = ?
              ORDER BY d.policy_revision DESC LIMIT 1`,
          )
          .get(executionId, secondInvocationId) as
          | {
              readonly decisionIssuedAt?: string;
              readonly invocationIntentAt?: string;
            }
          | undefined;
        expect(order?.decisionIssuedAt).toBeDefined();
        expect(order?.invocationIntentAt).toBeDefined();
        expect(Date.parse(order?.decisionIssuedAt ?? "")).toBeLessThan(
          Date.parse(order?.invocationIntentAt ?? ""),
        );
      } finally {
        decisionIntentOrder.close();
      }
      const pendingState = durableSandboxRead(
        fixture.databaseFile,
        executionId,
        secondInvocationId,
      );
      const actionRows = pendingState.actions as ReadonlyArray<{
        readonly logical_action_id?: string;
        readonly state?: string;
        readonly action_index?: number;
        readonly logical_step_no?: number;
        readonly disposition_json?: string | null;
      }>;
      const bootstrapAction = actionRows.find(
        (row) => row.logical_step_no === 0 && row.action_index === 0,
      );
      expect(bootstrapAction).toMatchObject({ state: "Applied" });
      expect(
        JSON.parse(String(bootstrapAction?.disposition_json ?? "{}")),
      ).toMatchObject({ _tag: "Applied", status: "Failed" });
      const unavailable = new DatabaseSync(fixture.databaseFile, {
        readOnly: true,
      });
      try {
        const unavailableEvidence = unavailable
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
        expect(
          unavailableEvidence?.provider_id,
          JSON.stringify({
            unavailableEvidence,
            firstSettled,
            firstP4Outcomes: executableProbeLines.filter(
              (event) => event.invocationId === firstInvocationId,
            ),
          }),
        ).toBe("windows-restricted-appcontainer-job");
        expect(unavailableEvidence?.provider_version).toBe("t3d-v1");
        expect(unavailableEvidence?.probe_evidence_ref).toMatch(
          /^blob:sha256:[0-9a-f]{64}$/u,
        );
        expect(unavailableEvidence?.failure_code?.length).toBeGreaterThan(0);
        expect(unavailableEvidence?.queue_state).toMatch(
          /^(Pending|Claimed|Consumed)$/u,
        );
      } finally {
        unavailable.close();
      }
      const pendingActionRows = actionRows.filter(
        (row) => row.state === "Pending",
      );
      const actionRow = pendingActionRows[0];
      const invocationRow = pendingState.invocation as
        | {
            readonly invocation_id?: string;
            readonly effect_admission_state?: string;
            readonly recovery_binding_state?: string;
            readonly settled_at?: string | null;
            readonly observation_json?: Buffer | null;
          }
        | undefined;
      if (
        pendingActionRows.length !== 1 ||
        actionRow?.logical_action_id === undefined ||
        invocationRow?.invocation_id === undefined
      )
        throw new Error(
          `second AH7 route omitted pending action/invocation: ${JSON.stringify(pendingState)}`,
        );
      expect(actionRow.state).toBe("Pending");
      expect(invocationRow).toMatchObject({
        invocation_id: secondInvocationId,
        effect_admission_state: "NotAdmitted",
        recovery_binding_state: "Bound",
        settled_at: null,
        observation_json: null,
      });
      expect(fixture.daemonErrors).toEqual([]);
      const seeded = {
        workspace: project.rootWorkspaceId,
        execution: executionId,
        logicalActionId: actionRow.logical_action_id,
        invocation: secondInvocationId,
      };
      const providerCallsAtPending = providerCalls;
      const modelRequestsAtPending = fixture.providerCalls.length;
      const approvedState = pendingState;
      expect(approvedState).toMatchObject({
        decisions: { count: 1 },
        decisionEvents: { count: 1 },
      });
      const schedulerEventsBeforeRestart = schedulerProbeLines.length;
      const executableProbesAtPending = executableProbeLines.length;
      const oldPid = fixture.daemonProcessSnapshot()?.pid;
      await fixture.crash();
      if (sourceFilename === undefined)
        throw new Error("schema-50 V3 source path disappeared");
      const driftedPair = sandboxPolicyV3TestPair({
        bundleRevision: 2,
        registryRevision: 2,
        includeRegistryDrift: true,
      });
      writeSandboxPolicyV3SourceFirst(sourceFilename, driftedPair);
      const sourceFirstPair = JSON.parse(
        readFileSync(sourceFilename, "utf8"),
      ) as {
        readonly sourceIdentity: string;
        readonly bundleCanonicalJson: string;
        readonly highWaterCanonicalJson: string;
      };
      const sourceFirst = await Effect.runPromise(
        loadSandboxAuthorityBundleSnapshotCurrent(
          {
            readVerifiedSandboxAuthorityBundle: () =>
              Effect.succeed({
                sourceIdentity: sourceFirstPair.sourceIdentity,
                canonicalJson: sourceFirstPair.bundleCanonicalJson,
              }),
            readSandboxAuthorityHighWater: () =>
              Effect.succeed(sourceFirstPair.highWaterCanonicalJson),
            commitSandboxAuthorityHighWater: () => Effect.succeed(false),
            appendSandboxAuthorityAudit: () => Effect.succeed(true),
          },
          new Date().toISOString(),
          SANDBOX_ENV_ALLOWLIST,
        ),
      );
      expect(sourceFirst).toMatchObject({ _tag: "Unavailable" });
      commitSandboxPolicyV3HighWater(sourceFilename, driftedPair);
      await fixture.restart({
        entry: child,
        daemonEnvironment: {
          ARBOR_AH_BOUNDARY: "disabled",
          ARBOR_TICK_INTERVAL_MS: "60000",
          ARBOR_SCHEDULER_PROBE: "1",
        },
      });
      expect(fixture.daemonProcessSnapshot()?.pid).not.toBe(oldPid);

      const dispatchGate = await waitForPublic(
        async () =>
          schedulerProbeLines
            .slice(schedulerEventsBeforeRestart)
            .find(
              (event) =>
                event.boundary === "PreDispatchLeaseCheck" &&
                event.executionId === seeded.execution &&
                event.dispatchable === false,
            ),
        (event) => event !== undefined,
        20_000,
      );
      expect(dispatchGate).toMatchObject({
        boundary: "PreDispatchLeaseCheck",
        executionId: seeded.execution,
        dispatchable: false,
      });

      const parkedDetail = await waitForPublic(
        () =>
          client.view<WorkspaceDetailForSandbox>("workspace-detail", {
            workspaceId: seeded.workspace,
          }),
        (detail) => detail.sandboxPolicyCandidateRead !== undefined,
      );
      const refreshedRead = parkedDetail.sandboxPolicyCandidateRead;
      if (refreshedRead === undefined)
        throw new Error("refreshed candidate read missing");
      expect(refreshedRead.commonPreconditions.authorityBundleRevision).toBe(2);
      expect(refreshedRead.commonPreconditions.authorityBundleDigest).not.toBe(
        initialRead.commonPreconditions.authorityBundleDigest,
      );
      const refreshedOsCandidate = refreshedRead.candidates.find(
        (candidate) =>
          candidate.kind === "OsEnforced" &&
          candidate.providerId === "windows-restricted-appcontainer-job" &&
          candidate.profile === "ReadOnly" &&
          candidate.networkMode === "Disabled",
      );
      expect(refreshedOsCandidate).toBeDefined();
      expect(
        refreshedOsCandidate?.kind === "OsEnforced"
          ? refreshedOsCandidate.providerRegistryRevision
          : undefined,
      ).toBe(2);
      const parkedState = durableSandboxRead(
        fixture.databaseFile,
        seeded.execution,
        seeded.invocation,
      );
      expect(parkedState.lease).toEqual(approvedState.lease);
      expect(parkedState.actions).toEqual(approvedState.actions);
      expect(parkedState.step).toEqual(approvedState.step);
      expect(parkedState.invocation).toEqual(approvedState.invocation);
      expect(parkedState.invocation).toMatchObject({
        invocation_id: seeded.invocation,
        effect_admission_state: "NotAdmitted",
        recovery_binding_state: "Bound",
        settled_at: null,
        observation_json: null,
      });
      expect(providerCalls).toBe(providerCallsAtPending);
      expect(fixture.providerCalls).toHaveLength(modelRequestsAtPending);
      expect(executableProbeLines).toHaveLength(executableProbesAtPending);

      const staleCommandId = functionalId("cmd");
      const stale = await operatorCommand(
        fixture.baseUrl,
        project.projectId,
        "DecideSandboxPolicy",
        oldPayload,
        staleCommandId,
      );
      expect(stale).toMatchObject({
        body: {
          resolution: "TerminalRejected",
          rejection: "StaleSandboxPolicyInputs",
        },
      });
      const afterStale = durableSandboxRead(
        fixture.databaseFile,
        seeded.execution,
        seeded.invocation,
      );
      expect(afterStale.decisions).toEqual(approvedState.decisions);
      expect(afterStale.decisionEvents).toEqual(approvedState.decisionEvents);
      expect(afterStale.lease).toEqual(approvedState.lease);
      expect(afterStale.actions).toEqual(approvedState.actions);
      expect(afterStale.invocation).toEqual(approvedState.invocation);
      expect(providerCalls).toBe(providerCallsAtPending);
      expect(fixture.providerCalls).toHaveLength(modelRequestsAtPending);
      const staleReceipt = new DatabaseSync(fixture.databaseFile, {
        readOnly: true,
      });
      try {
        const command = staleReceipt
          .prepare(
            `SELECT command_id, resolution, result_json, terminal_error_json
             FROM commands WHERE command_id = ?`,
          )
          .get(staleCommandId) as
          | {
              readonly command_id?: string;
              readonly resolution?: string;
              readonly result_json?: string | null;
              readonly terminal_error_json?: string | null;
            }
          | undefined;
        expect(command?.command_id).toBe(staleCommandId);
        expect(command?.resolution).toBe("TerminalRejected");
        expect(
          JSON.stringify(command).includes("StaleSandboxPolicyInputs"),
        ).toBe(true);
      } finally {
        staleReceipt.close();
      }
    },
    180_000,
  );
});
