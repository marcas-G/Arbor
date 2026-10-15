import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ProductionFixture } from "../support/production-fixture.js";
import { startProductionFixture } from "../support/production-fixture.js";
import {
  createFunctionalProject,
  functionalId,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../support/public-client.js";

interface Probe {
  readonly tag: "P4_FENCE_PROBE";
  readonly role: "old" | "new";
  readonly boundary: string;
  readonly executionId: string;
  readonly invocationId?: string;
  readonly callRef?: string;
  readonly fencingGeneration?: number;
  readonly definition?: {
    readonly version?: string;
    readonly hash?: string;
    readonly sideEffectSemantics?: string;
  };
}

interface ExecutableApprovalRow {
  readonly approval_id: string;
  readonly route_kind: string;
  readonly project_id: string;
  readonly workspace_id: string;
  readonly execution_id: string;
  readonly execution_workspace_id: string;
  readonly episode_kind: string;
  readonly episode_ref: string;
  readonly subject_ref: string;
  readonly stable_action_id: string;
  readonly action_version: string;
  readonly side_effect_semantics: string;
  readonly action_digest: string;
  readonly arguments_json: string;
  readonly target_ref: string;
  readonly target_resource_space_ids_json: string;
  readonly state: string;
  readonly revision: number;
  readonly decided_at: string | null;
  readonly consumed_at: string | null;
  readonly consumed_by: string | null;
  readonly binding_proven: number;
  readonly tool_invocation_id: string;
  readonly logical_action_id: string;
  readonly call_ref: string;
  readonly action_kind: string;
  readonly action_route_kind: string;
  readonly action_state: string;
  readonly action_call_ref: string;
}

interface AdmissionRows {
  readonly lease:
    | { readonly execution_id: string; readonly generation: number }
    | undefined;
  readonly invocation:
    | {
        readonly invocation_id: string;
        readonly execution_id: string;
        readonly workspace_id: string;
        readonly tool_name: string;
        readonly tool_version: string;
        readonly arguments_json: string;
        readonly resolved_regions_json: string;
        readonly side_effect_semantics: string;
        readonly approval_id: string | null;
        readonly effect_admission_state: string;
        readonly settled_at: string | null;
        readonly settlement_kind: string | null;
      }
    | undefined;
  readonly execution:
    | {
        readonly settlement_kind: string | null;
        readonly settlement_json: string | null;
        readonly settled_at: string | null;
      }
    | undefined;
  readonly step:
    | {
        readonly logical_step_no: number;
        readonly repair_attempt: number;
        readonly provider_turn_id: string;
        readonly state: string;
        readonly next_action_index: number;
        readonly decoded_output_hash: string | null;
        readonly model_output_session_sequence: number | null;
      }
    | undefined;
  readonly steps: ReadonlyArray<{
    readonly logical_step_no: number;
    readonly repair_attempt: number;
    readonly provider_turn_id: string;
    readonly state: string;
    readonly next_action_index: number;
    readonly decoded_output_hash: string | null;
    readonly model_output_session_sequence: number | null;
  }>;
  readonly providerTurns: ReadonlyArray<{
    readonly provider_turn_id: string;
    readonly settled_at: string | null;
    readonly finish_reason: string | null;
  }>;
  readonly providerAttempts: ReadonlyArray<{
    readonly provider_turn_id: string;
    readonly attempt_no: number;
    readonly outcome: string;
    readonly settled_at: string | null;
  }>;
  readonly modelOutputSources: ReadonlyArray<{
    readonly sequence: number;
    readonly source_ref: string;
    readonly content_hash: string;
  }>;
  readonly action:
    | {
        readonly logical_action_id: string;
        readonly call_ref: string;
        readonly action_kind: string;
        readonly state: string;
        readonly disposition_json: string | null;
        readonly observation_source_ref: string | null;
      }
    | undefined;
  readonly toolResults: ReadonlyArray<{
    readonly source_kind: string | null;
    readonly source_ref: string;
    readonly payload_json: string;
  }>;
  readonly shellInvocationCount: number;
  readonly observations: ReadonlyArray<{
    readonly source_ref: string;
    readonly payload_json: string;
  }>;
  readonly workApproval:
    | { readonly route_kind: string; readonly state: string }
    | undefined;
  readonly executableApprovalCount: number;
  readonly executableApproval: ExecutableApprovalRow | undefined;
}

const fnvDigest = (input: string): string => {
  let value = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, "0");
};

const actionDigestOfInvocation = (input: {
  readonly toolName: string;
  readonly toolVersion: string;
  readonly argumentsJson: string;
}): string =>
  fnvDigest(`${input.toolName}@${input.toolVersion}:${input.argumentsJson}`);

const fixtures: ProductionFixture[] = [];
const EXECUTABLE_APPROVAL_ENTRY_KEY = /^eap:(.+):(\d+)$/u;
const fenceChild = resolve(
  "tests/functional/support/p4-tool-lease-fencing-child.mjs",
);

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const readRows = (
  databaseFile: string,
  executionId: string,
  invocationId: string,
  callRef: string,
  workApprovalId: string,
  executableApprovalId: string,
): AdmissionRows => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    // Keep Invocation, Approval, lease and Execution in one SQLite view; the
    // recovery handoff updates them across adjacent transaction boundaries.
    db.exec("BEGIN");
    return {
      lease: db
        .prepare(
          "SELECT execution_id, generation FROM execution_leases WHERE execution_id = ?",
        )
        .get(executionId) as AdmissionRows["lease"],
      invocation: db
        .prepare(
          `SELECT invocation_id, execution_id, workspace_id, tool_name,
                  tool_version, arguments_json, resolved_regions_json,
                  side_effect_semantics,
                  approval_id, effect_admission_state,
                  settled_at, settlement_kind
             FROM tool_invocations WHERE invocation_id = ?`,
        )
        .get(invocationId) as AdmissionRows["invocation"],
      execution: db
        .prepare(
          "SELECT settlement_kind, settlement_json, settled_at FROM executions WHERE execution_id = ?",
        )
        .get(executionId) as AdmissionRows["execution"],
      step: db
        .prepare(
          `SELECT s.logical_step_no, s.repair_attempt, s.provider_turn_id,
                  s.state, s.next_action_index, s.decoded_output_hash,
                  s.model_output_session_sequence
             FROM agent_loop_steps s
             JOIN agent_loop_step_actions a
               ON a.execution_id = s.execution_id
              AND a.logical_step_no = s.logical_step_no
              AND a.repair_attempt = s.repair_attempt
            WHERE a.execution_id = ? AND a.call_ref = ?`,
        )
        .get(executionId, callRef) as AdmissionRows["step"],
      steps: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, provider_turn_id, state,
                  next_action_index, decoded_output_hash,
                  model_output_session_sequence
             FROM agent_loop_steps
            WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt`,
        )
        .all(executionId)
        .map((row) => ({
          logical_step_no: Number(row.logical_step_no),
          repair_attempt: Number(row.repair_attempt),
          provider_turn_id: String(row.provider_turn_id),
          state: String(row.state),
          next_action_index: Number(row.next_action_index),
          decoded_output_hash:
            row.decoded_output_hash === null
              ? null
              : String(row.decoded_output_hash),
          model_output_session_sequence:
            row.model_output_session_sequence === null
              ? null
              : Number(row.model_output_session_sequence),
        })),
      providerTurns: db
        .prepare(
          `SELECT provider_turn_id, settled_at, finish_reason
             FROM provider_turns WHERE execution_id = ?
            ORDER BY provider_turn_id`,
        )
        .all(executionId)
        .map((row) => ({
          provider_turn_id: String(row.provider_turn_id),
          settled_at: row.settled_at === null ? null : String(row.settled_at),
          finish_reason:
            row.finish_reason === null ? null : String(row.finish_reason),
        })),
      providerAttempts: db
        .prepare(
          `SELECT a.provider_turn_id, a.attempt_no, a.outcome, a.settled_at
             FROM provider_attempts a
             JOIN provider_turns t USING (provider_turn_id)
            WHERE t.execution_id = ?
            ORDER BY a.provider_turn_id, a.attempt_no`,
        )
        .all(executionId)
        .map((row) => ({
          provider_turn_id: String(row.provider_turn_id),
          attempt_no: Number(row.attempt_no),
          outcome: String(row.outcome),
          settled_at: row.settled_at === null ? null : String(row.settled_at),
        })),
      modelOutputSources: db
        .prepare(
          `SELECT sequence, source_ref, content_hash
             FROM session_entries
            WHERE session_id = (
                    SELECT session_id FROM executions WHERE execution_id = ?
                  )
              AND item_type = 'AssistantMessage'
              AND source_kind = 'ProviderTurn'
            ORDER BY sequence`,
        )
        .all(executionId)
        .map((row) => ({
          sequence: Number(row.sequence),
          source_ref: String(row.source_ref),
          content_hash: String(row.content_hash),
        })),
      action: db
        .prepare(
          `SELECT logical_action_id, call_ref, action_kind, state,
                  disposition_json,
                  observation_source_ref
             FROM agent_loop_step_actions
            WHERE execution_id = ? AND call_ref = ?`,
        )
        .get(executionId, callRef) as AdmissionRows["action"],
      toolResults: db
        .prepare(
          `SELECT se.source_kind, se.source_ref, se.payload_json
             FROM session_entries se
             JOIN executions e ON e.session_id = se.session_id
            WHERE e.execution_id = ?
              AND se.item_type = 'ToolResult'
              AND json_extract(se.payload_json, '$.callRef') = ?`,
        )
        .all(executionId, callRef)
        .map((row) => {
          if (typeof row.payload_json !== "string") {
            throw new Error("ToolResult payload_json was not text");
          }
          return {
            source_kind:
              row.source_kind === null ? null : String(row.source_kind),
            source_ref: String(row.source_ref),
            payload_json: row.payload_json,
          };
        }),
      shellInvocationCount: (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM tool_invocations WHERE execution_id = ? AND tool_name = 'shell'",
          )
          .get(executionId) as { readonly count: number }
      ).count,
      observations: db
        .prepare(
          `SELECT se.source_ref, se.payload_json
             FROM session_entries se
             JOIN executions e ON e.session_id = se.session_id
            WHERE e.execution_id = ?
              AND se.source_kind = 'AgentLoopAction'
              AND se.entry_kind = 'Observation'
            ORDER BY se.sequence`,
        )
        .all(executionId)
        .map((row) => ({
          source_ref: String(row.source_ref),
          payload_json: String(row.payload_json),
        })),
      workApproval: db
        .prepare(
          "SELECT route_kind, state FROM action_approvals WHERE approval_id = ?",
        )
        .get(workApprovalId) as AdmissionRows["workApproval"],
      executableApprovalCount: (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM action_approvals WHERE route_kind = 'Executable' AND execution_id = ?",
          )
          .get(executionId) as { readonly count: number }
      ).count,
      executableApproval: db
        .prepare(
          `SELECT ap.approval_id, ap.route_kind, ap.project_id,
                  ap.workspace_id, ap.execution_id,
                  e.workspace_id AS execution_workspace_id,
                  e.episode_kind, e.episode_ref, ap.subject_ref,
                  ap.stable_action_id, ap.action_version,
                  ap.side_effect_semantics, ap.action_digest,
                  ap.arguments_json, ap.target_ref,
                  ap.target_resource_space_ids_json, ap.state, ap.revision,
                  ap.decided_at, ap.consumed_at, ap.consumed_by,
                  ap.binding_proven, ap.tool_invocation_id,
                  ap.logical_action_id, ap.call_ref,
                  a.action_kind, a.route_kind AS action_route_kind,
                  a.state AS action_state, a.call_ref AS action_call_ref
             FROM action_approvals ap
             JOIN executions e ON e.execution_id = ap.execution_id
             JOIN agent_loop_step_actions a
               ON a.execution_id = ap.execution_id
              AND a.logical_step_no = ap.logical_step_no
              AND a.repair_attempt = ap.repair_attempt
              AND a.action_index = ap.action_index
              AND a.logical_action_id = ap.logical_action_id
              AND a.call_ref = ap.call_ref
            WHERE ap.approval_id = ? AND ap.route_kind = 'Executable'`,
        )
        .get(executableApprovalId) as AdmissionRows["executableApproval"],
    };
  } finally {
    db.close();
  }
};

const readExecutableApprovalBinding = (
  databaseFile: string,
  approvalId: string,
): ExecutableApprovalRow | undefined => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT ap.approval_id, ap.route_kind, ap.project_id,
                ap.workspace_id, ap.execution_id,
                e.workspace_id AS execution_workspace_id,
                e.episode_kind, e.episode_ref, ap.subject_ref,
                ap.stable_action_id, ap.action_version,
                ap.side_effect_semantics, ap.action_digest,
                ap.arguments_json, ap.target_ref,
                ap.target_resource_space_ids_json, ap.state, ap.revision,
                ap.decided_at, ap.consumed_at, ap.consumed_by,
                ap.binding_proven, ap.tool_invocation_id,
                ap.logical_action_id, ap.call_ref,
                a.action_kind, a.route_kind AS action_route_kind,
                a.state AS action_state, a.call_ref AS action_call_ref
           FROM action_approvals ap
           JOIN executions e ON e.execution_id = ap.execution_id
           JOIN agent_loop_step_actions a
             ON a.execution_id = ap.execution_id
            AND a.logical_step_no = ap.logical_step_no
            AND a.repair_attempt = ap.repair_attempt
            AND a.action_index = ap.action_index
            AND a.logical_action_id = ap.logical_action_id
            AND a.call_ref = ap.call_ref
          WHERE ap.approval_id = ? AND ap.route_kind = 'Executable'
            AND ap.binding_proven = 1`,
      )
      .get(approvalId) as ExecutableApprovalRow | undefined;
  } finally {
    db.close();
  }
};

const recordProbe = (events: Probe[], line: string) => {
  try {
    const parsed = JSON.parse(line) as Probe;
    if (parsed.tag === "P4_FENCE_PROBE") events.push(parsed);
  } catch {
    // Preserve daemon diagnostics separately; unrelated output is not a probe.
  }
};

describe("P4 AH7 effect-admission generation takeover", () => {
  for (const scenario of [
    {
      boundary: "AH7BeforeEffectAdmission",
      admission: "NotAdmitted",
      sideEffectSemantics: "Reconcilable",
    },
    {
      boundary: "AH7AfterEffectAdmissionCommit",
      admission: "MayHaveStarted",
      sideEffectSemantics: "Reconcilable",
    },
    {
      boundary: "AH7AfterEffectAdmissionCommit",
      admission: "MayHaveStarted",
      sideEffectSemantics: "NonIdempotent",
    },
  ] as const) {
    it(`fences ${scenario.sideEffectSemantics} recovery at ${scenario.boundary}`, async () => {
      const marker = `AH7-ADMIT-${crypto.randomUUID().slice(0, 8)}`;
      const steerMarker = `AH7-ADMIT-STEER-${marker}`;
      const effectFile = `ah7-admission-${marker}.txt`;
      const effectMarker = `AH7_EFFECT_${marker}`;
      const command =
        process.platform === "win32"
          ? `Add-Content -LiteralPath '${effectFile}' -Value '${effectMarker}'`
          : `printf '%s\\n' '${effectMarker}' >> '${effectFile}'`;
      const events: Probe[] = [];
      let targetProviderCalls = 0;
      let manualWaitCalls = 0;
      const fixture = await startProductionFixture({
        admitWorkspaceDirectory: true,
        firstDaemonEntry: fenceChild,
        daemonEnvironment: {
          ARBOR_P4_FENCE_ROLE: "old",
          ARBOR_P4_FENCE_ADMISSION_BOUNDARY: scenario.boundary,
          ...(scenario.sideEffectSemantics === "NonIdempotent"
            ? { ARBOR_P4_FENCE_NON_IDEMPOTENT: "1" }
            : {}),
        },
        onDaemonStdout: (line) => recordProbe(events, line),
        reply: (call) => {
          const names = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
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
                    objective: `Wait, then run one allowed shell write for ${marker}.`,
                    why: "qualify P4 fenced effect-admission recovery",
                    constraints: [],
                    completionExpectation: "the shell effect is present once",
                    verificationMission: {
                      goal: `Verify effect-admission recovery for ${marker}`,
                      criteria: [
                        {
                          criterionId: "single-effect",
                          requirement: "the marker is appended exactly once",
                          required: true,
                        },
                      ],
                      riskRequirements: [],
                    },
                    reason: "AH7 effect-admission process qualification",
                  },
                };
          }
          if (
            names.has("claim_completion") &&
            names.has("shell") &&
            context.includes(marker)
          ) {
            if (!context.includes(steerMarker)) {
              manualWaitCalls += 1;
              return {
                _tag: "ToolCall",
                name: "wait",
                arguments: {
                  reason: `wait for ${steerMarker}`,
                  waitSpec: {
                    mode: "Any",
                    conditions: [{ _tag: "Manual" }],
                  },
                },
              };
            }
            targetProviderCalls += 1;
            if (targetProviderCalls > 3) {
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
          return { _tag: "Text", text: `Waiting for ${marker}` };
        },
      });
      fixtures.push(fixture);

      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `AH7 effect admission ${marker}`,
        { resourceSelection: "Profile" },
      );
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
        `Create a Work to wait for a steer and then make one safe shell write: ${marker}`,
      );
      const approval = await waitForApproval(client, project, marker);
      await client.command(project.projectId, "ResolveControlApproval", {
        approvalId: approval.approvalId,
        expectedRevision: approval.revision,
        decision: "Approve",
        reason: "AH7 approved Work admission, not executable approval",
      });
      const work = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            objective?: string;
            revision: number;
          } | null>("current-work", {
            workspaceId: project.rootWorkspaceId,
          }),
        (value) =>
          value !== null &&
          value.workId !== undefined &&
          value.objective?.includes(marker) === true,
      );
      if (work?.workId === undefined) throw new Error("Work was not admitted");
      await waitForPublic(
        async () => manualWaitCalls,
        (value) => value > 0,
      );
      const idleWork = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            revision: number;
            activeExecution?: { executionId: string };
          } | null>("current-work", {
            workspaceId: project.rootWorkspaceId,
          }),
        (value) =>
          value !== null &&
          value.workId === work.workId &&
          value.activeExecution === undefined,
      );
      if (idleWork?.workId === undefined) throw new Error("Work did not idle");
      await client.command(project.projectId, "SteerWork", {
        workId: idleWork.workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: idleWork.revision,
        steer: { severity: "Normal", guidance: steerMarker },
        provenance: { source: "HumanInput" },
      });

      const approvalInbox = await waitForPublic(
        () =>
          client.view<{
            unconsumed: Array<{
              entryKey: string;
              kind: string;
              summary: string;
            }>;
          }>("inbox-view", { workspaceId: project.rootWorkspaceId }),
        (value) =>
          value.unconsumed.filter(
            (entry) =>
              entry.kind === "Governance" &&
              EXECUTABLE_APPROVAL_ENTRY_KEY.test(entry.entryKey),
          ).length === 1,
        60_000,
      );
      const executableApprovalEntries = approvalInbox.unconsumed.filter(
        (entry) =>
          entry.kind === "Governance" &&
          EXECUTABLE_APPROVAL_ENTRY_KEY.test(entry.entryKey),
      );
      expect(executableApprovalEntries).toHaveLength(1);
      const approvalMatch = EXECUTABLE_APPROVAL_ENTRY_KEY.exec(
        executableApprovalEntries[0]?.entryKey ?? "",
      );
      if (
        approvalMatch === null ||
        approvalMatch[1] === undefined ||
        approvalMatch[2] === undefined
      ) {
        throw new Error(
          "P4 shell action produced no exact root-Workspace Executable approval",
        );
      }
      const executableApprovalId = approvalMatch[1];
      const executableApprovalRevision = Number(approvalMatch[2]);
      const executableApproval = readExecutableApprovalBinding(
        fixture.databaseFile,
        executableApprovalId,
      );
      const shellDefinition = events.find(
        (event) => event.boundary === "P4ShellDefinitionSnapshot",
      )?.definition;
      if (
        executableApproval === undefined ||
        shellDefinition?.version === undefined ||
        shellDefinition.hash === undefined
      ) {
        throw new Error(
          "P4 exact Executable approval binding or shell definition snapshot was absent",
        );
      }
      expect(executableApproval).toMatchObject({
        approval_id: executableApprovalId,
        route_kind: "Executable",
        project_id: project.projectId,
        workspace_id: project.rootWorkspaceId,
        execution_workspace_id: project.rootWorkspaceId,
        episode_kind: "WorkEpisode",
        episode_ref: work.workId,
        stable_action_id: "shell",
        action_version: shellDefinition.version,
        side_effect_semantics: scenario.sideEffectSemantics,
        state: "Pending",
        revision: executableApprovalRevision,
        binding_proven: 1,
        action_kind: "shell",
        action_route_kind: "Executable",
        action_state: "Pending",
      });
      expect(
        JSON.parse(executableApproval.target_resource_space_ids_json),
      ).toEqual(["filesystem"]);
      expect(executableApproval.target_ref).toBe(
        executableApproval.target_resource_space_ids_json,
      );
      expect(executableApproval.action_digest).toBe(
        actionDigestOfInvocation({
          toolName: executableApproval.stable_action_id,
          toolVersion: executableApproval.action_version,
          argumentsJson: executableApproval.arguments_json,
        }),
      );
      const oldAcquireEventStart = events.length;
      const approvalResolution = await client.command(
        project.projectId,
        "ResolveExecutableApproval",
        {
          approvalId: executableApprovalId,
          expectedRevision: executableApprovalRevision,
          decision: "Approve",
          reason:
            "Approve the exact shell invocation before testing P4 effect admission",
        },
      );
      expect(approvalResolution).toMatchObject({
        body: { resolution: "Committed" },
      });

      const oldAdmission = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "old" && event.boundary === scenario.boundary,
          ),
        (event) => event !== undefined,
        45_000,
      );
      if (
        oldAdmission?.executionId === undefined ||
        oldAdmission.invocationId === undefined ||
        oldAdmission.callRef === undefined
      ) {
        throw new Error("P4 effect-admission boundary omitted identity");
      }
      const { executionId, invocationId, callRef } = oldAdmission;
      const oldLeaseAcquired = events
        .slice(oldAcquireEventStart)
        .filter(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH10AfterLeaseAcquired" &&
            event.executionId === executionId,
        )
        .at(-1);
      if (
        oldLeaseAcquired?.fencingGeneration === undefined ||
        !Number.isSafeInteger(oldLeaseAcquired.fencingGeneration) ||
        oldLeaseAcquired.fencingGeneration < 0
      ) {
        throw new Error(
          "P4 executable-approval continuation had no exact old-owner lease probe",
        );
      }
      const oldGeneration = oldLeaseAcquired.fencingGeneration;
      const beforeTakeover = readRows(
        fixture.databaseFile,
        executionId,
        invocationId,
        callRef,
        approval.approvalId,
        executableApprovalId,
      );
      expect(beforeTakeover.invocation).toMatchObject({
        invocation_id: invocationId,
        execution_id: executionId,
        workspace_id: project.rootWorkspaceId,
        tool_name: "shell",
        tool_version: shellDefinition.version,
        side_effect_semantics: scenario.sideEffectSemantics,
        approval_id: executableApprovalId,
        arguments_json: executableApproval.arguments_json,
        effect_admission_state: scenario.admission,
        settled_at: null,
      });
      expect(
        JSON.parse(
          beforeTakeover.invocation?.resolved_regions_json ?? "[]",
        ).map(
          (region: { readonly resourceSpaceId: string }) =>
            region.resourceSpaceId,
        ),
      ).toEqual(JSON.parse(executableApproval.target_resource_space_ids_json));
      expect(beforeTakeover.lease).toMatchObject({
        execution_id: executionId,
        generation: oldGeneration,
      });
      expect(beforeTakeover.action).toMatchObject({
        call_ref: callRef,
        action_kind: "shell",
        state: "Pending",
        observation_source_ref: null,
      });
      expect(beforeTakeover.step?.provider_turn_id).toMatch(/^ptn_/u);
      expect(beforeTakeover.workApproval).toMatchObject({
        route_kind: "Control",
        state: "Consumed",
      });
      expect(beforeTakeover.executableApprovalCount).toBe(1);
      expect(beforeTakeover.shellInvocationCount).toBe(1);
      expect(beforeTakeover.executableApproval).toMatchObject({
        approval_id: executableApprovalId,
        route_kind: "Executable",
        project_id: project.projectId,
        workspace_id: project.rootWorkspaceId,
        execution_id: executionId,
        execution_workspace_id: project.rootWorkspaceId,
        episode_kind: "WorkEpisode",
        episode_ref: work.workId,
        stable_action_id: beforeTakeover.invocation?.tool_name,
        action_version: beforeTakeover.invocation?.tool_version,
        side_effect_semantics: beforeTakeover.invocation?.side_effect_semantics,
        action_digest: actionDigestOfInvocation({
          toolName: beforeTakeover.invocation?.tool_name ?? "",
          toolVersion: beforeTakeover.invocation?.tool_version ?? "",
          argumentsJson: beforeTakeover.invocation?.arguments_json ?? "",
        }),
        arguments_json: beforeTakeover.invocation?.arguments_json,
        target_ref: executableApproval.target_ref,
        state: "Consumed",
        decided_at: expect.any(String),
        consumed_at: expect.any(String),
        consumed_by: invocationId,
        binding_proven: 1,
        tool_invocation_id: invocationId,
        logical_action_id: beforeTakeover.action?.logical_action_id,
        call_ref: callRef,
        action_kind: "shell",
        action_route_kind: "Executable",
        action_state: "Pending",
        action_call_ref: callRef,
      });
      expect(beforeTakeover.executableApproval?.state).toBe("Consumed");
      expect(beforeTakeover.executableApproval?.revision).toBeGreaterThan(
        executableApprovalRevision,
      );
      expect(beforeTakeover.toolResults).toHaveLength(0);
      expect(
        beforeTakeover.observations.filter(
          (observation) =>
            observation.source_ref ===
            beforeTakeover.action?.observation_source_ref,
        ),
      ).toHaveLength(0);
      expect(existsSync(join(fixture.workspaceDirectory, effectFile))).toBe(
        false,
      );

      const gateDirectory = join(fixture.directory, "p4-fence-gates");
      mkdirSync(gateDirectory, { recursive: true });
      writeFileSync(
        join(gateDirectory, "old-freeze-renewal.request"),
        "pause old lease renewal",
      );
      await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "old" &&
              event.boundary === "AH10BeforeLeaseRenewal" &&
              event.executionId === executionId,
          ),
        (event) => event !== undefined,
        20_000,
      );
      const leaseDb = new DatabaseSync(fixture.databaseFile);
      try {
        leaseDb
          .prepare(
            "UPDATE execution_leases SET expires_at = ? WHERE execution_id = ? AND generation = ?",
          )
          .run("2000-01-01T00:00:00.000Z", executionId, oldGeneration);
      } finally {
        leaseDb.close();
      }

      const newDaemon = await fixture.startAdditionalDaemon({
        entry: fenceChild,
        daemonEnvironment: {
          ARBOR_P4_FENCE_ROLE: "new",
          ARBOR_P4_FENCE_PAUSE_NEW: "1",
          ...(scenario.sideEffectSemantics === "NonIdempotent"
            ? { ARBOR_P4_FENCE_NON_IDEMPOTENT: "1" }
            : {}),
        },
        onStdout: (line) => recordProbe(events, line),
      });
      const newLease = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "AH10AfterLeaseAcquired" &&
              event.executionId === executionId,
          ),
        (event) => event !== undefined,
        45_000,
      );
      expect(newLease?.fencingGeneration).toBe(oldGeneration + 1);
      await fixture.crash();
      const afterOldCrash = readRows(
        fixture.databaseFile,
        executionId,
        invocationId,
        callRef,
        approval.approvalId,
        executableApprovalId,
      );
      expect(afterOldCrash.invocation?.effect_admission_state).toBe(
        scenario.admission,
      );
      expect(afterOldCrash.invocation).toMatchObject({
        approval_id: executableApprovalId,
        tool_name: "shell",
        tool_version: shellDefinition.version,
        side_effect_semantics: scenario.sideEffectSemantics,
      });
      expect(afterOldCrash.executableApprovalCount).toBe(1);
      expect(afterOldCrash.shellInvocationCount).toBe(1);
      expect(afterOldCrash.executableApproval).toMatchObject({
        approval_id: executableApprovalId,
        state: "Consumed",
        consumed_by: invocationId,
        tool_invocation_id: invocationId,
        action_state: "Pending",
      });
      expect(afterOldCrash.lease?.generation).toBe(oldGeneration + 1);
      expect(existsSync(join(fixture.workspaceDirectory, effectFile))).toBe(
        false,
      );
      writeFileSync(
        join(gateDirectory, "new-new-driver.release"),
        "drive generation one recovery",
      );

      if (scenario.admission === "NotAdmitted") {
        const recovered = await waitForPublic(
          async () =>
            readRows(
              fixture.databaseFile,
              executionId,
              invocationId,
              callRef,
              approval.approvalId,
              executableApprovalId,
            ),
          (rows) => {
            const successorTurn = rows.providerTurns.find(
              (turn) =>
                turn.provider_turn_id !==
                  beforeTakeover.step?.provider_turn_id &&
                turn.settled_at !== null,
            );
            return (
              rows.invocation?.settlement_kind === "Success" &&
              rows.action?.state === "Applied" &&
              rows.toolResults.length === 1 &&
              successorTurn !== undefined &&
              rows.modelOutputSources.some(
                (source) =>
                  source.source_ref ===
                  `${successorTurn.provider_turn_id}:assistant`,
              )
            );
          },
          60_000,
        );
        expect(recovered.invocation).toMatchObject({
          invocation_id: invocationId,
          effect_admission_state: "MayHaveStarted",
          settlement_kind: "Success",
          approval_id: executableApprovalId,
        });
        expect(recovered.action).toMatchObject({
          logical_action_id: beforeTakeover.action?.logical_action_id,
          call_ref: callRef,
          state: "Applied",
        });
        expect(recovered.action?.observation_source_ref).toEqual(
          expect.any(String),
        );
        expect(recovered.step?.provider_turn_id).toBe(
          beforeTakeover.step?.provider_turn_id,
        );
        expect(recovered.step).toMatchObject({
          logical_step_no: beforeTakeover.step?.logical_step_no,
          repair_attempt: beforeTakeover.step?.repair_attempt,
          decoded_output_hash: beforeTakeover.step?.decoded_output_hash,
          model_output_session_sequence:
            beforeTakeover.step?.model_output_session_sequence,
          next_action_index: 1,
        });
        expect(recovered.toolResults).toHaveLength(1);
        const result = JSON.parse(
          recovered.toolResults[0]?.payload_json ?? "{}",
        ) as { callRef?: string; invocationId?: string };
        expect(result).toMatchObject({ callRef, invocationId });
        const originalProviderTurnId =
          beforeTakeover.step?.provider_turn_id ?? "";
        const originalModelOutput = beforeTakeover.modelOutputSources.filter(
          (source) =>
            source.source_ref === `${originalProviderTurnId}:assistant`,
        );
        expect(originalModelOutput).toHaveLength(1);
        expect(
          recovered.modelOutputSources.filter(
            (source) =>
              source.source_ref === `${originalProviderTurnId}:assistant`,
          ),
        ).toEqual(originalModelOutput);
        expect(
          recovered.providerAttempts.filter(
            (attempt) => attempt.provider_turn_id === originalProviderTurnId,
          ),
        ).toEqual(
          beforeTakeover.providerAttempts.filter(
            (attempt) => attempt.provider_turn_id === originalProviderTurnId,
          ),
        );
        const successorTurn = recovered.providerTurns.find(
          (turn) => turn.provider_turn_id !== originalProviderTurnId,
        );
        expect(successorTurn).toBeDefined();
        const successorStep = recovered.steps.find(
          (step) =>
            step.logical_step_no ===
              (beforeTakeover.step?.logical_step_no ?? -1) + 1 &&
            step.repair_attempt === 0,
        );
        expect(successorStep?.provider_turn_id).toBe(
          successorTurn?.provider_turn_id,
        );
        expect(successorStep?.provider_turn_id).not.toBe(
          originalProviderTurnId,
        );
        expect(
          recovered.modelOutputSources.filter(
            (source) =>
              source.source_ref ===
              `${successorTurn?.provider_turn_id}:assistant`,
          ),
        ).toHaveLength(1);
        expect(
          readFileSync(join(fixture.workspaceDirectory, effectFile), "utf8")
            .split(/\r?\n/u)
            .filter((line) => line === effectMarker),
        ).toHaveLength(1);
      } else {
        const recovered = await waitForPublic(
          async () =>
            readRows(
              fixture.databaseFile,
              executionId,
              invocationId,
              callRef,
              approval.approvalId,
              executableApprovalId,
            ),
          (rows) =>
            rows.execution?.settlement_kind === "OutcomeUnknown" &&
            rows.action?.state === "ReconciliationPending",
          60_000,
        );
        expect(recovered.invocation).toMatchObject({
          invocation_id: invocationId,
          effect_admission_state: "MayHaveStarted",
          settled_at: null,
          settlement_kind: null,
          approval_id: executableApprovalId,
        });
        expect(recovered.execution).toMatchObject({
          settlement_kind: "OutcomeUnknown",
        });
        expect(
          JSON.parse(recovered.execution?.settlement_json ?? "null"),
        ).toEqual({
          _tag: "OutcomeUnknown",
          reconciliation: {
            _tag: "ReconciliationRequired",
            invocationRefs: [invocationId],
          },
        });
        expect(recovered.action).toMatchObject({
          logical_action_id: beforeTakeover.action?.logical_action_id,
          call_ref: callRef,
          state: "ReconciliationPending",
        });
        expect(
          JSON.parse(recovered.action?.disposition_json ?? "null"),
        ).toEqual({
          _tag: "ExecutionSettlement:OutcomeUnknown",
          status: "OutcomeUnknown",
        });
        expect(recovered.step?.provider_turn_id).toBe(
          beforeTakeover.step?.provider_turn_id,
        );
        expect(recovered.shellInvocationCount).toBe(1);
        const actionObservations = recovered.observations.filter(
          (observation) =>
            observation.source_ref === recovered.action?.observation_source_ref,
        );
        const terminalProjectionRefs = new Set([
          ...recovered.toolResults.map((result) => result.source_ref),
          ...actionObservations.map((observation) => observation.source_ref),
        ]);
        // A typed unresolved ToolResult is also stored as the action's
        // Observation entry, so count the one canonical sourceRef once.
        expect(terminalProjectionRefs.size).toBe(1);
        const terminalResult = JSON.parse(
          recovered.toolResults[0]?.payload_json ?? "{}",
        ) as Record<string, unknown>;
        expect(terminalResult).toMatchObject({
          _tag: "ToolResult",
          callRef,
          status: "OutcomeUnknown",
          outputText: "Control action settled the execution (OutcomeUnknown)",
          artifactRefs: [],
        });
        expect(recovered.toolResults).toHaveLength(1);
        expect(recovered.toolResults[0]).toMatchObject({
          source_kind: "AgentLoopAction",
          source_ref: recovered.action?.observation_source_ref,
        });
        expect(terminalResult.invocationId).toBeUndefined();
        expect(terminalResult.canonicalRefs).toBeUndefined();
        expect(existsSync(join(fixture.workspaceDirectory, effectFile))).toBe(
          false,
        );
      }
      // NotAdmitted resumes the original Step's persisted ModelOutput and then
      // legitimately asks its distinct successor ProviderTurn to consume the
      // ToolResult. MayHaveStarted recovery stops before another model request.
      if (scenario.admission === "NotAdmitted") {
        expect(targetProviderCalls).toBeGreaterThan(1);
      } else {
        expect(targetProviderCalls).toBe(1);
      }
      expect(existsSync(join(fixture.workspaceDirectory, effectFile))).toBe(
        scenario.admission === "NotAdmitted",
      );
      expect(fixture.daemonErrors).toEqual([]);
      expect(newDaemon.daemonErrors).toEqual([]);
    }, 180_000);
  }
});
