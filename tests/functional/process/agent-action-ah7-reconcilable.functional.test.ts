import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHELL_DEFINITION } from "../../../packages/tool-runtime/src/catalog.js";
import { durableSnapshot } from "../support/ah-durable-snapshot.js";
import {
  type AhProbeHit,
  recordAhProbeLine,
} from "../support/ah-probe-line.js";
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

const fixtures: ProductionFixture[] = [];
const crashChild = resolve("tests/functional/support/ah-crash-child.mjs");
const reconciliationChild = resolve(
  "tests/functional/support/ah10-process-child.mjs",
);
const readExecutionProviderTurns = (
  databaseFile: string,
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const execution = db
      .prepare(
        "SELECT execution_id, episode_kind, episode_ref FROM executions WHERE execution_id = ?",
      )
      .get(executionId) as
      | {
          execution_id: string;
          episode_kind: string;
          episode_ref: string;
        }
      | undefined;
    const providerTurns = db
      .prepare(
        "SELECT provider_turn_id, execution_id, settled_at, finish_reason FROM provider_turns WHERE execution_id = ? ORDER BY provider_turn_id",
      )
      .all(executionId) as Array<{
      provider_turn_id: string;
      execution_id: string;
      settled_at: string | null;
      finish_reason: string | null;
    }>;
    return { execution, providerTurns };
  } finally {
    db.close();
  }
};

const isToolResultFor = (
  row: Readonly<Record<string, unknown>>,
  invocationId: string,
  callRef: string,
): boolean => {
  try {
    const payload = JSON.parse(String(row.payload_json)) as {
      readonly invocationId?: unknown;
      readonly callRef?: unknown;
    };
    return payload.invocationId === invocationId && payload.callRef === callRef;
  } catch {
    return false;
  }
};

const readToolResultForCall = (
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  callRef: string,
) =>
  rows
    .map((row) => {
      try {
        return {
          row,
          payload: JSON.parse(String(row.payload_json)) as Record<
            string,
            unknown
          >,
        };
      } catch {
        return undefined;
      }
    })
    .find((candidate) => candidate?.payload.callRef === callRef);

interface ExecutableApprovalQualification {
  readonly approvalId: string;
  readonly revision: number;
  readonly row: {
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
    readonly action_state: string;
    readonly action_kind: string;
    readonly action_call_ref: string;
    readonly input_hash: string;
  };
}

const waitForExactShellApproval = async (input: {
  readonly client: ReturnType<typeof makePublicClient>;
  readonly databaseFile: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly workId: string;
  readonly controlApprovalId: string;
  readonly marker: string;
  readonly command: string;
  readonly sideEffectSemantics: string;
  readonly timeoutMs?: number;
}): Promise<ExecutableApprovalQualification> => {
  const publicEntry = await waitForExecutableApproval(
    input.client,
    input.workspaceId,
    input.marker,
    input.timeoutMs ?? 60_000,
  );
  const { approvalId, revision } = publicEntry;
  const db = new DatabaseSync(input.databaseFile, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT a.approval_id, a.route_kind, a.project_id, a.workspace_id,
                a.subject_ref,
                a.execution_id, a.stable_action_id, a.action_version,
                a.side_effect_semantics, a.arguments_json,
                a.target_resource_space_ids_json, a.control_basis_digest,
                a.state, a.revision,
                a.binding_proven, a.logical_step_no, a.repair_attempt,
                a.action_index, a.logical_action_id, a.call_ref,
                a.tool_invocation_id, e.episode_kind, e.episode_ref,
                e.episode_revision, x.state AS action_state,
                x.action_kind, x.call_ref AS action_call_ref, x.input_hash
           FROM action_approvals a
           JOIN executions e ON e.execution_id = a.execution_id
           JOIN agent_loop_step_actions x
             ON x.execution_id = a.execution_id
            AND x.logical_step_no = a.logical_step_no
            AND x.repair_attempt = a.repair_attempt
            AND x.action_index = a.action_index
            AND x.logical_action_id = a.logical_action_id
          WHERE a.approval_id = ? AND a.route_kind = 'Executable'
            AND a.binding_proven = 1`,
      )
      .get(approvalId) as ExecutableApprovalQualification["row"] | undefined;
    if (row === undefined) {
      throw new Error(
        `AH7 public EAP ${approvalId} had no exact durable P38 binding`,
      );
    }
    const expectedArguments = {
      command: input.command,
      cwd: { mount: "workspace", path: "." },
      timeoutMs: 5_000,
    };
    expect(row).toMatchObject({
      approval_id: approvalId,
      route_kind: "Executable",
      project_id: input.projectId,
      workspace_id: input.workspaceId,
      subject_ref: "runtime:system",
      stable_action_id: "shell",
      action_version: SHELL_DEFINITION.version,
      side_effect_semantics: input.sideEffectSemantics,
      control_basis_digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      state: "Pending",
      revision,
      binding_proven: 1,
      episode_kind: "WorkEpisode",
      episode_ref: input.workId,
      episode_revision: 1,
      action_state: "Pending",
      action_kind: "shell",
      action_call_ref: row.call_ref,
      input_hash: createHash("sha256").update(row.arguments_json).digest("hex"),
    });
    expect(JSON.parse(row.arguments_json)).toEqual(expectedArguments);
    const targetResourceSpaceIds = JSON.parse(
      row.target_resource_space_ids_json,
    ) as unknown;
    expect(targetResourceSpaceIds).toEqual(["filesystem"]);
    expect(row.logical_action_id).toMatch(/^lac_/u);
    expect(row.call_ref).toMatch(/^call_/u);
    expect(row.tool_invocation_id).toMatch(/^tin_/u);
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
    const controlApproval = db
      .prepare("SELECT route_kind FROM action_approvals WHERE approval_id = ?")
      .get(input.controlApprovalId) as
      | { readonly route_kind: string }
      | undefined;
    expect(executableApprovalCount).toBe(1);
    expect(controlApproval).toEqual({ route_kind: "Control" });
    expect(input.controlApprovalId).not.toBe(approvalId);
    return { approvalId, revision, row };
  } finally {
    db.close();
  }
};

const readExecutableApprovalAfterRecovery = (
  databaseFile: string,
  approvalId: string,
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const approval = db
      .prepare(
        `SELECT approval_id, route_kind, execution_id, state, revision,
                consumed_at, consumed_by, tool_invocation_id,
                target_resource_space_ids_json
           FROM action_approvals WHERE approval_id = ?`,
      )
      .get(approvalId) as
      | {
          readonly approval_id: string;
          readonly route_kind: string;
          readonly execution_id: string;
          readonly state: string;
          readonly revision: number;
          readonly consumed_at: string | null;
          readonly consumed_by: string | null;
          readonly tool_invocation_id: string;
          readonly target_resource_space_ids_json: string;
        }
      | undefined;
    const approvals = db
      .prepare(
        `SELECT approval_id, state, consumed_by FROM action_approvals
          WHERE execution_id = ? AND route_kind = 'Executable'
            AND binding_proven = 1`,
      )
      .all(executionId) as Array<{
      readonly approval_id: string;
      readonly state: string;
      readonly consumed_by: string | null;
    }>;
    if (approval === undefined) throw new Error("AH7 EAP row disappeared");
    return { approval, approvals };
  } finally {
    db.close();
  }
};

const readP4InvocationApprovalBinding = (
  databaseFile: string,
  executionId: string,
  invocationId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT invocation_id, execution_id, workspace_id, tool_name,
                tool_version, side_effect_semantics, arguments_json,
                resolved_regions_json, approval_id, effect_admission_state,
                result_ref, settlement_kind, settled_at,
                settlement_json,
                recovery_binding_sha256, settlement_provenance,
                selected_attempt_no, selected_fact_id,
                observation_format_version, observation_json,
                observation_sha256
           FROM tool_invocations WHERE execution_id = ? AND invocation_id = ?`,
      )
      .get(executionId, invocationId) as
      | {
          readonly invocation_id: string;
          readonly execution_id: string;
          readonly workspace_id: string;
          readonly tool_name: string;
          readonly tool_version: string;
          readonly side_effect_semantics: string;
          readonly arguments_json: string;
          readonly resolved_regions_json: string;
          readonly approval_id: string | null;
          readonly effect_admission_state: string;
          readonly result_ref: string | null;
          readonly settlement_kind: string | null;
          readonly settled_at: string | null;
          readonly settlement_json: string | null;
          readonly recovery_binding_sha256: string | null;
          readonly settlement_provenance: string | null;
          readonly selected_attempt_no: number | null;
          readonly selected_fact_id: string | null;
          readonly observation_format_version: string | null;
          readonly observation_json: Uint8Array | null;
          readonly observation_sha256: string | null;
        }
      | undefined;
  } finally {
    db.close();
  }
};

const readP39RecoveryBinding = (databaseFile: string, invocationId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT canonical_binding_json, binding_sha256
           FROM tool_invocation_recovery_bindings
          WHERE invocation_id = ?`,
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

const readReconciliationFacts = (
  databaseFile: string,
  invocationId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT fact_id, attempt_no, outcome, reason_code, evidence_ref,
                result_ref, fact_disposition
           FROM tool_reconciliation_facts WHERE invocation_id = ?
          ORDER BY attempt_no, fact_id`,
      )
      .all(invocationId) as Array<{
      readonly fact_id: string;
      readonly attempt_no: number;
      readonly outcome: string;
      readonly reason_code: string | null;
      readonly evidence_ref: string | null;
      readonly result_ref: string | null;
      readonly fact_disposition: string;
    }>;
  } finally {
    db.close();
  }
};

const readEffectAttempts = (databaseFile: string, invocationId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT attempt_no, admission_state, effect_key, profile_id,
                profile_version, profile_hash, binding_sha256
           FROM tool_invocation_effect_attempts WHERE invocation_id = ?
          ORDER BY attempt_no`,
      )
      .all(invocationId) as Array<{
      readonly attempt_no: number;
      readonly admission_state: string;
      readonly effect_key: string | null;
      readonly profile_id: string | null;
      readonly profile_version: string | null;
      readonly profile_hash: string | null;
      readonly binding_sha256: string;
    }>;
  } finally {
    db.close();
  }
};

const readTestExternalEffects = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT effect_key, result_ref FROM ah7_test_external_effects ORDER BY effect_key",
      )
      .all() as Array<{
      readonly effect_key: string;
      readonly result_ref: string | null;
    }>;
  } finally {
    db.close();
  }
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("AH7 Reconcilable tool intent after process crash", () => {
  vi.setConfig({ testTimeout: 180_000 });
  for (const scenario of [
    {
      boundary: "AH7AfterToolIntentCommit",
      semantics: "Reconcilable",
    },
    {
      boundary: "AH7AfterToolEffectBeforeSettlement",
      semantics: "Reconcilable",
    },
    {
      boundary: "AH7AfterToolEffectBeforeSettlement",
      semantics: "NonIdempotent",
    },
    {
      boundary: "AH7AfterEffectAdmissionCommit",
      semantics: "Reconcilable",
      reconciliationMode: "NotOccurred",
    },
    {
      boundary: "AH7AfterEffectAdmissionCommit",
      semantics: "Reconcilable",
      reconciliationMode: "NotOccurred",
      resourceChangeDuringReconcile: true,
    },
    {
      boundary: "AH7AfterToolEffectBeforeSettlement",
      semantics: "Reconcilable",
      reconciliationMode: "Occurred",
    },
    {
      boundary: "AH7AfterEffectAdmissionCommit",
      semantics: "Reconcilable",
      reconciliationMode: "StillUnknown",
    },
  ] as const) {
    const {
      boundary,
      semantics,
      reconciliationMode,
      resourceChangeDuringReconcile,
    } = scenario;
    const testName =
      reconciliationMode !== undefined
        ? resourceChangeDuringReconcile
          ? "revalidates the Workspace resource snapshot after NotOccurred reconciliation I/O"
          : `recovers ${reconciliationMode} from a test-only trusted profile after a daemon restart`
        : boundary === "AH7AfterToolIntentCommit"
          ? "resumes a NotAdmitted shell intent from its persisted ProviderTurn"
          : `does not replay an ambiguous ${semantics} shell effect after ${boundary}`;
    it(testName, async () => {
      const marker = `AH7-SHELL-${crypto.randomUUID().slice(0, 8)}`;
      const steerMarker = `AH7-SHELL-STEER-${crypto.randomUUID().slice(0, 8)}`;
      const effectFile = `ah7-effect-${marker}.txt`;
      const evidenceFile = `ah7-proof-${marker}.txt`;
      const resultFile = `ah7-result-${marker}.txt`;
      const command =
        process.platform === "win32"
          ? `Add-Content -LiteralPath '${effectFile}' -Value '${marker}'`
          : `printf '%s\\n' '${marker}' >> '${effectFile}'`;
      const hits: AhProbeHit[] = [];
      const runtimeProbeEvents: Array<Readonly<Record<string, unknown>>> = [];
      let targetProviderCalls = 0;
      let workProviderCalls = 0;
      let manualWaitCalls = 0;
      let preseedReadCalls = 0;
      let probeArmed = false;
      let latestToolResult = "<none>";
      const fixture = await startProductionFixture({
        admitWorkspaceDirectory: true,
        reply: (call) => {
          const names = new Set(call.tools.map((tool) => tool.function?.name));
          const context = JSON.stringify(call.messages);
          if (
            names.has("assign_work") &&
            !names.has("claim_completion") &&
            context.includes(marker)
          ) {
            return context.includes("WorkAssigned(")
              ? { _tag: "Text", text: `Work admitted for ${marker}` }
              : {
                  _tag: "ToolCall",
                  name: "assign_work",
                  arguments: {
                    objective: `Wait for a human steer, then inspect the workspace with shell for ${marker}.`,
                    why: "qualify Reconcilable shell intent crash",
                    constraints: [],
                    completionExpectation:
                      "shell effect is not blindly replayed",
                    verificationMission: {
                      goal: `Verify safe shell recovery for ${marker}`,
                      criteria: [
                        {
                          criterionId: "shell-safe",
                          requirement: "no ambiguous shell effect is replayed",
                          required: true,
                        },
                      ],
                      riskRequirements: [],
                    },
                    reason: "AH7 Reconcilable functional test",
                  },
                };
          }
          if (
            names.has("claim_completion") &&
            names.has("shell") &&
            (context.includes(marker) ||
              (reconciliationMode !== undefined &&
                context.includes(steerMarker)))
          ) {
            workProviderCalls += 1;
            if (!context.includes(steerMarker)) {
              if (reconciliationMode !== undefined && preseedReadCalls < 2) {
                const path = preseedReadCalls === 0 ? evidenceFile : resultFile;
                preseedReadCalls += 1;
                return {
                  _tag: "ToolCall",
                  name: "read",
                  arguments: {
                    target: { mount: "workspace", path },
                  },
                };
              }
              manualWaitCalls += 1;
              return {
                _tag: "ToolCall",
                name: "wait",
                arguments: {
                  reason: `waiting for ${steerMarker}`,
                  waitSpec: {
                    mode: "Any",
                    conditions: [{ _tag: "Manual" }],
                  },
                },
              };
            }
            if (!probeArmed) {
              return {
                _tag: "Text",
                text: `Steer reached before the AH7 probe was armed: ${steerMarker}`,
              };
            }
            targetProviderCalls += 1;
            latestToolResult =
              [...call.messages]
                .reverse()
                .find((message) => message.role === "tool")?.content ??
              "<no tool result>";
            if (resourceChangeDuringReconcile && targetProviderCalls > 1) {
              return {
                _tag: "Text",
                text: `Resource snapshot changed during reconciliation for ${marker}`,
              };
            }
            if (targetProviderCalls > 5) {
              return { _tag: "HttpError", status: 429 };
            }
            return targetProviderCalls === 1
              ? {
                  _tag: "ToolCall",
                  name: "shell",
                  arguments: {
                    command,
                    cwd: { mount: "workspace", path: "." },
                    timeoutMs: 5_000,
                  },
                }
              : { _tag: "Text", text: `Observed ${marker}` };
          }
          return { _tag: "Text", text: `Waiting ${marker}` };
        },
        firstDaemonEntry: crashChild,
        daemonEnvironment: {
          ARBOR_AH_BOUNDARY:
            reconciliationMode === undefined ? boundary : "disabled",
          ...(semantics === "NonIdempotent"
            ? { ARBOR_AH_NON_IDEMPOTENT: "1" }
            : {}),
        },
        onDaemonStdout: (line) => {
          recordAhProbeLine(hits, line);
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.runtimeProbe === true) runtimeProbeEvents.push(event);
          } catch {
            // Ignore non-JSON daemon output in this test-only trace.
          }
        },
      });
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        "AH7 shell intent ambiguity",
        { resourceSelection: "Profile" },
      );
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
          value?.workId !== undefined &&
          value.objective?.includes(marker) === true,
      );
      if (currentWork?.workId === undefined) {
        throw new Error("AH7 public Reconcilable Work was not admitted");
      }
      const workId = currentWork.workId;
      expect(currentWork).toMatchObject({ revision: 0, status: "Open" });
      await waitForPublic(
        async () => ({ workProviderCalls, manualWaitCalls }),
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
        (value) =>
          value?.workId === workId && value.activeExecution === undefined,
      );
      expect(idleWork).toMatchObject({ workId, revision: 0, status: "Open" });
      expect(targetProviderCalls).toBe(0);

      await fixture.crash();
      probeArmed = true;
      await fixture.restart({
        entry:
          reconciliationMode === undefined ? crashChild : reconciliationChild,
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
      expect(
        await client.command(project.projectId, "ResolveExecutableApproval", {
          approvalId: executableApproval.approvalId,
          expectedRevision: executableApproval.revision,
          decision: "Approve",
          reason: `AH7 public shell approval ${marker}`,
        }),
      ).toMatchObject({ body: { resolution: "Committed" } });

      let hit: AhProbeHit | undefined;
      try {
        const observed = await waitForPublic(
          async () => ({ hits, targetProviderCalls }),
          (value) =>
            value.hits.some((candidate) => candidate.boundary === boundary) ||
            value.targetProviderCalls >= 5,
          15_000,
        );
        hit = observed.hits.find(
          (candidate) => candidate.boundary === boundary,
        );
        if (hit === undefined) {
          throw new Error(
            "provider-call cap reached before shell intent probe",
          );
        }
      } catch (error) {
        throw new Error(
          `AH7 shell intent probe absent: ${error instanceof Error ? error.message : String(error)}; targetProviderCalls=${targetProviderCalls}; latestToolResult=${latestToolResult}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      }
      await fixture.crash();
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

      if (semantics === "NonIdempotent") {
        await fixture.restart({
          entry: crashChild,
          daemonEnvironment: {
            ARBOR_AH_BOUNDARY: "disabled",
            ARBOR_AH_NON_IDEMPOTENT: "1",
          },
        });
      } else if (
        reconciliationMode !== undefined &&
        resourceChangeDuringReconcile
      ) {
        await fixture.restart({
          entry: reconciliationChild,
          daemonEnvironment: {
            ARBOR_AH10_ROLE: "old",
            ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
            ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
            ARBOR_AH7_TEST_RESOURCE_CHANGE_ON_RECONCILE: "1",
            ARBOR_AH7_TEST_CRASH_BOUNDARY: "disabled",
          },
        });
      } else if (reconciliationMode !== undefined) {
        const factBoundary =
          reconciliationMode === "NotOccurred"
            ? "AH7BeforeReconciliationFactCommit"
            : "AH7AfterReconciliationFactCommit";
        await fixture.restart({
          entry: reconciliationChild,
          daemonEnvironment: {
            ARBOR_AH10_ROLE: "old",
            ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
            ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
            ARBOR_AH7_TEST_CRASH_BOUNDARY: "disabled",
            ARBOR_AH7_TEST_RECONCILIATION_FACT_BOUNDARY: factBoundary,
          },
        });
        await waitForPublic(
          async () => hits,
          (value) =>
            value.some((candidate) => candidate.boundary === factBoundary),
          30_000,
        );
        const factsAtFactBoundary = readReconciliationFacts(
          fixture.databaseFile,
          hit.invocationId,
        );
        expect(factsAtFactBoundary).toHaveLength(
          factBoundary === "AH7BeforeReconciliationFactCommit" ? 0 : 1,
        );
        if (factBoundary === "AH7AfterReconciliationFactCommit") {
          expect(factsAtFactBoundary[0]).toMatchObject({
            outcome: reconciliationMode,
            fact_disposition: "RecoveryInput",
          });
        }
        await fixture.crash();
        await fixture.restart({
          entry: reconciliationChild,
          daemonEnvironment: {
            ARBOR_AH10_ROLE: "old",
            ARBOR_AH10_GATE_ACTION_KIND: "__disabled__",
            ARBOR_AH7_TEST_RECONCILIATION_MODE: reconciliationMode,
            ARBOR_AH7_TEST_CRASH_BOUNDARY: "disabled",
          },
        });
      } else {
        await fixture.restart();
      }
      const resumesUnadmittedIntent = boundary === "AH7AfterToolIntentCommit";
      let recovered: ReturnType<typeof durableSnapshot>;
      try {
        if (resourceChangeDuringReconcile) {
          await waitForPublic(
            async () =>
              readP4InvocationApprovalBinding(
                fixture.databaseFile,
                targetExecutionId,
                targetInvocationId,
              ),
            (value) => value?.settlement_kind === "ReconciledNoEffect",
            45_000,
          );
          recovered = durableSnapshot(fixture.databaseFile);
        } else {
          recovered = await waitForPublic(
            async () => durableSnapshot(fixture.databaseFile),
            (value) => {
              if (resumesUnadmittedIntent) {
                const successorStep = value.steps.find(
                  (step) =>
                    step.execution_id === targetExecutionId &&
                    step.logical_step_no ===
                      Number(crashedSourceStep?.logical_step_no ?? -1) + 1,
                );
                return (
                  value.actions.some(
                    (action) =>
                      action.execution_id === targetExecutionId &&
                      action.call_ref === hit?.callRef &&
                      action.state ===
                        (resourceChangeDuringReconcile
                          ? "TerminalRejected"
                          : "Applied"),
                  ) &&
                  value.toolInvocations.some(
                    (invocation) =>
                      invocation.invocation_id === hit?.invocationId &&
                      invocation.execution_id === targetExecutionId &&
                      invocation.settlement_kind === "Success",
                  ) &&
                  value.toolResults.some((row) =>
                    isToolResultFor(
                      row,
                      hit?.invocationId ?? "",
                      hit?.callRef ?? "",
                    ),
                  ) &&
                  successorStep !== undefined &&
                  successorStep.provider_turn_id !== originalProviderTurnId &&
                  value.providerTurns.some(
                    (turn) =>
                      turn.provider_turn_id ===
                        successorStep.provider_turn_id &&
                      turn.settled_at !== null,
                  ) &&
                  value.outputs.filter(
                    (output) =>
                      output.source_ref ===
                      `${successorStep.provider_turn_id}:assistant`,
                  ).length === 1
                );
              }
              if (
                reconciliationMode === "NotOccurred" ||
                reconciliationMode === "Occurred"
              ) {
                if (resourceChangeDuringReconcile) {
                  return value.toolInvocations.some(
                    (invocation) =>
                      invocation.invocation_id === hit?.invocationId &&
                      invocation.settlement_kind === "ReconciledNoEffect",
                  );
                }
                return (
                  value.actions.some(
                    (action) =>
                      action.execution_id === targetExecutionId &&
                      action.call_ref === hit?.callRef &&
                      action.state === "Applied",
                  ) &&
                  value.toolInvocations.some(
                    (invocation) =>
                      invocation.invocation_id === hit?.invocationId &&
                      invocation.settlement_kind ===
                        (resourceChangeDuringReconcile
                          ? "ReconciledNoEffect"
                          : "Success"),
                  ) &&
                  value.toolResults.some((row) =>
                    isToolResultFor(
                      row,
                      hit?.invocationId ?? "",
                      hit?.callRef ?? "",
                    ),
                  )
                );
              }
              return (
                value.actions.some(
                  (action) =>
                    action.execution_id === targetExecutionId &&
                    action.call_ref === hit?.callRef &&
                    action.state === "ReconciliationPending",
                ) &&
                value.executions.some(
                  (execution) =>
                    execution.execution_id === targetExecutionId &&
                    execution.settlement_kind === "OutcomeUnknown",
                )
              );
            },
            45_000,
          );
        }
      } catch (error) {
        if (!resourceChangeDuringReconcile) throw error;
        throw new Error(
          `resource-change recovery did not settle: ${error instanceof Error ? error.message : String(error)}; invocation=${JSON.stringify(readP4InvocationApprovalBinding(fixture.databaseFile, targetExecutionId, hit.invocationId))}; facts=${JSON.stringify(readReconciliationFacts(fixture.databaseFile, hit.invocationId))}; runtimeProbes=${JSON.stringify(runtimeProbeEvents.filter((event) => event.invocationId === hit.invocationId).map((event) => ({ boundary: event.boundary, outcomeTag: event.outcomeTag, admissionResult: event.admissionResult })))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      }
      const recoveredTarget = readExecutionProviderTurns(
        fixture.databaseFile,
        targetExecutionId,
      );
      expect(recoveredTarget.execution).toEqual(crashedTarget.execution);
      const recoveredTargetInvocations = recovered.toolInvocations.filter(
        (invocation) => invocation.execution_id === targetExecutionId,
      );
      expect(recoveredTargetInvocations).toHaveLength(1);
      const settledInvocation = recoveredTargetInvocations[0];
      expect(settledInvocation).toMatchObject({
        invocation_id: hit.invocationId,
        execution_id: targetExecutionId,
        side_effect_semantics: semantics,
      });
      const recoveredInvocationBinding = readP4InvocationApprovalBinding(
        fixture.databaseFile,
        targetExecutionId,
        hit.invocationId,
      );
      expect(recoveredInvocationBinding?.approval_id).toBe(
        executableApproval.approvalId,
      );
      expect(recoveredInvocationBinding?.arguments_json).toBe(
        executableApproval.row.arguments_json,
      );
      const reconciliationFacts =
        reconciliationMode === undefined
          ? []
          : readReconciliationFacts(fixture.databaseFile, hit.invocationId);
      const effectAttempts =
        reconciliationMode === undefined
          ? []
          : readEffectAttempts(fixture.databaseFile, hit.invocationId);
      const externalEffects =
        reconciliationMode === undefined
          ? []
          : readTestExternalEffects(fixture.databaseFile);
      if (reconciliationMode === "NotOccurred") {
        expect(reconciliationFacts).toHaveLength(1);
        expect(reconciliationFacts[0]).toMatchObject({
          attempt_no: 0,
          outcome: "NotOccurred",
          reason_code: null,
          fact_disposition: "RecoveryInput",
          result_ref: null,
        });
        expect(reconciliationFacts[0]?.evidence_ref).toMatch(/^art_/u);
        if (resourceChangeDuringReconcile) {
          expect(effectAttempts).toHaveLength(1);
          expect(effectAttempts[0]).toMatchObject({
            attempt_no: 0,
            admission_state: "MayHaveStarted",
          });
          expect(externalEffects).toHaveLength(0);
          expect(recoveredInvocationBinding).toMatchObject({
            settlement_kind: "ReconciledNoEffect",
            settlement_provenance: "Reconciliation",
            selected_attempt_no: 0,
            selected_fact_id: reconciliationFacts[0]?.fact_id,
            observation_format_version: "p4-canonical-tool-observation-v1",
          });
          expect(recoveredInvocationBinding?.result_ref).toMatch(/^art_/u);
          expect(
            JSON.parse(String(recoveredInvocationBinding?.settlement_json)),
          ).toMatchObject({
            _tag: "ReconciledNoEffect",
            reasonCode: "ResourceSnapshotChanged",
          });
          const observation = JSON.parse(
            Buffer.from(
              recoveredInvocationBinding?.observation_json ?? new Uint8Array(),
            ).toString("utf8"),
          );
          expect(observation).toMatchObject({
            _tag: "ReconciledNoEffect",
            reasonCode: "ResourceSnapshotChanged",
            reconciliationFactRef: reconciliationFacts[0]?.fact_id,
          });
        } else {
          expect(effectAttempts).toHaveLength(2);
          expect(effectAttempts.map((attempt) => attempt.attempt_no)).toEqual([
            0, 1,
          ]);
          expect(
            effectAttempts.map((attempt) => attempt.admission_state),
          ).toEqual(["MayHaveStarted", "MayHaveStarted"]);
          expect(effectAttempts[0]?.effect_key).toBe(
            effectAttempts[1]?.effect_key,
          );
          expect(externalEffects).toHaveLength(1);
          expect(externalEffects[0]?.result_ref).toMatch(/^art_/u);
          expect(recoveredInvocationBinding).toMatchObject({
            settlement_kind: "Success",
            settlement_provenance: "Ordinary",
            selected_attempt_no: null,
            selected_fact_id: null,
            observation_format_version: "p4-canonical-tool-observation-v1",
          });
        }
        expect(recoveredInvocationBinding?.observation_sha256).toMatch(
          /^[0-9a-f]{64}$/u,
        );
        expect(recoveredInvocationBinding?.observation_json).not.toBeNull();
      } else if (reconciliationMode === "Occurred") {
        expect(reconciliationFacts).toHaveLength(1);
        expect(reconciliationFacts[0]).toMatchObject({
          attempt_no: 0,
          outcome: "Occurred",
          reason_code: null,
          fact_disposition: "RecoveryInput",
        });
        expect(reconciliationFacts[0]?.evidence_ref).toMatch(/^art_/u);
        expect(reconciliationFacts[0]?.result_ref).toMatch(/^art_/u);
        expect(reconciliationFacts[0]?.result_ref).not.toBe(
          reconciliationFacts[0]?.evidence_ref,
        );
        expect(effectAttempts).toHaveLength(1);
        expect(externalEffects).toHaveLength(1);
        expect(recoveredInvocationBinding).toMatchObject({
          settlement_kind: "Success",
          settlement_provenance: "Reconciliation",
          selected_attempt_no: 0,
          selected_fact_id: reconciliationFacts[0]?.fact_id,
          result_ref: reconciliationFacts[0]?.result_ref,
          observation_format_version: "p4-canonical-tool-observation-v1",
        });
        expect(recoveredInvocationBinding?.observation_sha256).toMatch(
          /^[0-9a-f]{64}$/u,
        );
        expect(recoveredInvocationBinding?.observation_json).not.toBeNull();
      } else if (reconciliationMode === "StillUnknown") {
        expect(reconciliationFacts).toHaveLength(1);
        expect(reconciliationFacts[0]).toMatchObject({
          attempt_no: 0,
          outcome: "StillUnknown",
          reason_code: "AttemptNotFinal",
          fact_disposition: "RecoveryInput",
          result_ref: null,
          evidence_ref: null,
        });
        expect(effectAttempts).toHaveLength(1);
        expect(externalEffects).toHaveLength(0);
        expect(recoveredInvocationBinding).toMatchObject({
          settlement_kind: null,
          settled_at: null,
          result_ref: null,
          observation_format_version: null,
          observation_json: null,
          observation_sha256: null,
        });
      }
      const recoveredApproval = readExecutableApprovalAfterRecovery(
        fixture.databaseFile,
        executableApproval.approvalId,
        targetExecutionId,
      );
      expect(recoveredApproval.approval).toMatchObject({
        state: "Consumed",
        consumed_by: hit.invocationId,
      });
      expect(recoveredApproval.approvals).toHaveLength(1);
      if (resumesUnadmittedIntent) {
        expect(settledInvocation?.settled_at).not.toBeNull();
        expect(settledInvocation?.settlement_kind).toBe("Success");
      } else if (resourceChangeDuringReconcile) {
        expect(settledInvocation?.settled_at).not.toBeNull();
        expect(settledInvocation?.settlement_kind).toBe("ReconciledNoEffect");
      } else if (
        reconciliationMode === "NotOccurred" ||
        reconciliationMode === "Occurred"
      ) {
        expect(settledInvocation?.settled_at).not.toBeNull();
        expect(settledInvocation?.settlement_kind).toBe("Success");
      } else if (semantics === "NonIdempotent") {
        expect(recoveredInvocationBinding?.effect_admission_state).toBe(
          "MayHaveStarted",
        );
        expect(settledInvocation?.settled_at).toBeNull();
        expect(settledInvocation?.settlement_kind).toBeNull();
        expect(settledInvocation?.settlement_json).toBeNull();
      } else {
        expect(settledInvocation?.settled_at).toBeNull();
        expect(settledInvocation?.settlement_kind).toBeNull();
        expect(settledInvocation?.settlement_json).toBeNull();
      }
      const recoveredTargetActions = recovered.actions.filter(
        (action) =>
          action.execution_id === targetExecutionId &&
          action.call_ref === hit.callRef,
      );
      if (resourceChangeDuringReconcile) {
        expect(recoveredTargetActions).toHaveLength(1);
        expect(recoveredTargetActions[0]).toMatchObject({
          execution_id: targetExecutionId,
          logical_action_id: crashedAction.logical_action_id,
          call_ref: crashedAction.call_ref,
        });
        // The P4 denial may already be visible as a terminal rejection, but
        // this case qualifies the P4 retry gate only, not P3 projection crash
        // convergence. In particular, it must never report an applied effect.
        expect(recoveredTargetActions[0]?.state).not.toBe("Applied");
      } else {
        expect(recoveredTargetActions).toEqual([
          expect.objectContaining({
            execution_id: targetExecutionId,
            logical_action_id: crashedAction.logical_action_id,
            call_ref: crashedAction.call_ref,
            state:
              resumesUnadmittedIntent ||
              reconciliationMode === "NotOccurred" ||
              reconciliationMode === "Occurred"
                ? "Applied"
                : "ReconciliationPending",
          }),
        ]);
      }
      const recoveredExecution = recovered.executions.find(
        (execution) => execution.execution_id === targetExecutionId,
      );
      const contentAfter = existsSync(effectPath)
        ? readFileSync(effectPath, "utf8")
        : null;
      if (!resumesUnadmittedIntent && reconciliationMode === "StillUnknown") {
        expect(recoveredExecution).toMatchObject({
          settlement_kind: "OutcomeUnknown",
        });
        expect(JSON.parse(String(recoveredExecution?.settlement_json))).toEqual(
          {
            _tag: "OutcomeUnknown",
            reconciliation: {
              _tag: "ReconciliationRequired",
              invocationRefs: [hit?.invocationId],
            },
          },
        );
      }
      if (semantics === "NonIdempotent") {
        const toolResultsForCall = recovered.toolResults.filter(
          (row) => readToolResultForCall([row], targetCallRef) !== undefined,
        );
        expect(toolResultsForCall).toHaveLength(1);
        const unresolvedToolResult = readToolResultForCall(
          recovered.toolResults,
          targetCallRef,
        );
        expect(unresolvedToolResult).toBeDefined();
        expect(unresolvedToolResult?.row.source_kind).toBe("AgentLoopAction");
        expect(unresolvedToolResult?.payload).toMatchObject({
          _tag: "ToolResult",
          callRef: targetCallRef,
          toolName: "shell",
          status: "OutcomeUnknown",
          artifactRefs: [],
          truncated: false,
        });
        expect(unresolvedToolResult?.payload).not.toHaveProperty(
          "canonicalRefs",
        );
        expect(unresolvedToolResult?.payload).not.toHaveProperty("resultRef");
        expect(unresolvedToolResult?.payload).not.toHaveProperty(
          "invocationId",
        );
        expect(unresolvedToolResult?.row.source_ref).toBe(
          recoveredTargetActions[0]?.observation_source_ref,
        );
        expect(unresolvedToolResult?.payload.observationRef).toBe(
          recoveredTargetActions[0]?.observation_source_ref,
        );
        expect(
          recovered.artifacts.filter(
            (artifact) => artifact.invocation_id === hit.invocationId,
          ),
        ).toEqual([]);
      }
      const recoveredSourceStep = recovered.steps.find(
        (step) =>
          step.execution_id === targetExecutionId &&
          step.logical_step_no === crashedAction.logical_step_no &&
          step.repair_attempt === crashedAction.repair_attempt,
      );
      expect(crashedSourceStep).toMatchObject({
        state: "ActionsInProgress",
        next_action_index: 0,
        provider_turn_id: expect.any(String),
        decoded_output_hash: expect.any(String),
        model_output_session_sequence: expect.any(Number),
      });
      expect(recoveredSourceStep).toMatchObject({
        provider_turn_id: crashedSourceStep?.provider_turn_id,
        decoded_output_hash: crashedSourceStep?.decoded_output_hash,
        model_output_session_sequence:
          crashedSourceStep?.model_output_session_sequence,
        next_action_index: 1,
      });
      expect(
        crashed.outputs.filter(
          (output) =>
            output.source_ref === `${originalProviderTurnId}:assistant`,
        ),
      ).toHaveLength(1);
      expect(
        recovered.outputs.filter(
          (output) =>
            output.source_ref === `${originalProviderTurnId}:assistant`,
        ),
      ).toHaveLength(1);
      expect(
        recovered.attempts.filter(
          (attempt) => attempt.provider_turn_id === originalProviderTurnId,
        ),
      ).toEqual(
        crashed.attempts.filter(
          (attempt) => attempt.provider_turn_id === originalProviderTurnId,
        ),
      );
      if (resumesUnadmittedIntent) {
        expect(
          recoveredTarget.providerTurns.find(
            (turn) => turn.provider_turn_id === originalProviderTurnId,
          ),
        ).toEqual(
          crashedTarget.providerTurns.find(
            (turn) => turn.provider_turn_id === originalProviderTurnId,
          ),
        );
        const successorTurn = recoveredTarget.providerTurns.find(
          (turn) => turn.provider_turn_id !== originalProviderTurnId,
        );
        expect(successorTurn?.settled_at).not.toBeNull();
        expect(
          recovered.outputs.filter(
            (output) =>
              output.source_ref ===
              `${successorTurn?.provider_turn_id}:assistant`,
          ),
        ).toHaveLength(1);
        expect(recoveredSourceStep?.next_action_index).toBe(1);
        expect(
          recovered.actions.find(
            (action) =>
              action.execution_id === targetExecutionId &&
              action.call_ref === hit?.callRef,
          )?.observation_source_ref,
        ).toEqual(expect.any(String));
        expect(
          recovered.toolResults.filter((row) =>
            isToolResultFor(row, hit?.invocationId ?? "", hit?.callRef ?? ""),
          ),
        ).toHaveLength(1);
        expect(targetProviderCalls).toBeGreaterThan(1);
        expect(contentBefore).toBeNull();
        expect(
          (contentAfter ?? "")
            .split(/\r?\n/u)
            .filter((line) => line === marker),
        ).toHaveLength(1);
      } else if (
        reconciliationMode === "NotOccurred" ||
        reconciliationMode === "Occurred"
      ) {
        expect(
          recoveredTarget.providerTurns.filter((turn) =>
            crashedTarget.providerTurns.some(
              (crashedTurn) =>
                crashedTurn.provider_turn_id === turn.provider_turn_id,
            ),
          ),
        ).toEqual(crashedTarget.providerTurns);
        expect(targetProviderCalls).toBeLessThanOrEqual(2);
        if (resourceChangeDuringReconcile) {
          expect(contentAfter).toBeNull();
          expect(externalEffects).toHaveLength(0);
        } else {
          expect(contentAfter).toBeDefined();
          expect(
            (contentAfter ?? "")
              .split(/\r?\n/u)
              .filter((line) => line === marker),
          ).toHaveLength(1);
        }
      } else {
        expect(recoveredTarget.providerTurns).toEqual(
          crashedTarget.providerTurns,
        );
        expect(targetProviderCalls).toBe(1);
        expect(contentAfter).toBe(contentBefore);
        if (semantics === "NonIdempotent") {
          expect(
            (contentAfter ?? "")
              .split(/\r?\n/u)
              .filter((line) => line === marker),
          ).toHaveLength(1);
        }
      }
      expect(fixture.daemonErrors).toEqual([]);
    });
  }
});
