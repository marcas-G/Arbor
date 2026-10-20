import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentResolverLocalLive } from "../../../adapters/environment-resolver-local/src/index.js";
import {
  ClockLive,
  ExecutionRepositoryLive,
  ResourceOwnershipRepositoryLive,
  SandboxPolicyDecisionStoreLive,
  layer as sqliteLayer,
  TransactionPortLive,
  WorkspaceRepositoryLive,
  WorktreeStoreLive,
} from "../../../adapters/persistence-sqlite/src/index.js";
import { SandboxPolicyCandidateBoundaryReadPortLive } from "../../../apps/single-workspace/src/sandbox-policy-candidate-boundary-read-port.js";
import { makeSandboxPolicyDecisionPreparation } from "../../../apps/single-workspace/src/sandbox-policy-decision-preparation.js";
import {
  EnvironmentResolverPort,
  ExecutionRepository,
  ResourceOwnershipRepository,
  SandboxPolicyCandidateBoundaryReadPort,
  SandboxPolicyDecisionStore,
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
  sandboxPolicyV2TestPair,
  writeSandboxPolicyV2TestPair,
} from "../support/sandbox-policy-v2-source.js";

interface SandboxCandidate {
  readonly kind: string;
  readonly candidateId: string;
  readonly sandboxHandleBindingDigest: string;
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
  readonly sandboxPolicy?: { readonly status?: string };
}

const child = resolve(
  "tests/functional/support/sandbox-policy-v2-daemon-child.mjs",
);
const fixtures: ProductionFixture[] = [];

const durableSandboxRead = (databaseFile: string, executionId: string) => {
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
                  repair_attempt, revision
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
                  recovery_binding_sha256, settled_at, settlement_kind
             FROM tool_invocations WHERE execution_id = ?`,
        )
        .get(executionId),
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

const readProductionBoundary = (
  databaseFile: string,
  input: { readonly projectId: string; readonly workspaceId: string },
) => {
  const infra = Layer.mergeAll(
    sqliteLayer({ filename: databaseFile }),
    ClockLive,
  );
  const resolver = Layer.provideMerge(EnvironmentResolverLocalLive, infra);
  const sources = Layer.mergeAll(
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(ResourceOwnershipRepositoryLive, infra),
    Layer.provide(WorktreeStoreLive, infra),
    resolver,
  );
  const app = Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(SandboxPolicyCandidateBoundaryReadPortLive, sources),
  );
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const tx = yield* TransactionPort;
        const boundary = yield* SandboxPolicyCandidateBoundaryReadPort;
        return yield* tx.transact(
          boundary.readCurrentForWorkspace(input as never),
        );
      }),
      app,
    ),
  );
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

const sandboxPreparationDiagnostic = async (input: {
  readonly databaseFile: string;
  readonly payload: unknown;
  readonly pair: ReturnType<typeof sandboxPolicyV2TestPair>;
}) => {
  const infra = Layer.mergeAll(
    sqliteLayer({ filename: input.databaseFile }),
    ClockLive,
  );
  const resolver = Layer.provideMerge(EnvironmentResolverLocalLive, infra);
  const app = Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(ResourceOwnershipRepositoryLive, infra),
    Layer.provide(WorktreeStoreLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
    Layer.provide(SandboxPolicyDecisionStoreLive, infra),
    resolver,
  );
  const diagnostic = Effect.provide(
    Effect.gen(function* () {
      const tx = yield* TransactionPort;
      const preparation = makeSandboxPolicyDecisionPreparation({
        transaction: tx,
        workspaces: yield* WorkspaceRepository,
        executions: yield* ExecutionRepository,
        decisions: yield* SandboxPolicyDecisionStore,
        ownership: yield* ResourceOwnershipRepository,
        worktrees: yield* WorktreeStore,
        environmentResolver: yield* EnvironmentResolverPort,
        authoritySnapshot: {
          bundle: input.pair.bundle,
          bundleDigest: input.pair.bundleDigest,
          canonicalJson: input.pair.bundleCanonicalJson,
        },
      });
      const authority = {
        _tag: "SandboxPolicyDecisionAuthority",
        authorityBundleRevision: input.pair.bundle.bundleRevision,
        authorityBundleDigest: input.pair.bundleDigest,
        operatorConfigRevision: input.pair.bundle.operatorConfigRevision,
        operatorConfigDigest: input.pair.bundle.operatorConfigDigest,
      } as never;
      const prepared = yield* Effect.match(
        preparation.prepare(input.payload as never, authority),
        {
          onFailure: (error) => ({ _tag: "Left" as const, error }),
          onSuccess: (value) => ({ _tag: "Right" as const, value }),
        },
      );
      if (prepared._tag === "Left") {
        const cause =
          typeof prepared.error.cause === "string"
            ? prepared.error.cause
            : "non-string";
        const knownCause = new Set([
          "sandbox authority or active Execution is stale",
          "network policy is invalid",
          "no qualified Supported OS provider is available; no fallback is permitted",
          "TrustedLocal requires the exact FullAccess selection",
          "exactly one active managed P11 Worktree is required",
          "P11 observation entries and normalized region set differ",
          "primary managed Worktree did not resolve exactly once",
          "primary P11 observation entries and normalized set differ",
          "P11 boundary or operator policy materialization failed",
        ]);
        return {
          stage: "Prepare" as const,
          errorTag: prepared.error._tag,
          cause: knownCause.has(cause) ? cause : "unclassified",
        };
      }
      const current = yield* Effect.match(
        tx.transact(preparation.currentPreconditions(input.payload as never)),
        {
          onFailure: (error) => ({ _tag: "Left" as const, error }),
          onSuccess: (value) => ({ _tag: "Right" as const, value }),
        },
      );
      return current._tag === "Left"
        ? {
            prepareResult: "PrepareSuccess" as const,
            stage: "CurrentPreconditions" as const,
            errorTag: current.error._tag,
            cause:
              typeof current.error === "object" &&
              current.error !== null &&
              "cause" in current.error
                ? "transaction-operational-failure"
                : "non-string",
          }
        : {
            prepareResult: "PrepareSuccess" as const,
            stage: "CurrentPreconditions" as const,
            resultKind: current.value.kind,
          };
    }),
    app,
  );
  return Effect.runPromise(
    diagnostic as Effect.Effect<unknown, unknown, never>,
  );
};

const policyPayload = (input: {
  readonly read: CandidateRead;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly executionId: string;
  readonly expiresAt: string;
}) => {
  const trusted = input.read.candidates.find(
    (candidate) => candidate.kind === "TrustedLocalUnconfinedV1",
  );
  if (trusted === undefined) throw new Error("TrustedLocal candidate missing");
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
    expectedSandboxHandleBindingDigest: trusted.sandboxHandleBindingDigest,
    expectedAuthorityBundleRevision:
      input.read.commonPreconditions.authorityBundleRevision,
    expectedAuthorityBundleDigest:
      input.read.commonPreconditions.authorityBundleDigest,
    expectedOperatorConfigRevision:
      input.read.commonPreconditions.operatorConfigRevision,
    expectedOperatorConfigDigest:
      input.read.commonPreconditions.operatorConfigDigest,
    profile: "FullAccess",
    providerId: "TrustedLocal",
    networkPolicy: { kind: "TrustedLocalUnconfinedV1", version: 1 },
    decisionExpiresAt: input.expiresAt,
  };
};

const operatorCommand = async (
  baseUrl: string,
  projectId: string,
  commandType: string,
  payload: unknown,
) => {
  const response = await fetch(`${baseUrl}/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer operator",
    },
    body: JSON.stringify({
      commandType,
      commandId: functionalId("cmd"),
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
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("V6-E V2 registry-only drift across daemon restart", () => {
  it("parks a real pending sandbox action on registry-only bundle drift after restart", async () => {
    let sourceFilename: string | undefined;
    let sourcePair: ReturnType<typeof sandboxPolicyV2TestPair> | undefined;
    const daemonEnvironment: Record<string, string> = {};
    daemonEnvironment.ARBOR_AUTH_TOKENS =
      "local=user:local,operator=user:operator";
    daemonEnvironment.ARBOR_TICK_INTERVAL_MS = "25";
    const marker = `V6-E-${crypto.randomUUID().slice(0, 8)}`;
    const probeLines: Record<string, unknown>[] = [];
    const executableProbeLines: Record<string, unknown>[] = [];
    const preparationProbeLines: Record<string, unknown>[] = [];
    const stdoutLines: string[] = [];
    let probeArmed = false;
    let providerCalls = 0;
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
              objective: `Append ${effectMarker} exactly once with the allowlisted shell command.`,
              why: "qualify V6 P4 policy recovery with a real AgentLoop action",
              constraints: [],
              completionExpectation: `${effectFile} contains ${effectMarker} exactly once`,
              verificationMission: {
                goal: `Verify the sandbox command for ${marker}`,
                criteria: [
                  {
                    criterionId: "sandbox-command",
                    requirement: `${effectFile} contains ${effectMarker} exactly once`,
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
          if (!probeArmed) return { _tag: "HttpError", status: 503 };
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
        } catch {
          // ProductionFixture also forwards normal readiness output.
        }
      },
      setupProbe: async (event) => {
        if (event.stage !== "after-clone") return;
        const sourceDir = resolve(event.directory, "sandbox-policy-v2-source");
        sourcePair = sandboxPolicyV2TestPair({
          bundleRevision: 1,
          registryRevision: 1,
        });
        sourceFilename = writeSandboxPolicyV2TestPair(sourceDir, sourcePair);
        daemonEnvironment.ARBOR_SANDBOX_AUTHORITY_SOURCE_FILE = sourceFilename;
      },
    });
    fixtures.push(fixture);
    if (sourceFilename === undefined)
      throw new Error("schema-50 V2 source fixture setup was incomplete");
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
    const effectMarker = `V6_E2_EFFECT_${marker}`;
    const effectFile = join(
      fixture.workspaceDirectory,
      `v6-${marker}-effect.txt`,
    );
    const command =
      process.platform === "win32"
        ? `Add-Content -LiteralPath '${effectFile}' -Value '${effectMarker}'`
        : `printf '%s\\n' '${effectMarker}' >> '${effectFile}'`;
    await insertProductionPrimaryWorktree({
      databaseFile: fixture.databaseFile,
      projectId: project.projectId,
      workspaceId: project.rootWorkspaceId,
      path: fixture.workspaceDirectory,
    });
    await client.command(project.projectId, "GrantPermission", {
      permissionGrantId: functionalId("pgr"),
      issuer: "user:local",
      subject: { _tag: "WorkspaceAgent", workspaceId: project.rootWorkspaceId },
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
    await waitForPublic(
      () =>
        client.view<{
          readonly workId?: string;
          readonly status: string;
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (work) => work?.workId !== undefined,
    ).catch((error: unknown) => {
      throw new Error(
        `V6 E2 Work admission absent: ${String(error)}; provider=${JSON.stringify(fixture.providerCalls)}; daemon=${fixture.daemonErrors.join(" | ")}`,
        { cause: error },
      );
    });
    await fixture.crash();
    probeArmed = true;
    await fixture.restart({
      entry: child,
      daemonEnvironment: {
        ARBOR_AH_BOUNDARY: "AH7AfterToolIntentCommit",
        ARBOR_TICK_INTERVAL_MS: "25",
      },
    });
    const executableApproval = await waitForExecutableApproval(
      client,
      project.rootWorkspaceId,
      marker,
    ).catch((error: unknown) => {
      throw new Error(
        `V6 E2 executable approval absent: ${String(error)}; providerCalls=${providerCalls}; AH7Probe=${JSON.stringify(probeLines)}; executableProbe=${JSON.stringify(executableProbeLines)}; preparationProbe=${JSON.stringify(preparationProbeLines)}; daemon=${fixture.daemonErrors.join(" | ")}; stdout=${stdoutLines.slice(-30).join(" | ")}`,
        { cause: error },
      );
    });
    const executableResolution = await client.command(
      project.projectId,
      "ResolveExecutableApproval",
      {
        approvalId: executableApproval.approvalId,
        expectedRevision: executableApproval.revision,
        decision: "Approve",
        reason: "V6 E2 exact shell executable approval",
      },
    );
    expect(executableResolution).toMatchObject({
      body: { resolution: "Committed" },
    });
    const probe = await waitForPublic(
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
        user: call.messages.find((message) => message.role === "user")?.content,
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
    if (probe === undefined)
      throw new Error("AH7 P4 intent probe was not captured");
    const executionId = String(probe.executionId ?? "");
    if (!executionId.startsWith("exe_"))
      throw new Error(
        `AH7 probe omitted execution identity: ${JSON.stringify(probe)}`,
      );
    const pendingState = durableSandboxRead(fixture.databaseFile, executionId);
    const actionRow = pendingState.actions[0] as
      | { readonly logical_action_id?: string; readonly state?: string }
      | undefined;
    const invocationRow = pendingState.invocation as
      | {
          readonly invocation_id?: string;
          readonly effect_admission_state?: string;
        }
      | undefined;
    if (
      actionRow?.logical_action_id === undefined ||
      invocationRow?.invocation_id === undefined
    )
      throw new Error(
        `production AH7 route omitted pending action/invocation: ${JSON.stringify(pendingState)}`,
      );
    await fixture.crash();
    await fixture.restart({
      entry: child,
      daemonEnvironment: {
        ARBOR_AH_BOUNDARY: "disabled",
        ARBOR_TICK_INTERVAL_MS: "60000",
      },
    });
    const seeded = {
      workspace: project.rootWorkspaceId,
      execution: executionId,
      logicalActionId: actionRow.logical_action_id,
      invocation: invocationRow.invocation_id,
    };
    expect(actionRow.state).toBe("Pending");
    expect(invocationRow.effect_admission_state).toBe("NotAdmitted");
    expect(fixture.daemonErrors).toEqual([]);
    const providerCallsAtPending = providerCalls;
    const modelRequestsAtPending = fixture.providerCalls.length;
    try {
      await readProductionBoundary(fixture.databaseFile, {
        projectId: project.projectId,
        workspaceId: project.rootWorkspaceId,
      });
    } catch (error) {
      throw new Error(`P11 candidate boundary read failed: ${String(error)}`, {
        cause: error,
      });
    }
    let initialDetail: WorkspaceDetailForSandbox;
    try {
      initialDetail = await client.view<WorkspaceDetailForSandbox>(
        "workspace-detail",
        { workspaceId: seeded.workspace },
      );
    } catch (error) {
      const audit = readFileSync(`${sourceFilename}.audit`, "utf8");
      throw new Error(`${String(error)}; V2 audit=${audit}`, { cause: error });
    }
    const initialRead = initialDetail.sandboxPolicyCandidateRead;
    if (initialRead === undefined)
      throw new Error(
        `initial candidate read missing: ${JSON.stringify(initialDetail)}`,
      );
    const beforeGrant = durableSandboxRead(
      fixture.databaseFile,
      seeded.execution,
    );
    expect(pendingState.lease).toBeDefined();
    expect(beforeGrant.lease).toEqual(pendingState.lease);
    expect(beforeGrant.actions).toMatchObject([
      {
        logical_action_id: seeded.logicalActionId,
        state: "Pending",
        action_index: 0,
      },
    ]);
    expect(beforeGrant.invocation).toMatchObject({
      invocation_id: seeded.invocation,
      effect_admission_state: "NotAdmitted",
      recovery_binding_state: "Bound",
      settled_at: null,
    });

    const grantId = functionalId("pgr");
    const grantExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    await client.command(project.projectId, "GrantPermission", {
      permissionGrantId: grantId,
      issuer: "user:local",
      subject: { _tag: "HumanPrincipal", principal: "user:operator" },
      capability: "DecideSandboxPolicy",
      target: seeded.execution,
      expiresAt: grantExpiresAt,
    });
    const oldPayload = policyPayload({
      read: initialRead,
      projectId: project.projectId,
      workspaceId: seeded.workspace,
      executionId: seeded.execution,
      expiresAt: grantExpiresAt,
    });
    let approved: Record<string, unknown>;
    try {
      approved = await operatorCommand(
        fixture.baseUrl,
        project.projectId,
        "DecideSandboxPolicy",
        oldPayload,
      );
    } catch (error) {
      let preparationDiagnostic: unknown;
      try {
        preparationDiagnostic =
          sourcePair === undefined
            ? { stage: "Snapshot", errorTag: "MissingFixturePair" }
            : await sandboxPreparationDiagnostic({
                databaseFile: fixture.databaseFile,
                payload: oldPayload,
                pair: sourcePair,
              });
      } catch (diagnosticError) {
        const record =
          typeof diagnosticError === "object" && diagnosticError !== null
            ? (diagnosticError as Record<string, unknown>)
            : undefined;
        const nested =
          typeof record?.cause === "object" && record.cause !== null
            ? (record.cause as Record<string, unknown>)
            : undefined;
        const message =
          diagnosticError instanceof Error ? diagnosticError.message : "";
        preparationDiagnostic = {
          stage: "ProbeInfrastructure",
          errorName:
            diagnosticError instanceof Error
              ? diagnosticError.name
              : typeof diagnosticError,
          errorTag:
            (typeof record?._tag === "string" ? record._tag : undefined) ??
            (typeof nested?._tag === "string" ? nested._tag : undefined) ??
            "Unknown",
          repository:
            (typeof record?.repository === "string"
              ? record.repository
              : undefined) ??
            (typeof nested?.repository === "string"
              ? nested.repository
              : undefined),
          operation:
            (typeof record?.operation === "string"
              ? record.operation
              : undefined) ??
            (typeof nested?.operation === "string"
              ? nested.operation
              : undefined),
          messageClass: message.includes("TransactionScope")
            ? "TransactionScope"
            : message.includes("SQLITE")
              ? "SQLite"
              : message.includes("Layer")
                ? "Layer"
                : "Other",
        };
      }
      const db = new DatabaseSync(fixture.databaseFile, { readOnly: true });
      let commandDiagnostic: unknown;
      try {
        commandDiagnostic = {
          commands: db
            .prepare(
              `SELECT command_id, resolution, result_json,
                      terminal_error_json FROM commands ORDER BY created_at DESC LIMIT 4`,
            )
            .all(),
          attempts: db
            .prepare(
              `SELECT command_id, attempt_no, outcome, failure_kind,
                      metadata_json FROM command_attempts ORDER BY started_at DESC LIMIT 6`,
            )
            .all(),
        };
      } finally {
        db.close();
      }
      throw new Error(
        `initial P1 decision failed: ${String(error)}; preparationProbe=${JSON.stringify(preparationProbeLines)}; preparationDiagnostic=${JSON.stringify(preparationDiagnostic)}; daemonErrors=${JSON.stringify(fixture.daemonErrors)}; commands=${JSON.stringify(commandDiagnostic)}`,
        { cause: error },
      );
    }
    if (
      (approved.body as { readonly resolution?: string } | undefined)
        ?.resolution !== "Committed"
    )
      throw new Error(
        `initial P1 receipt was not committed: ${JSON.stringify(approved)}`,
      );
    const approvedState = durableSandboxRead(
      fixture.databaseFile,
      seeded.execution,
    );
    expect(approvedState).toMatchObject({
      decisions: { count: 1 },
      decisionEvents: { count: 1 },
    });

    const oldPid = fixture.daemonProcessSnapshot()?.pid;
    writeSandboxPolicyV2TestPair(
      resolve(fixture.directory, "sandbox-policy-v2-source"),
      sandboxPolicyV2TestPair({ bundleRevision: 2, registryRevision: 2 }),
    );
    await fixture.crash();
    await fixture.restart({
      entry: child,
      daemonEnvironment: {
        ARBOR_AH_BOUNDARY: "disabled",
        ARBOR_TICK_INTERVAL_MS: "60000",
      },
    });
    expect(fixture.daemonProcessSnapshot()?.pid).not.toBe(oldPid);

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
    const parkedState = durableSandboxRead(
      fixture.databaseFile,
      seeded.execution,
    );
    expect(parkedState.lease).toEqual(approvedState.lease);
    expect(parkedState.actions).toEqual(beforeGrant.actions);
    expect(parkedState.step).toEqual(beforeGrant.step);
    expect(parkedState.invocation).toEqual(beforeGrant.invocation);
    expect(providerCalls).toBe(providerCallsAtPending);
    expect(fixture.providerCalls).toHaveLength(modelRequestsAtPending);

    const stale = await operatorCommand(
      fixture.baseUrl,
      project.projectId,
      "DecideSandboxPolicy",
      oldPayload,
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
    );
    expect(afterStale.decisions).toEqual(approvedState.decisions);
    expect(afterStale.decisionEvents).toEqual(approvedState.decisionEvents);
    expect(afterStale.lease).toEqual(approvedState.lease);
    expect(providerCalls).toBe(providerCallsAtPending);
  }, 180_000);
});
