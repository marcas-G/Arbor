import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { p39WindowsTestEnvironment } from "../../support/p39-windows-deployment-test.js";
import { expireExecutionLeaseAfterOwnerExitForQualification } from "../support/lease-qualification.js";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  admitRootWorkThroughPublicConversation,
  createFunctionalProject,
  makePublicClient,
  waitForPublic,
} from "../support/public-client.js";

interface Probe {
  readonly tag: "AH10_PROBE";
  readonly role: "old" | "new";
  readonly boundary: string;
  readonly executionId: string;
  readonly providerTurnId?: string;
  readonly logicalActionId?: string;
  readonly actionKind?: string;
  readonly actionIndex?: number;
  readonly callRef?: string;
  readonly fencingGeneration?: number;
}

const fixtures: ProductionFixture[] = [];
const ah10Child = resolve("tests/functional/support/ah10-process-child.mjs");

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

const manualWait = (reason: string) => ({
  _tag: "ToolCall" as const,
  name: "wait",
  arguments: {
    reason,
    waitSpec: { mode: "Any" as const, conditions: [{ _tag: "Manual" }] },
  },
});

const readSnapshot = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      leases: db
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases",
        )
        .all() as Array<{
        execution_id: string;
        generation: number;
        expires_at: string;
      }>,
      executions: db
        .prepare(
          "SELECT execution_id, binding_kind, settlement_kind, settlement_json, settled_at FROM executions ORDER BY admitted_at",
        )
        .all() as Array<{
        execution_id: string;
        binding_kind: string;
        settlement_kind: string | null;
        settlement_json: string | null;
        settled_at: string | null;
      }>,
      commands: db
        .prepare("SELECT command_id, resolution, result_json FROM commands")
        .all() as Array<{
        command_id: string;
        resolution: string;
        result_json: string | null;
      }>,
      evidence: db
        .prepare(
          "SELECT evidence_id, verification_id, recorded_at FROM verification_evidence",
        )
        .all() as Array<{
        evidence_id: string;
        verification_id: string;
        recorded_at: string;
      }>,
      verifications: db
        .prepare(
          "SELECT verification_id, state, verdict, snapshot_status FROM verifications",
        )
        .all() as Array<{
        verification_id: string;
        state: string;
        verdict: string | null;
        snapshot_status: string;
      }>,
      events: db
        .prepare(
          "SELECT event_type, caused_by_command_id FROM domain_events WHERE event_type = 'VerificationConcluded'",
        )
        .all() as Array<{
        event_type: string;
        caused_by_command_id: string | null;
      }>,
      actions: db
        .prepare(
          `SELECT a.execution_id,s.provider_turn_id,a.logical_step_no,a.repair_attempt,
                  a.action_index,a.logical_action_id,a.call_ref,a.route_kind,a.action_kind,
                  a.state,a.result_ref,a.settlement_ref,a.observation_source_ref
           FROM agent_loop_step_actions a JOIN agent_loop_steps s
             ON s.execution_id=a.execution_id AND s.logical_step_no=a.logical_step_no
            AND s.repair_attempt=a.repair_attempt
           ORDER BY a.execution_id,a.logical_step_no,a.repair_attempt,a.action_index`,
        )
        .all() as Array<{
        execution_id: string;
        provider_turn_id: string;
        logical_step_no: number;
        repair_attempt: number;
        action_index: number;
        logical_action_id: string;
        call_ref: string;
        route_kind: string;
        action_kind: string;
        state: string;
        result_ref: string | null;
        settlement_ref: string | null;
        observation_source_ref: string | null;
      }>,
      steps: db
        .prepare(
          "SELECT execution_id, logical_step_no, repair_attempt, provider_turn_id, state, next_action_index, decoded_output_hash, model_output_session_sequence, settlement_json FROM agent_loop_steps ORDER BY execution_id, logical_step_no, repair_attempt",
        )
        .all() as Array<{
        execution_id: string;
        logical_step_no: number;
        repair_attempt: number;
        provider_turn_id: string;
        state: string;
        next_action_index: number;
        decoded_output_hash: string | null;
        model_output_session_sequence: number | null;
        settlement_json: string | null;
      }>,
      turnManifests: db
        .prepare(
          "SELECT provider_turn_id, json_extract(manifest_json, '$.toolRoutes') AS tool_routes FROM model_context_manifests ORDER BY created_at",
        )
        .all() as Array<{
        provider_turn_id: string;
        tool_routes: string | null;
      }>,
      toolInvocations: db
        .prepare(
          "SELECT invocation_id, execution_id, tool_name, arguments_json, settlement_kind, settlement_json FROM tool_invocations ORDER BY rowid DESC LIMIT 8",
        )
        .all() as Array<{
        invocation_id: string;
        execution_id: string;
        tool_name: string;
        arguments_json: string;
        settlement_kind: string | null;
        settlement_json: string | null;
      }>,
      toolResults: db
        .prepare(
          "SELECT session_id,sequence,entry_kind,source_kind,source_ref,payload_json FROM session_entries WHERE payload_json LIKE '%ToolResult%' OR payload_json LIKE '%ControlResult%' ORDER BY sequence DESC LIMIT 32",
        )
        .all() as Array<{
        session_id: string;
        sequence: number;
        entry_kind: string;
        source_kind: string;
        source_ref: string;
        payload_json: string;
      }>,
      settlementEvents: db
        .prepare(
          "SELECT event_id,sequence,event_type,occurred_at,actor,caused_by_command_id,payload_json FROM domain_events WHERE event_type='ExecutionSettled' ORDER BY sequence DESC LIMIT 32",
        )
        .all() as Array<Record<string, unknown>>,
      timeline: db
        .prepare(
          "SELECT sequence, entry_kind, source_kind, source_ref, payload_json FROM session_entries ORDER BY sequence DESC LIMIT 16",
        )
        .all() as Array<{
        sequence: number;
        entry_kind: string;
        source_kind: string;
        source_ref: string;
        payload_json: string;
      }>,
      observations: db
        .prepare(
          "SELECT source_ref, payload_json FROM session_entries WHERE source_kind = 'AgentLoopAction' AND entry_kind = 'Observation'",
        )
        .all() as Array<{ source_ref: string; payload_json: string }>,
    };
  } finally {
    db.close();
  }
};

const pushProbe = (events: Probe[], line: string) => {
  try {
    const event = JSON.parse(line) as Probe;
    if (event.tag === "AH10_PROBE") events.push(event);
  } catch {
    // Fixture output is retained by the daemon when a qualification fails.
  }
};

const releaseGate = (
  fixture: ProductionFixture,
  role: string,
  gate: string,
) => {
  writeFileSync(
    resolve(fixture.directory, "ah10-gates", `${role}-${gate}.release`),
    "release",
  );
};

describe("AH10 P8 verification control takeover", () => {
  it("passes the P39 PowerShell module path from Vitest through a child Node process", () => {
    const testEnvironment = p39WindowsTestEnvironment();
    if (process.platform !== "win32") return;
    const expected = resolve(
      process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "Modules",
    );
    expect(process.env.PSModulePath).toBe(expected);
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        "const cp=require('node:child_process'); process.stdout.write(JSON.stringify({PSModulePath:process.env.PSModulePath})+'\\n'); process.stdout.write(cp.execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Import-Module Microsoft.PowerShell.Security; (Get-Acl -LiteralPath C:\\\\Windows).Owner'],{encoding:'utf8'}));",
      ],
      { encoding: "utf8", env: testEnvironment, windowsHide: true },
    );
    const [modulePathLine] = output.split(/\r?\n/u);
    expect(JSON.parse(modulePathLine ?? "{}")).toEqual({
      PSModulePath: expected,
    });
    expect(output).toContain("TrustedInstaller");
  });

  it("recovers a committed RecordVerificationEvidence command before Observation after two-daemon restart", async () => {
    const marker = `AH10-VCS-RECORD-${crypto.randomUUID().slice(0, 8)}`;
    const events: Probe[] = [];
    const daemonOutput: string[] = [];
    let probeArmed = false;
    let seedWaitIssued = false;
    let evidenceSourceReadIssued = false;
    let targetActionCalls = 0;
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      admitWorkspaceDirectory: true,
      daemonEnvironment: { ARBOR_AH19_STARTUP_TRACE: "1" },
      reply: (call) => {
        const context = JSON.stringify(call.messages);
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        if (
          available.has("assign_work") &&
          !available.has("claim_completion") &&
          context.includes(marker)
        ) {
          return context.includes("WorkAssigned(")
            ? { _tag: "Text", text: `Work started for ${marker}` }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Complete ${marker}.`,
                  why: "qualify AH10 P8 verification receipt takeover",
                  constraints: [],
                  completionExpectation: "independently verified",
                  verificationMission: {
                    goal: `Verify ${marker}`,
                    criteria: [
                      {
                        criterionId: "ah10-verification-takeover",
                        requirement: `verify ${marker}`,
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "AH10 process fixture",
                },
              };
        }
        if (context.includes(marker) && available.has("claim_completion")) {
          if (!probeArmed) {
            seedWaitIssued = true;
            return manualWait(`seed AH10 P8 verifier takeover ${marker}`);
          }
          return {
            _tag: "ToolCall",
            name: "claim_completion",
            arguments: { claim: `complete ${marker} before verification` },
          };
        }
        if (
          context.includes(marker) &&
          available.has("record_verification_evidence")
        ) {
          const evidenceIds = [...context.matchAll(/evd_[0-9a-f-]{36}/gu)].map(
            (match) => match[0],
          );
          if (!evidenceSourceReadIssued) {
            evidenceSourceReadIssued = true;
            return {
              _tag: "ToolCall",
              name: "read",
              arguments: {
                target: { mount: "workspace", path: "proof.txt" },
                limit: 80,
              },
            };
          }
          if (evidenceIds.length === 0) {
            targetActionCalls += 1;
            return {
              _tag: "ToolCall",
              name: "record_verification_evidence",
              arguments: {
                criterionId: "ah10-verification-takeover",
                sourceCallRef: "1",
              },
            };
          }
          return {
            _tag: "ToolCall",
            name: "conclude_verification",
            arguments: {
              verdict: "Pass",
              criteriaResults: [
                {
                  criterionId: "ah10-verification-takeover",
                  requirement: `verify ${marker}`,
                  required: true,
                  verdict: "Pass",
                  evidenceRefs: [evidenceIds.at(-1)],
                },
              ],
              summary: `AH10 evidence recorded for ${marker}.`,
            },
          };
        }
        if (available.has("claim_completion")) {
          return {
            _tag: "ToolCall",
            name: "claim_completion",
            arguments: { claim: `complete ${marker}` },
          };
        }
        return { _tag: "Text", text: `Observed ${marker}` };
      },
      onDaemonStdout: (line) => {
        daemonOutput.push(line);
        pushProbe(events, line);
      },
    });
    fixtures.push(fixture);
    mkdirSync(resolve(fixture.directory, "ah10-gates"), { recursive: true });
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "AH10 P8 evidence receipt takeover",
      { resourceSelection: "Profile" },
    );
    const work = await admitRootWorkThroughPublicConversation(
      client,
      project,
      marker,
      `Please admit Work ${marker} for verifier receipt recovery.`,
    );
    const waitingWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
          activeExecution?: unknown;
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (current) =>
        seedWaitIssued &&
        current?.workId === work.workId &&
        current.status === "Open" &&
        current.activeExecution === undefined,
    );
    if (waitingWork?.workId !== work.workId)
      throw new Error(
        "P8 takeover fixture did not reach the seeded Manual wait",
      );

    await fixture.crash();
    probeArmed = true;
    await fixture.restart({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "old",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "1",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_KIND: "record_verification_evidence",
        ARBOR_AH10_GATE_ACTION_KIND: "record_verification_evidence",
      },
    });
    await client.command(project.projectId, "SteerWork", {
      workId: work.workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: waitingWork.revision,
      steer: { severity: "Normal", guidance: `Resume ${marker} verification.` },
      provenance: { source: "HumanInput" },
    });
    const oldAction = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary === "AH7AfterActionIntentCommit" &&
            event.actionKind === "record_verification_evidence",
        ),
      (event) => event !== undefined,
      45_000,
    ).catch((error: unknown) => {
      throw new Error(
        `RecordVerificationEvidence intent not observed: ${error instanceof Error ? error.message : String(error)}; events=${JSON.stringify(events.slice(-8).map(({ boundary, actionKind, logicalActionId }) => ({ boundary, actionKind, logicalActionId })))}; providerCalls=${JSON.stringify(fixture.providerCalls.slice(-3).map((call) => ({ toolNames: call.tools.map((tool) => tool.function?.name), messages: call.messages.slice(-3).map((message) => ({ role: message.role, content: message.content?.slice(-300) })) })))}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile))}; stdout=${daemonOutput.slice(-6).join(" | ")}; stderr=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    if (oldAction === undefined)
      throw new Error("old RecordVerificationEvidence intent not observed");
    releaseGate(fixture, "old", "action-intent");
    const oldReturn = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "old" &&
            event.boundary ===
              "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
            event.logicalActionId === oldAction.logicalActionId,
        ),
      (event) => event !== undefined,
      8_000,
    ).catch((error: unknown) => {
      const snapshot = readSnapshot(fixture.databaseFile);
      throw new Error(
        `RecordVerificationEvidence did not reach control-return boundary: ${error instanceof Error ? error.message : String(error)}; oldAction=${JSON.stringify(oldAction)}; providerCalls=${JSON.stringify(fixture.providerCalls.slice(-2).map((call) => ({ tools: call.tools.map((tool) => tool.function?.name), messages: call.messages.slice(-4).map((message) => ({ role: message.role, content: message.content?.slice(-250) })) })))}; invocations=${JSON.stringify(snapshot.toolInvocations)}; toolResults=${JSON.stringify(snapshot.toolResults)}; actions=${JSON.stringify(snapshot.actions.filter((action) => action.action_kind === "read" || action.action_kind === "shell" || action.action_kind === "record_verification_evidence").slice(-6))}; events=${JSON.stringify(snapshot.events)}; stdout=${daemonOutput.slice(-6).join(" | ")}; stderr=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    expect(oldReturn).toBeDefined();
    const committed = readSnapshot(fixture.databaseFile);
    expect(committed.evidence).toHaveLength(1);
    expect(
      committed.commands.filter(
        (row) =>
          row.resolution === "Committed" &&
          row.result_json?.includes('"evidenceId"'),
      ),
    ).toHaveLength(1);
    expect(committed.actions).toContainEqual(
      expect.objectContaining({
        logical_action_id: oldAction.logicalActionId,
        action_kind: "record_verification_evidence",
        state: "Pending",
      }),
    );
    expect(
      committed.observations.filter((row) =>
        row.payload_json.includes("VerificationEvidenceRecorded("),
      ),
    ).toHaveLength(0);
    expect(targetActionCalls).toBe(1);

    await fixture.crash();
    await expireExecutionLeaseAfterOwnerExitForQualification({
      databaseFile: fixture.databaseFile,
      executionId: oldAction.executionId,
      daemon: { crash: fixture.crash, snapshot: fixture.daemonProcessSnapshot },
    });
    const newDaemon = await fixture.startAdditionalDaemon({
      entry: ah10Child,
      daemonEnvironment: {
        ARBOR_AH10_ROLE: "new",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "1",
        ARBOR_AH10_PAUSE_AFTER_CONTROL_KIND: "record_verification_evidence",
        ARBOR_AH10_GATE_ACTION_KIND: "record_verification_evidence",
      },
      onStdout: (line) => pushProbe(events, line),
    });
    const newLease = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary === "AH10AfterLeaseAcquired" &&
            event.executionId === oldAction.executionId,
        ),
      (event) => event !== undefined,
      45_000,
    );
    expect(newLease?.fencingGeneration).toBe(1);
    const recoveredAction = await waitForPublic(
      async () =>
        events.find(
          (event) =>
            event.role === "new" &&
            event.boundary ===
              "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
            event.logicalActionId === oldAction.logicalActionId,
        ),
      (event) => event !== undefined,
      3_000,
    ).catch((error: unknown) => {
      const snapshot = readSnapshot(fixture.databaseFile);
      const priorTurnManifest = snapshot.turnManifests.find(
        (turn) => turn.provider_turn_id === oldAction.providerTurnId,
      );
      const priorTurnRoutes = JSON.parse(
        priorTurnManifest?.tool_routes ?? "[]",
      ) as Array<{ name?: unknown; route?: unknown; stableId?: unknown }>;
      throw new Error(
        `new daemon did not reopen the same P8 ActionIntent: ${error instanceof Error ? error.message : String(error)}; targetExecution=${oldAction.executionId}; leaseRows=${JSON.stringify(snapshot.leases.filter((row) => row.execution_id === oldAction.executionId))}; executionSettlement=${JSON.stringify(snapshot.executions.find((row) => row.execution_id === oldAction.executionId))}; stepRows=${JSON.stringify(snapshot.steps.filter((step) => step.execution_id === oldAction.executionId))}; everyActionTuple=${JSON.stringify(snapshot.actions.filter((action) => action.execution_id === oldAction.executionId))}; correspondingToolResults=${JSON.stringify(snapshot.toolResults)}; settlementEvents=${JSON.stringify(snapshot.settlementEvents)}; pinnedP8Route=${JSON.stringify(priorTurnRoutes.filter((route) => route.name === "record_verification_evidence"))}; allToolInvocations=${JSON.stringify(snapshot.toolInvocations.filter((row) => row.execution_id === oldAction.executionId))}; providerCalls=${JSON.stringify(fixture.providerCalls.slice(-6).map((call) => ({ tools: call.tools.map((tool) => tool.function?.name), messages: call.messages.slice(-5).map((message) => ({ role: message.role, content: message.content?.slice(-240) })) })))}; timeline=${JSON.stringify(snapshot.timeline.filter((row) => row.payload_json.includes("VerificationEvidenceRecorded") || row.payload_json.includes("ControlResult") || row.payload_json.includes("record_verification_evidence") || row.payload_json.includes("FUNCTIONAL_VERIFIED")))}; newErrors=${newDaemon.daemonErrors.join(" | ")}`,
      );
    });
    expect(recoveredAction?.logicalActionId).toBe(oldAction.logicalActionId);
    releaseGate(fixture, "new", "control-return");
    releaseGate(fixture, "new", "action-result");
    const converged = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile),
      (snapshot) =>
        snapshot.observations.some((row) =>
          row.payload_json.includes("VerificationEvidenceRecorded("),
        ) && snapshot.evidence.length === 1,
      30_000,
    );
    expect(converged.evidence).toHaveLength(1);
    expect(
      converged.commands.filter(
        (row) =>
          row.resolution === "Committed" &&
          row.result_json?.includes('"evidenceId"'),
      ),
    ).toHaveLength(1);
    expect(
      converged.observations.filter((row) =>
        row.payload_json.includes("VerificationEvidenceRecorded("),
      ),
    ).toHaveLength(1);
    expect(targetActionCalls).toBe(1);
    await newDaemon.crash();
  }, 180_000);
});
