import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SHELL_DEFINITION } from "../../../packages/tool-runtime/src/catalog.js";
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

interface P4FenceProbe {
  readonly tag: "P4_FENCE_PROBE";
  readonly role: "old" | "new";
  readonly boundary: string;
  readonly executionId: string;
  readonly invocationId?: string;
  readonly callRef?: string;
  readonly fencingGeneration?: number;
  readonly logicalActionId?: string;
  readonly actionIndex?: number;
  readonly providerTurnId?: string;
  readonly errorTag?: string;
}

interface LeaseRow {
  readonly execution_id: string;
  readonly generation: number;
  readonly expires_at: string;
}

interface InvocationRow {
  readonly invocation_id: string;
  readonly execution_id: string;
  readonly approval_id: string | null;
  readonly tool_name: string;
  readonly tool_version: string;
  readonly side_effect_semantics: string;
  readonly arguments_json: string;
  readonly resolved_regions_json: string;
  readonly result_ref: string | null;
  readonly effect_admission_state: string;
  readonly settlement_json: string | null;
  readonly settled_at: string | null;
  readonly settlement_kind: string | null;
}

interface ToolResultRow {
  readonly payload_json: string;
  readonly source_kind: string | null;
  readonly source_ref: string | null;
}

interface ActionRow {
  readonly call_ref: string;
  readonly state: string;
  readonly observation_source_ref: string | null;
}

interface ExecutableApprovalBindingRow {
  readonly approval_id: string;
  readonly route_kind: string;
  readonly project_id: string;
  readonly workspace_id: string;
  readonly execution_id: string;
  readonly subject_ref: string;
  readonly stable_action_id: string;
  readonly action_version: string;
  readonly side_effect_semantics: string;
  readonly arguments_json: string;
  readonly target_resource_space_ids_json: string;
  readonly control_basis_digest: string;
  readonly state: string;
  readonly revision: number;
  readonly binding_proven: number;
  readonly logical_step_no: number;
  readonly repair_attempt: number;
  readonly action_index: number;
  readonly logical_action_id: string;
  readonly call_ref: string;
  readonly tool_invocation_id: string;
  readonly episode_kind: string | null;
  readonly episode_ref: string | null;
  readonly episode_revision: number | null;
  readonly provider_turn_id: string;
  readonly action_state: string;
  readonly action_kind: string;
  readonly action_call_ref: string;
}

const fixtures: ProductionFixture[] = [];
const fenceChild = resolve(
  "tests/functional/support/p4-tool-lease-fencing-child.mjs",
);

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const recordProbe = (events: P4FenceProbe[], line: string) => {
  try {
    const probe = JSON.parse(line) as P4FenceProbe;
    if (probe.tag === "P4_FENCE_PROBE") events.push(probe);
  } catch {
    // Daemon diagnostics remain available from ProductionFixture on failure.
  }
};

const p3ToolResultsForCall = (
  rows: ReadonlyArray<ToolResultRow>,
  callRef: string,
) =>
  rows.flatMap((row) => {
    try {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      return payload.callRef === callRef ? [{ row, payload }] : [];
    } catch {
      return [];
    }
  });

const rowsFor = (
  databaseFile: string,
  executionId: string,
  invocationId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      lease: db
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases WHERE execution_id = ?",
        )
        .get(executionId) as LeaseRow | undefined,
      invocation: db
        .prepare(
          `SELECT invocation_id, execution_id, approval_id, tool_name,
                  tool_version, side_effect_semantics, arguments_json,
                  resolved_regions_json, result_ref, effect_admission_state,
                  settlement_json, settled_at, settlement_kind
             FROM tool_invocations WHERE execution_id = ?
            ORDER BY intent_at DESC LIMIT 1`,
        )
        .get(executionId) as InvocationRow | undefined,
      execution: db
        .prepare(
          "SELECT settlement_kind, settlement_json, settled_at FROM executions WHERE execution_id = ?",
        )
        .get(executionId) as
        | {
            settlement_kind: string | null;
            settlement_json: string | null;
            settled_at: string | null;
          }
        | undefined,
      action: db
        .prepare(
          `SELECT call_ref, state, observation_source_ref
             FROM agent_loop_step_actions
            WHERE execution_id = ? ORDER BY action_index DESC LIMIT 1`,
        )
        .get(executionId) as ActionRow | undefined,
      toolResults: db
        .prepare(
          `SELECT se.payload_json, se.source_kind, se.source_ref
             FROM session_entries se
             JOIN executions e ON e.session_id = se.session_id
            WHERE e.execution_id = ? AND se.item_type = 'ToolResult'
            ORDER BY se.sequence`,
        )
        .all(executionId) as unknown as Array<ToolResultRow>,
      successfulObservations: db
        .prepare(
          `SELECT payload_json FROM session_entries
            WHERE source_kind = 'AgentLoopAction'
              AND item_type = 'ToolResult'
              AND json_extract(payload_json, '$.invocationId') = ?
              AND json_extract(payload_json, '$.status') = 'Succeeded'`,
        )
        .all(invocationId) as Array<{ readonly payload_json: string }>,
    };
  } finally {
    db.close();
  }
};

const readExecutableApprovalBinding = (
  databaseFile: string,
  approvalId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT a.approval_id, a.route_kind, a.project_id, a.workspace_id,
                a.execution_id, a.subject_ref, a.stable_action_id,
                a.action_version, a.side_effect_semantics, a.arguments_json,
                a.target_resource_space_ids_json, a.control_basis_digest,
                a.state, a.revision, a.binding_proven, a.logical_step_no,
                a.repair_attempt, a.action_index, a.logical_action_id,
                a.call_ref, a.tool_invocation_id, e.episode_kind, e.episode_ref,
                e.episode_revision, s.provider_turn_id,
                x.state AS action_state,
                x.action_kind, x.call_ref AS action_call_ref
           FROM action_approvals a
           JOIN executions e ON e.execution_id = a.execution_id
           JOIN agent_loop_step_actions x
             ON x.execution_id = a.execution_id
            AND x.logical_step_no = a.logical_step_no
            AND x.repair_attempt = a.repair_attempt
            AND x.action_index = a.action_index
            AND x.logical_action_id = a.logical_action_id
           JOIN agent_loop_steps s
             ON s.execution_id = a.execution_id
            AND s.logical_step_no = a.logical_step_no
            AND s.repair_attempt = a.repair_attempt
          WHERE a.approval_id = ? AND a.route_kind = 'Executable'
            AND a.binding_proven = 1`,
      )
      .get(approvalId) as ExecutableApprovalBindingRow | undefined;
    if (row === undefined) {
      throw new Error(`P4 fence Executable approval ${approvalId} is absent`);
    }
    const executableApprovalCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM action_approvals
              WHERE execution_id = ? AND route_kind = 'Executable'
                AND binding_proven = 1`,
          )
          .get(row.execution_id) as { readonly count: number }
      ).count,
    );
    return { row, executableApprovalCount };
  } finally {
    db.close();
  }
};

const readApprovalSubjectRoute = (databaseFile: string, approvalId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT route_kind, state, consumed_by, control_basis_digest
           FROM action_approvals WHERE approval_id = ?`,
      )
      .get(approvalId) as
      | {
          readonly route_kind: string;
          readonly state: string;
          readonly consumed_by: string | null;
          readonly control_basis_digest: string;
        }
      | undefined;
  } finally {
    db.close();
  }
};

const readP39BindingForInvocation = (
  databaseFile: string,
  invocationId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT canonical_binding_json, binding_sha256
           FROM tool_invocation_recovery_bindings WHERE invocation_id = ?`,
      )
      .get(invocationId) as
      | {
          readonly canonical_binding_json: string;
          readonly binding_sha256: string;
        }
      | undefined;
  } finally {
    db.close();
  }
};

describe("P4 ToolInvocation settlement under P2 lease takeover", () => {
  it("fences an old generation after its non-idempotent effect and before settlement", async () => {
    const marker = `P4-LEASE-${crypto.randomUUID().slice(0, 8)}`;
    const steerMarker = `P4-LEASE-STEER-${crypto.randomUUID().slice(0, 8)}`;
    const effectMarker = `P4_EFFECT_${marker}`;
    const effectFile = `p4-lease-${marker}.txt`;
    const command =
      process.platform === "win32"
        ? `Add-Content -LiteralPath '${effectFile}' -Value '${effectMarker}'`
        : `printf '%s\\n' '${effectMarker}' >> '${effectFile}'`;
    const events: P4FenceProbe[] = [];
    let manualWaitCalls = 0;
    let targetToolCalls = 0;
    const fixture = await startProductionFixture({
      admitWorkspaceDirectory: true,
      firstDaemonEntry: fenceChild,
      daemonEnvironment: {
        ARBOR_P4_FENCE_ROLE: "old",
        ARBOR_P4_FENCE_NON_IDEMPOTENT: "1",
      },
      onDaemonStdout: (line) => recordProbe(events, line),
      reply: (call) => {
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        const context = JSON.stringify(call.messages);
        if (
          available.has("assign_work") &&
          !available.has("claim_completion") &&
          context.includes(marker)
        ) {
          return context.includes("WorkAssigned(")
            ? { _tag: "Text", text: `Work admitted for ${marker}` }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Wait for a steer, then append ${effectMarker} once with shell.`,
                  why: "qualify stale P4 settlement fencing",
                  constraints: [],
                  completionExpectation: "the shell effect occurs at most once",
                  verificationMission: {
                    goal: `Verify the one-time effect ${marker}`,
                    criteria: [
                      {
                        criterionId: "one-effect",
                        requirement: `${effectFile} contains ${effectMarker} once`,
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "P4/P2 lease fencing qualification",
                },
              };
        }
        if (
          available.has("claim_completion") &&
          available.has("shell") &&
          context.includes(marker)
        ) {
          if (!context.includes(steerMarker)) {
            manualWaitCalls += 1;
            return {
              _tag: "ToolCall",
              name: "wait",
              arguments: {
                reason: `wait for ${steerMarker}`,
                waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
              },
            };
          }
          targetToolCalls += 1;
          if (targetToolCalls > 4) {
            return { _tag: "HttpError", status: 429 };
          }
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
    });
    fixtures.push(fixture);

    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "P4 stale tool settlement fence",
      { resourceSelection: "Profile" },
    );
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
      `请创建一个等待人工指示后执行一次shell写入的Work，目标标记 ${marker}。`,
    );
    const approval = await waitForApproval(client, project, marker);
    await client.command(project.projectId, "ResolveControlApproval", {
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: "Approve",
      reason: "P4/P2 stale settlement qualification",
    });

    const currentWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
          objective?: string;
        } | null>("current-work", {
          workspaceId: project.rootWorkspaceId,
        }),
      (value) =>
        value?.workId !== undefined &&
        value.objective?.includes(marker) === true,
    );
    if (currentWork === null || currentWork.workId === undefined) {
      throw new Error("P4 lease-fencing Work was not publicly admitted");
    }
    await waitForPublic(
      async () => ({ manualWaitCalls }),
      (value) => value.manualWaitCalls > 0,
    );
    const idleWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
          activeExecution?: { executionId: string };
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (value) =>
        value !== null &&
        value.workId === currentWork.workId &&
        value.activeExecution === undefined,
    );
    if (idleWork === null || idleWork.workId === undefined) {
      throw new Error("P4 lease-fencing Work did not reach its Manual wait");
    }
    const workId = idleWork.workId;
    await client.command(project.projectId, "SteerWork", {
      workId: idleWork.workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: idleWork.revision,
      steer: { severity: "Normal", guidance: `Proceed with ${steerMarker}.` },
      provenance: { source: "HumanInput" },
    });

    const executableApproval = await waitForExecutableApproval(
      client,
      project.rootWorkspaceId,
      marker,
      60_000,
    );
    const approvalBinding = readExecutableApprovalBinding(
      fixture.databaseFile,
      executableApproval.approvalId,
    );
    expect(approvalBinding.row).toMatchObject({
      approval_id: executableApproval.approvalId,
      route_kind: "Executable",
      project_id: project.projectId,
      workspace_id: project.rootWorkspaceId,
      subject_ref: "runtime:system",
      stable_action_id: "shell",
      action_version: SHELL_DEFINITION.version,
      side_effect_semantics: "NonIdempotent",
      state: "Pending",
      revision: executableApproval.revision,
      binding_proven: 1,
      episode_kind: "WorkEpisode",
      episode_ref: workId,
      episode_revision: idleWork.revision + 1,
      action_state: "Pending",
      action_kind: "shell",
      action_call_ref: approvalBinding.row.call_ref,
    });
    expect(JSON.parse(approvalBinding.row.arguments_json)).toEqual({
      command,
      cwd: { mount: "workspace", path: "." },
      timeoutMs: 5_000,
    });
    expect(approvalBinding.row.control_basis_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      JSON.parse(approvalBinding.row.target_resource_space_ids_json),
    ).toEqual(["filesystem"]);
    expect(approvalBinding.row.logical_action_id).toMatch(/^lac_/u);
    expect(approvalBinding.row.call_ref).toMatch(/^call_/u);
    expect(approvalBinding.row.tool_invocation_id).toMatch(/^tin_/u);
    expect(approvalBinding.executableApprovalCount).toBe(1);
    const workApprovalRoute = readApprovalSubjectRoute(
      fixture.databaseFile,
      approval.approvalId,
    );
    expect(workApprovalRoute?.route_kind).toBe("Control");
    expect(workApprovalRoute?.control_basis_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(approval.approvalId).not.toBe(executableApproval.approvalId);
    expect(
      await client.command(project.projectId, "ResolveExecutableApproval", {
        approvalId: executableApproval.approvalId,
        expectedRevision: executableApproval.revision,
        decision: "Approve",
        reason: `P4/P2 exact shell approval ${marker}`,
      }),
    ).toMatchObject({ body: { resolution: "Committed" } });

    const oldEffect = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7AfterToolEffectBeforeSettlement",
        ),
      (event) => event !== undefined,
      45_000,
    );
    if (
      oldEffect === undefined ||
      oldEffect.executionId === undefined ||
      oldEffect.invocationId === undefined ||
      oldEffect.callRef === undefined
    ) {
      throw new Error("Old generation did not expose its post-effect boundary");
    }
    const oldExecutionId = oldEffect.executionId;
    const oldInvocationId = oldEffect.invocationId;
    expect(oldEffect.fencingGeneration).toBeUndefined();
    const oldOwnerRows = rowsFor(
      fixture.databaseFile,
      oldExecutionId,
      oldInvocationId,
    );
    const oldLeaseAtEffect = oldOwnerRows.lease;
    if (oldLeaseAtEffect === undefined) {
      throw new Error(
        "Old P4 owner has no durable lease at its effect boundary",
      );
    }
    const oldGeneration = oldLeaseAtEffect.generation;
    expect(Number.isSafeInteger(oldGeneration)).toBe(true);
    expect(oldGeneration).toBeGreaterThanOrEqual(1);
    expect(oldOwnerRows.invocation).toMatchObject({
      invocation_id: oldInvocationId,
      execution_id: oldExecutionId,
      approval_id: executableApproval.approvalId,
      tool_name: "shell",
      tool_version: SHELL_DEFINITION.version,
      side_effect_semantics: "NonIdempotent",
      arguments_json: approvalBinding.row.arguments_json,
      result_ref: null,
      settled_at: null,
      settlement_kind: null,
    });
    const approvedResourceIds = JSON.parse(
      approvalBinding.row.target_resource_space_ids_json,
    ) as ReadonlyArray<string>;
    const resolvedResourceIds = (
      JSON.parse(
        oldOwnerRows.invocation?.resolved_regions_json ?? "[]",
      ) as ReadonlyArray<{ readonly resourceSpaceId: string }>
    )
      .map((region) => region.resourceSpaceId)
      .sort();
    expect(resolvedResourceIds).toEqual([...approvedResourceIds].sort());
    const p39Binding = readP39BindingForInvocation(
      fixture.databaseFile,
      oldInvocationId,
    );
    if (p39Binding === undefined) {
      throw new Error("P4 fence P39 recovery binding is absent after intent");
    }
    const canonicalBinding = JSON.parse(p39Binding.canonical_binding_json) as {
      readonly approvalId: string | null;
      readonly approvalSubject: string | null;
      readonly controlBasisDigest: string;
    };
    expect(canonicalBinding).toMatchObject({
      approvalId: executableApproval.approvalId,
      approvalSubject: approvalBinding.row.subject_ref,
      controlBasisDigest: approvalBinding.row.control_basis_digest,
    });
    expect(canonicalBinding.controlBasisDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(p39Binding.binding_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      createHash("sha256")
        .update(p39Binding.canonical_binding_json)
        .digest("hex"),
    ).toBe(p39Binding.binding_sha256);
    const consumedExecutableApproval = readApprovalSubjectRoute(
      fixture.databaseFile,
      executableApproval.approvalId,
    );
    expect(consumedExecutableApproval).toMatchObject({
      route_kind: "Executable",
      state: "Consumed",
      consumed_by: oldInvocationId,
      control_basis_digest: approvalBinding.row.control_basis_digest,
    });
    expect(
      readExecutableApprovalBinding(
        fixture.databaseFile,
        executableApproval.approvalId,
      ).executableApprovalCount,
    ).toBe(1);
    expect(
      readFileSync(join(fixture.workspaceDirectory, effectFile), "utf8")
        .split(/\r?\n/u)
        .filter((line) => line === effectMarker),
    ).toHaveLength(1);

    mkdirSync(join(fixture.directory, "p4-fence-gates"), { recursive: true });
    writeFileSync(
      join(fixture.directory, "p4-fence-gates", "old-freeze-renewal.request"),
      "pause renewal before takeover",
    );
    const oldRenewal = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH10BeforeLeaseRenewal" &&
            event.executionId === oldExecutionId,
        ),
      (event) => event !== undefined,
      20_000,
    );
    expect(oldRenewal?.fencingGeneration).toBe(oldGeneration);

    const leaseDb = new DatabaseSync(fixture.databaseFile);
    try {
      const lease = leaseDb
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases WHERE execution_id = ?",
        )
        .get(oldExecutionId) as LeaseRow | undefined;
      expect(lease).toMatchObject({
        execution_id: oldExecutionId,
        generation: oldGeneration,
      });
      const expired = leaseDb
        .prepare(
          "UPDATE execution_leases SET expires_at = ? WHERE execution_id = ? AND generation = ?",
        )
        .run("2000-01-01T00:00:00.000Z", oldExecutionId, oldGeneration);
      expect(Number(expired.changes)).toBe(1);
    } finally {
      leaseDb.close();
    }

    const newDaemon = await fixture.startAdditionalDaemon({
      entry: fenceChild,
      daemonEnvironment: {
        ARBOR_P4_FENCE_ROLE: "new",
        ARBOR_P4_FENCE_NON_IDEMPOTENT: "1",
        ARBOR_P4_FENCE_PAUSE_NEW: "1",
      },
      onStdout: (line) => recordProbe(events, line),
    });
    const newLease = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH10AfterLeaseAcquired" &&
            event.executionId === oldExecutionId,
        ),
      (event) => event !== undefined,
      45_000,
    );
    expect(newLease?.fencingGeneration).toBe(oldGeneration + 1);

    writeFileSync(
      join(fixture.directory, "p4-fence-gates", "old-tool-effect.release"),
      "release old P4 owner",
    );
    const oldSettlement = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.executionId === oldExecutionId &&
            event.invocationId === oldInvocationId &&
            event.callRef === approvalBinding.row.call_ref &&
            (event.boundary === "AH7ToolSettlementFenceRejected" ||
              (event.boundary === "P4ExecutableToolRuntimeOutcome" &&
                event.errorTag === "LeaseFencingRejected" &&
                event.logicalActionId ===
                  approvalBinding.row.logical_action_id &&
                event.actionIndex === approvalBinding.row.action_index &&
                event.providerTurnId === approvalBinding.row.provider_turn_id)),
        ),
      (event) => event !== undefined,
      20_000,
    ).catch((error: unknown) => {
      throw new Error(
        `Old generation settlement-fence probe absent: ${error instanceof Error ? error.message : String(error)}; oldGeneration=${oldGeneration}; events=${JSON.stringify(events.slice(-12))}; oldDaemon=${fixture.daemonErrors.join(" | ")}; newDaemon=${newDaemon.daemonErrors.join(" | ")}; rows=${JSON.stringify(rowsFor(fixture.databaseFile, oldExecutionId, oldInvocationId))}`,
      );
    });

    const beforeNewDrive = rowsFor(
      fixture.databaseFile,
      oldExecutionId,
      oldInvocationId,
    );
    // The stale old generation may be rejected either at the P4 store
    // settlement write or at the fenced P4 invocation lookup immediately
    // before that write. The latter is the expected point after P38 approval
    // resume has already advanced the old owner to G_old.
    const oldFenceRejectedAtP4Settlement =
      oldSettlement?.boundary === "AH7ToolSettlementFenceRejected" ||
      (oldSettlement?.boundary === "P4ExecutableToolRuntimeOutcome" &&
        oldSettlement.errorTag === "LeaseFencingRejected" &&
        oldSettlement.logicalActionId ===
          approvalBinding.row.logical_action_id &&
        oldSettlement.actionIndex === approvalBinding.row.action_index &&
        oldSettlement.providerTurnId === approvalBinding.row.provider_turn_id);
    expect.soft(oldFenceRejectedAtP4Settlement).toBe(true);
    expect.soft(beforeNewDrive.invocation).toMatchObject({
      invocation_id: oldEffect.invocationId,
      approval_id: executableApproval.approvalId,
      settled_at: null,
      settlement_kind: null,
    });
    expect.soft(beforeNewDrive.successfulObservations).toEqual([]);
    expect(
      readFileSync(join(fixture.workspaceDirectory, effectFile), "utf8")
        .split(/\r?\n/u)
        .filter((line) => line === effectMarker),
    ).toHaveLength(1);
    expect(
      rowsFor(fixture.databaseFile, oldExecutionId, oldInvocationId)
        .successfulObservations,
    ).toEqual([]);
    expect(
      rowsFor(fixture.databaseFile, oldExecutionId, oldInvocationId).lease,
    ).toMatchObject({ generation: oldGeneration + 1 });

    writeFileSync(
      join(fixture.directory, "p4-fence-gates", "new-new-driver.release"),
      "release current generation",
    );
    const afterCurrentDrive = await waitForPublic(
      async () =>
        rowsFor(fixture.databaseFile, oldExecutionId, oldInvocationId),
      (value) =>
        value.invocation?.effect_admission_state === "MayHaveStarted" &&
        value.invocation.settled_at === null &&
        value.invocation.settlement_kind === null &&
        value.invocation.result_ref === null &&
        value.execution?.settlement_kind === "OutcomeUnknown" &&
        value.execution.settled_at !== null &&
        value.action?.state === "ReconciliationPending" &&
        p3ToolResultsForCall(value.toolResults, oldEffect.callRef ?? "")
          .length === 1,
      45_000,
    );
    expect(afterCurrentDrive.invocation).toMatchObject({
      invocation_id: oldInvocationId,
      execution_id: oldExecutionId,
      approval_id: executableApproval.approvalId,
      tool_name: "shell",
      side_effect_semantics: "NonIdempotent",
      effect_admission_state: "MayHaveStarted",
      result_ref: null,
      settled_at: null,
      settlement_kind: null,
      settlement_json: null,
    });
    expect(afterCurrentDrive.execution?.settlement_kind).toBe("OutcomeUnknown");
    expect(
      JSON.parse(String(afterCurrentDrive.execution?.settlement_json)),
    ).toEqual({
      _tag: "OutcomeUnknown",
      reconciliation: {
        _tag: "ReconciliationRequired",
        invocationRefs: [oldInvocationId],
      },
    });
    expect(afterCurrentDrive.action).toMatchObject({
      call_ref: oldEffect.callRef,
      state: "ReconciliationPending",
    });
    const unresolvedResults = p3ToolResultsForCall(
      afterCurrentDrive.toolResults,
      oldEffect.callRef ?? "",
    );
    expect(unresolvedResults).toHaveLength(1);
    expect(unresolvedResults[0]?.row.source_kind).toBe("AgentLoopAction");
    expect(unresolvedResults[0]?.payload).toMatchObject({
      _tag: "ToolResult",
      callRef: oldEffect.callRef,
      toolName: "shell",
      status: "OutcomeUnknown",
      artifactRefs: [],
      truncated: false,
    });
    expect(unresolvedResults[0]?.payload).not.toHaveProperty("canonicalRefs");
    expect(unresolvedResults[0]?.payload).not.toHaveProperty("resultRef");
    expect(unresolvedResults[0]?.payload).not.toHaveProperty("invocationId");
    expect(unresolvedResults[0]?.row.source_ref).toBe(
      afterCurrentDrive.action?.observation_source_ref,
    );
    expect(afterCurrentDrive.successfulObservations).toEqual([]);
    expect(
      readFileSync(join(fixture.workspaceDirectory, effectFile), "utf8")
        .split(/\r?\n/u)
        .filter((line) => line === effectMarker),
    ).toHaveLength(1);
    expect(targetToolCalls).toBe(1);
    const finalApprovalState = readApprovalSubjectRoute(
      fixture.databaseFile,
      executableApproval.approvalId,
    );
    expect(finalApprovalState).toMatchObject({
      route_kind: "Executable",
      state: "Consumed",
      consumed_by: oldInvocationId,
      control_basis_digest: approvalBinding.row.control_basis_digest,
    });
    expect(fixture.daemonErrors).toEqual([]);
    expect(newDaemon.daemonErrors).toEqual([]);
  }, 180_000);
});
