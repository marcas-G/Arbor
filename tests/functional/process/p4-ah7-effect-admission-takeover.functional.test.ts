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
}

interface AdmissionRows {
  readonly lease:
    | { readonly execution_id: string; readonly generation: number }
    | undefined;
  readonly invocation:
    | {
        readonly invocation_id: string;
        readonly execution_id: string;
        readonly tool_name: string;
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
        readonly settled_at: string | null;
      }
    | undefined;
  readonly step:
    | { readonly provider_turn_id: string; readonly next_action_index: number }
    | undefined;
  readonly action:
    | {
        readonly logical_action_id: string;
        readonly call_ref: string;
        readonly action_kind: string;
        readonly state: string;
        readonly observation_source_ref: string | null;
      }
    | undefined;
  readonly toolResults: ReadonlyArray<{ readonly payload_json: string }>;
  readonly workApproval:
    | { readonly route_kind: string; readonly state: string }
    | undefined;
  readonly executableApprovalCount: number;
}

const fixtures: ProductionFixture[] = [];
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
  approvalId: string,
): AdmissionRows => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      lease: db
        .prepare(
          "SELECT execution_id, generation FROM execution_leases WHERE execution_id = ?",
        )
        .get(executionId) as AdmissionRows["lease"],
      invocation: db
        .prepare(
          `SELECT invocation_id, execution_id, tool_name,
                  side_effect_semantics, approval_id, effect_admission_state,
                  settled_at, settlement_kind
             FROM tool_invocations WHERE invocation_id = ?`,
        )
        .get(invocationId) as AdmissionRows["invocation"],
      execution: db
        .prepare(
          "SELECT settlement_kind, settled_at FROM executions WHERE execution_id = ?",
        )
        .get(executionId) as AdmissionRows["execution"],
      step: db
        .prepare(
          `SELECT s.provider_turn_id, s.next_action_index
             FROM agent_loop_steps s
             JOIN agent_loop_step_actions a
               ON a.execution_id = s.execution_id
              AND a.logical_step_no = s.logical_step_no
              AND a.repair_attempt = s.repair_attempt
            WHERE a.execution_id = ? AND a.call_ref = ?`,
        )
        .get(executionId, callRef) as AdmissionRows["step"],
      action: db
        .prepare(
          `SELECT logical_action_id, call_ref, action_kind, state,
                  observation_source_ref
             FROM agent_loop_step_actions
            WHERE execution_id = ? AND call_ref = ?`,
        )
        .get(executionId, callRef) as AdmissionRows["action"],
      toolResults: db
        .prepare(
          `SELECT payload_json FROM session_entries
            WHERE item_type = 'ToolResult'
              AND json_extract(payload_json, '$.invocationId') = ?
              AND json_extract(payload_json, '$.callRef') = ?`,
        )
        .all(invocationId, callRef) as AdmissionRows["toolResults"],
      workApproval: db
        .prepare(
          "SELECT route_kind, state FROM action_approvals WHERE approval_id = ?",
        )
        .get(approvalId) as AdmissionRows["workApproval"],
      executableApprovalCount: (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM action_approvals WHERE route_kind = 'Executable' AND execution_id = ?",
          )
          .get(executionId) as { readonly count: number }
      ).count,
    };
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
        expiresAt: null,
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
          value?.workId !== undefined &&
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
          value?.workId === work.workId && value.activeExecution === undefined,
      );
      if (idleWork?.workId === undefined) throw new Error("Work did not idle");
      await client.command(project.projectId, "SteerWork", {
        workId: idleWork.workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: idleWork.revision,
        steer: { severity: "Normal", guidance: steerMarker },
        provenance: { source: "HumanInput" },
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
      const beforeTakeover = readRows(
        fixture.databaseFile,
        executionId,
        invocationId,
        callRef,
        approval.approvalId,
      );
      expect(beforeTakeover.invocation).toMatchObject({
        invocation_id: invocationId,
        execution_id: executionId,
        tool_name: "shell",
        side_effect_semantics: scenario.sideEffectSemantics,
        approval_id: null,
        effect_admission_state: scenario.admission,
        settled_at: null,
      });
      expect(beforeTakeover.lease).toMatchObject({
        execution_id: executionId,
        generation: 0,
      });
      expect(beforeTakeover.action).toMatchObject({
        call_ref: callRef,
        action_kind: "shell",
        state: "Pending",
      });
      expect(beforeTakeover.step?.provider_turn_id).toMatch(/^ptn_/u);
      expect(beforeTakeover.workApproval).toMatchObject({
        route_kind: "Control",
        state: "Consumed",
      });
      expect(beforeTakeover.executableApprovalCount).toBe(0);
      expect(beforeTakeover.toolResults).toHaveLength(0);
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
            "UPDATE execution_leases SET expires_at = ? WHERE execution_id = ? AND generation = 0",
          )
          .run("2000-01-01T00:00:00.000Z", executionId);
      } finally {
        leaseDb.close();
      }

      const newDaemon = await fixture.startAdditionalDaemon({
        entry: fenceChild,
        daemonEnvironment: {
          ARBOR_P4_FENCE_ROLE: "new",
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
              event.executionId === executionId,
          ),
        (event) => event !== undefined,
        45_000,
      );
      expect(newLease?.fencingGeneration).toBe(1);
      await fixture.crash();
      const afterOldCrash = readRows(
        fixture.databaseFile,
        executionId,
        invocationId,
        callRef,
        approval.approvalId,
      );
      expect(afterOldCrash.invocation?.effect_admission_state).toBe(
        scenario.admission,
      );
      expect(afterOldCrash.lease?.generation).toBe(1);
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
            ),
          (rows) =>
            rows.invocation?.settlement_kind === "Success" &&
            rows.action?.state === "Applied" &&
            rows.toolResults.length === 1,
          60_000,
        );
        expect(recovered.invocation).toMatchObject({
          invocation_id: invocationId,
          effect_admission_state: "MayHaveStarted",
          settlement_kind: "Success",
          approval_id: null,
        });
        expect(recovered.action).toMatchObject({
          logical_action_id: beforeTakeover.action?.logical_action_id,
          call_ref: callRef,
          state: "Applied",
        });
        expect(recovered.step?.provider_turn_id).toBe(
          beforeTakeover.step?.provider_turn_id,
        );
        expect(recovered.toolResults).toHaveLength(1);
        const result = JSON.parse(
          recovered.toolResults[0]?.payload_json ?? "{}",
        ) as { callRef?: string; invocationId?: string };
        expect(result).toMatchObject({ callRef, invocationId });
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
            ),
          (rows) =>
            rows.execution?.settlement_kind === "OutcomeUnknown" &&
            rows.action?.state === "ReconciliationPending",
          60_000,
        );
        expect(recovered.invocation).toMatchObject({
          invocation_id: invocationId,
          effect_admission_state: "MayHaveStarted",
          settled_at:
            scenario.sideEffectSemantics === "NonIdempotent"
              ? expect.any(String)
              : null,
          settlement_kind:
            scenario.sideEffectSemantics === "NonIdempotent"
              ? "OutcomeUnknown"
              : null,
          approval_id: null,
        });
        expect(recovered.action).toMatchObject({
          logical_action_id: beforeTakeover.action?.logical_action_id,
          call_ref: callRef,
          state: "ReconciliationPending",
        });
        expect(recovered.step?.provider_turn_id).toBe(
          beforeTakeover.step?.provider_turn_id,
        );
        expect(recovered.toolResults).toHaveLength(0);
        expect(existsSync(join(fixture.workspaceDirectory, effectFile))).toBe(
          false,
        );
      }
      expect(targetProviderCalls).toBe(1);
      expect(existsSync(join(fixture.workspaceDirectory, effectFile))).toBe(
        scenario.admission === "NotAdmitted",
      );
      expect(fixture.daemonErrors).toEqual([]);
      expect(newDaemon.daemonErrors).toEqual([]);
    }, 180_000);
  }
});
