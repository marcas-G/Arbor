import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { SHELL_DEFINITION } from "../../../../packages/tool-runtime/src/catalog.js";
import { durableSnapshot } from "../../support/ah-durable-snapshot.js";
import type { AhProbeHit } from "../../support/ah-probe-line.js";
import {
  createFunctionalProject,
  functionalId,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../../support/public-client.js";
import {
  commitTrustedLocalP11Policy,
  grantTrustedLocalP11Permission,
  initializeTrustedLocalP11Worktree,
} from "../../support/trusted-local-p11-fixture.js";
import type {
  Ah7AdmittedContext,
  Ah7CrashContext,
  Ah7ScenarioContext,
} from "./start-fixture.js";
import {
  crashChild,
  isToolResultFor,
  readEffectAttempts,
  readExecutableApprovalAfterRecovery,
  readExecutionProviderTurns,
  readP4InvocationApprovalBinding,
  readP39RecoveryBinding,
  reconciliationChild,
  waitForExactShellApproval,
} from "./support.js";

export const admitAh7WorkAndApproveShell = async (
  ctx: Ah7ScenarioContext,
): Promise<Ah7AdmittedContext> => {
  const {
    fixture,
    marker,
    steerMarker,
    evidenceFile,
    resultFile,
    command,
    steeredShellRequestObserved,
    releaseSteeredShellResponse,
  } = ctx;
  const {
    boundary,
    semantics,
    reconciliationMode,
    resourceChangeDuringReconcile,
    reconciliationDrift,
  } = ctx.flags;
  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    "AH7 shell intent ambiguity",
    { resourceSelection: "Profile" },
  );
  await initializeTrustedLocalP11Worktree({
    databaseFile: fixture.databaseFile,
    projectId: project.projectId,
    workspaceId: project.rootWorkspaceId,
    path: fixture.workspaceDirectory,
  });
  if (reconciliationMode !== undefined) {
    writeFileSync(
      join(fixture.workspaceDirectory, evidenceFile),
      `${marker}-proof\n`,
    );
    writeFileSync(
      join(fixture.workspaceDirectory, resultFile),
      `${marker}-result\n`,
    );
  }
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
    `请创建一个等待人工指示后再用 shell 检查工作区的 Work，目标标记 ${marker}。`,
  );
  const approval = await waitForApproval(client, project, marker);
  expect(
    await client.view("current-work", {
      workspaceId: project.rootWorkspaceId,
    }),
  ).toBeNull();
  await client.command(project.projectId, "ResolveControlApproval", {
    approvalId: approval.approvalId,
    expectedRevision: approval.revision,
    decision: "Approve",
    reason: "AH7 public Work admission",
  });
  const currentWork = await waitForPublic(
    () =>
      client.view<{
        workId?: string;
        objective?: string;
        revision: number;
        status: string;
        activeExecution?: { executionId: string };
      } | null>("current-work", {
        workspaceId: project.rootWorkspaceId,
      }),
    (value) =>
      value?.workId !== undefined && value.objective?.includes(marker) === true,
  );
  if (currentWork?.workId === undefined) {
    throw new Error("AH7 public Reconcilable Work was not admitted");
  }
  const workId = currentWork.workId;
  expect(currentWork).toMatchObject({ revision: 0, status: "Open" });
  await waitForPublic(
    async () => ({
      workProviderCalls: ctx.workProviderCalls,
      manualWaitCalls: ctx.manualWaitCalls,
    }),
    (value) => value.workProviderCalls >= 1 && value.manualWaitCalls >= 1,
  );
  const idleWork = await waitForPublic(
    () =>
      client.view<{
        workId?: string;
        revision: number;
        status: string;
        activeExecution?: { executionId: string };
      } | null>("current-work", {
        workspaceId: project.rootWorkspaceId,
      }),
    (value) => value?.workId === workId && value.activeExecution === undefined,
  );
  expect(idleWork).toMatchObject({ workId, revision: 0, status: "Open" });
  expect(ctx.targetProviderCalls).toBe(0);

  await fixture.crash();
  ctx.probeArmed = true;
  await fixture.restart({
    entry: reconciliationMode === undefined ? crashChild : reconciliationChild,
    daemonEnvironment: {
      ARBOR_AH_BOUNDARY: boundary,
      ...(reconciliationMode === undefined
        ? {}
        : {
            ARBOR_AH10_ROLE: "old",
            ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
            ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
            ARBOR_AH7_TEST_CRASH_BOUNDARY: boundary,
            ...(resourceChangeDuringReconcile
              ? { ARBOR_AH7_TEST_RESOURCE_CHANGE_ON_RECONCILE: "1" }
              : {}),
            ...(reconciliationDrift === undefined
              ? {}
              : { ARBOR_AH7_TEST_DRIFT_ON_RECONCILE: reconciliationDrift }),
          }),
    },
  });
  await client.command(project.projectId, "SteerWork", {
    workId,
    workspaceId: project.rootWorkspaceId,
    expectedWorkRevision: 0,
    steer: { severity: "Normal", guidance: steerMarker },
    provenance: { source: "HumanInput" },
  });
  const steeredWork = await waitForPublic(
    () =>
      client.view<{
        workId?: string;
        revision: number;
        status: string;
      } | null>("current-work", {
        workspaceId: project.rootWorkspaceId,
      }),
    (value) => value?.workId === workId && value.revision === 1,
  );
  expect(steeredWork?.status).toBe("Open");

  await steeredShellRequestObserved;
  const activeWorkForPolicy = await waitForPublic(
    () =>
      client.view<{
        readonly workId?: string;
        readonly revision: number;
        readonly activeExecution?: { readonly executionId: string };
      } | null>("current-work", {
        workspaceId: project.rootWorkspaceId,
      }),
    (value) =>
      value?.workId === workId &&
      value.revision === 1 &&
      value.activeExecution?.executionId !== undefined,
  );
  const pregrantedExecutionId =
    activeWorkForPolicy?.activeExecution?.executionId;
  if (pregrantedExecutionId === undefined)
    throw new Error("AH7 current Work omitted the exact active Execution");
  const sandboxPolicyGrantExpiresAt = new Date(
    Date.now() + 60 * 60_000,
  ).toISOString();
  await grantTrustedLocalP11Permission({
    client,
    projectId: project.projectId,
    executionId: pregrantedExecutionId,
    expiresAt: sandboxPolicyGrantExpiresAt,
  });
  releaseSteeredShellResponse();

  const commitCurrentP11Policy = async (executionId: string) => {
    const { snapshot } = await commitTrustedLocalP11Policy({
      client,
      baseUrl: fixture.baseUrl,
      databaseFile: fixture.databaseFile,
      projectId: project.projectId,
      workspaceId: project.rootWorkspaceId,
      executionId,
      expiresAt: sandboxPolicyGrantExpiresAt,
    });
    expect(snapshot).toMatchObject({
      kind: "TrustedLocalUnconfinedV1",
      projectId: project.projectId,
      workspaceId: project.rootWorkspaceId,
      executionId,
      profile: "FullAccess",
    });
  };

  const executableApproval = await waitForExactShellApproval({
    client,
    databaseFile: fixture.databaseFile,
    projectId: project.projectId,
    workspaceId: project.rootWorkspaceId,
    workId,
    controlApprovalId: approval.approvalId,
    marker,
    command,
    sideEffectSemantics: semantics,
    ...(reconciliationMode === undefined ? {} : { timeoutMs: 12_000 }),
  });
  expect(executableApproval.row.execution_id).toBe(pregrantedExecutionId);
  expect(
    await client.command(project.projectId, "ResolveExecutableApproval", {
      approvalId: executableApproval.approvalId,
      expectedRevision: executableApproval.revision,
      decision: "Approve",
      reason: `AH7 public shell approval ${marker}`,
    }),
  ).toMatchObject({ body: { resolution: "Committed" } });

  return Object.assign(ctx, {
    client,
    project,
    workId,
    approval,
    executableApproval,
    sandboxPolicyGrantExpiresAt,
    pregrantedExecutionId,
    commitCurrentP11Policy,
  });
};

export const reachAh7BoundaryAndCrash = async (
  ctx: Ah7AdmittedContext,
): Promise<Ah7CrashContext> => {
  const {
    fixture,
    project,
    workId,
    marker,
    effectFile,
    executableApproval,
    pregrantedExecutionId,
  } = ctx;
  const {
    boundary,
    semantics,
    resumesUnadmittedIntent,
    preserveTakeoverFixtureOnFailure,
  } = ctx.flags;
  let hit: AhProbeHit | undefined;
  let policyCommandDaemonStopped = false;
  if (resumesUnadmittedIntent) {
    hit = await waitForPublic(
      async () =>
        ctx.hits.find(
          (candidate) =>
            candidate.boundary === "AH7AfterToolIntentCommit" &&
            candidate.callRef === executableApproval.row.call_ref,
        ),
      (candidate) => candidate !== undefined,
      15_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH7 exact NotAdmitted P4 boundary absent: ${error instanceof Error ? error.message : String(error)}; targetProviderCalls=${ctx.targetProviderCalls}; latestToolResult=${ctx.latestToolResult}; daemon=${fixture.daemonErrors.join(" | ")}`,
        { cause: error },
      );
    });
    if (hit?.executionId === undefined || hit.invocationId === undefined) {
      throw new Error("AH7 NotAdmitted boundary lacks exact invocation");
    }
    expect(hit.executionId).toBe(pregrantedExecutionId);
    await fixture.crash();
    expect(
      readP4InvocationApprovalBinding(
        fixture.databaseFile,
        hit.executionId,
        hit.invocationId,
      ),
    ).toMatchObject({
      effect_admission_state: "NotAdmitted",
      result_ref: null,
      settlement_kind: null,
    });

    // Command serving is deliberately decoupled from execution dispatch:
    // the startup tick parks the exact NotAdmitted intent on the missing
    // P11 policy, then the long interval prevents admission until the
    // public decision has committed.
    await fixture.restart({
      entry: crashChild,
      daemonEnvironment: {
        ARBOR_AH_BOUNDARY: "disabled",
        ARBOR_TICK_INTERVAL_MS: "3600000",
      },
    });
    await ctx.commitCurrentP11Policy(hit.executionId);
    const parked = durableSnapshot(fixture.databaseFile);
    expect(
      readP4InvocationApprovalBinding(
        fixture.databaseFile,
        hit.executionId,
        hit.invocationId,
      ),
    ).toMatchObject({
      effect_admission_state: "NotAdmitted",
      result_ref: null,
      settlement_kind: null,
    });
    expect(
      parked.actions.filter(
        (action) =>
          action.execution_id === hit?.executionId &&
          action.call_ref === hit?.callRef,
      ),
    ).toEqual([
      expect.objectContaining({
        state: "Pending",
      }),
    ]);
    expect(
      parked.steps.filter(
        (step) =>
          step.execution_id === hit?.executionId && step.logical_step_no === 0,
      ),
    ).toEqual([
      expect.objectContaining({
        state: "ActionsInProgress",
        next_action_index: 0,
      }),
    ]);
    expect(
      parked.toolResults.filter((row) =>
        isToolResultFor(row, hit?.invocationId ?? "", hit?.callRef ?? ""),
      ),
    ).toEqual([]);
    await fixture.crash();
    policyCommandDaemonStopped = true;
  } else {
    await ctx.commitCurrentP11Policy(pregrantedExecutionId);
    try {
      const observed = await waitForPublic(
        async () => ({
          hits: ctx.hits,
          targetProviderCalls: ctx.targetProviderCalls,
        }),
        (value) =>
          value.hits.some((candidate) => candidate.boundary === boundary) ||
          value.targetProviderCalls >= 5,
        30_000,
      );
      hit = observed.hits.find((candidate) => candidate.boundary === boundary);
      if (hit === undefined) {
        throw new Error("provider-call cap reached before shell intent probe");
      }
    } catch (error) {
      throw new Error(
        `AH7 shell intent probe absent: ${error instanceof Error ? error.message : String(error)}; targetProviderCalls=${ctx.targetProviderCalls}; latestToolResult=${ctx.latestToolResult}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    }
  }
  if (!policyCommandDaemonStopped) await fixture.crash();
  const crashed = durableSnapshot(fixture.databaseFile);
  if (
    hit?.executionId === undefined ||
    hit.invocationId === undefined ||
    hit.callRef === undefined
  ) {
    throw new Error("AH7 shell probe lacks exact execution/tool identity");
  }
  const targetExecutionId = hit.executionId;
  const targetCallRef = hit.callRef;
  const targetInvocationId = hit.invocationId;
  if (preserveTakeoverFixtureOnFailure) {
    ctx.failureIdentity = {
      projectId: project.projectId,
      workspaceId: project.rootWorkspaceId,
      executionId: targetExecutionId,
      invocationId: targetInvocationId,
      callRef: targetCallRef,
    };
  }
  const bindingBeforeRecovery = readP39RecoveryBinding(
    fixture.databaseFile,
    targetInvocationId,
  );
  const attemptsBeforeRecovery = readEffectAttempts(
    fixture.databaseFile,
    targetInvocationId,
  );
  const crashedInvocationBinding = readP4InvocationApprovalBinding(
    fixture.databaseFile,
    targetExecutionId,
    hit.invocationId,
  );
  expect(crashedInvocationBinding).toMatchObject({
    invocation_id: hit.invocationId,
    execution_id: targetExecutionId,
    workspace_id: project.rootWorkspaceId,
    tool_name: "shell",
    tool_version: SHELL_DEFINITION.version,
    side_effect_semantics: semantics,
    approval_id: executableApproval.approvalId,
    effect_admission_state:
      boundary === "AH7AfterToolIntentCommit"
        ? "NotAdmitted"
        : "MayHaveStarted",
    result_ref: null,
  });
  expect(
    JSON.parse(crashedInvocationBinding?.arguments_json ?? "null"),
  ).toEqual(JSON.parse(executableApproval.row.arguments_json));
  const approvedResourceIds = JSON.parse(
    executableApproval.row.target_resource_space_ids_json,
  ) as ReadonlyArray<string>;
  const resolvedRegionIds = (
    JSON.parse(
      crashedInvocationBinding?.resolved_regions_json ?? "[]",
    ) as ReadonlyArray<{ readonly resourceSpaceId: string }>
  )
    .map((region) => region.resourceSpaceId)
    .sort();
  expect(resolvedRegionIds).toEqual([...approvedResourceIds].sort());
  const p39RecoveryBinding = readP39RecoveryBinding(
    fixture.databaseFile,
    hit.invocationId,
  );
  if (p39RecoveryBinding === undefined) {
    throw new Error("AH7 P39 recovery binding row absent after intent");
  }
  const canonicalRecoveryBinding = JSON.parse(
    p39RecoveryBinding.canonical_binding_json,
  ) as {
    readonly approvalId: string | null;
    readonly approvalSubject: string | null;
    readonly controlBasisDigest: string;
  };
  expect(canonicalRecoveryBinding).toMatchObject({
    approvalId: executableApproval.approvalId,
    approvalSubject: executableApproval.row.subject_ref,
    controlBasisDigest: executableApproval.row.control_basis_digest,
  });
  expect(canonicalRecoveryBinding.controlBasisDigest).toMatch(
    /^[0-9a-f]{64}$/u,
  );
  expect(p39RecoveryBinding.binding_sha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(
    createHash("sha256")
      .update(p39RecoveryBinding.canonical_binding_json)
      .digest("hex"),
  ).toBe(p39RecoveryBinding.binding_sha256);
  const approvalAtCrash = readExecutableApprovalAfterRecovery(
    fixture.databaseFile,
    executableApproval.approvalId,
    targetExecutionId,
  );
  expect(approvalAtCrash.approval).toMatchObject({
    approval_id: executableApproval.approvalId,
    route_kind: "Executable",
    execution_id: targetExecutionId,
    state: "Consumed",
    consumed_by: hit.invocationId,
    tool_invocation_id: hit.invocationId,
  });
  expect(approvalAtCrash.approvals).toEqual([
    expect.objectContaining({
      approval_id: executableApproval.approvalId,
      state: "Consumed",
      consumed_by: hit.invocationId,
    }),
  ]);
  const crashedActions = crashed.actions.filter(
    (action) => action.execution_id === targetExecutionId,
  );
  const crashedAction = crashedActions.find(
    (action) => action.call_ref === hit.callRef,
  );
  if (
    crashedAction?.logical_action_id === undefined ||
    crashedAction.call_ref === undefined
  ) {
    throw new Error("AH7 crash snapshot lacks exact action identity");
  }
  expect(crashedActions).toHaveLength(1);
  expect(crashedAction.call_ref).toBe(hit.callRef);
  const crashedTarget = readExecutionProviderTurns(
    fixture.databaseFile,
    targetExecutionId,
  );
  const crashedSourceStep = crashed.steps.find(
    (step) =>
      step.execution_id === targetExecutionId &&
      step.logical_step_no === crashedAction.logical_step_no &&
      step.repair_attempt === crashedAction.repair_attempt,
  );
  const originalProviderTurnId = crashedSourceStep?.provider_turn_id;
  if (originalProviderTurnId === undefined) {
    throw new Error("AH7 crash snapshot lacks the source ProviderTurn");
  }
  expect(crashedTarget.execution).toEqual({
    execution_id: targetExecutionId,
    episode_kind: "WorkEpisode",
    episode_ref: workId,
  });
  expect(
    crashed.toolInvocations.filter(
      (invocation) => invocation.execution_id === targetExecutionId,
    ),
  ).toEqual([
    expect.objectContaining({
      invocation_id: hit.invocationId,
      execution_id: targetExecutionId,
      side_effect_semantics: semantics,
      settled_at: null,
    }),
  ]);
  expect(crashedActions).toEqual([
    expect.objectContaining({
      execution_id: targetExecutionId,
      logical_action_id: crashedAction.logical_action_id,
      call_ref: crashedAction.call_ref,
      state: "Pending",
      action_kind: "shell",
    }),
  ]);
  const effectPath = join(fixture.workspaceDirectory, effectFile);
  expect(existsSync(effectPath)).toBe(
    boundary === "AH7AfterToolEffectBeforeSettlement",
  );
  const contentBefore = existsSync(effectPath)
    ? readFileSync(effectPath, "utf8")
    : null;
  if (contentBefore !== null) {
    expect(contentBefore.trim()).toBe(marker);
  }

  const narrowedHit = hit as Ah7CrashContext["hit"];
  const narrowedCrashedAction =
    crashedAction as Ah7CrashContext["crashedAction"];
  return Object.assign(ctx, {
    hit: narrowedHit,
    crashedAction: narrowedCrashedAction,
    targetExecutionId,
    targetCallRef,
    targetInvocationId,
    bindingBeforeRecovery,
    attemptsBeforeRecovery,
    crashed,
    crashedActions,
    crashedTarget,
    crashedSourceStep,
    originalProviderTurnId,
    effectPath,
    contentBefore,
  });
};
