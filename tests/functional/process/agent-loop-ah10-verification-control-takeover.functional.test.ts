import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { newUuid7 } from "../../../packages/application/src/formation-plan.js";
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
  readonly commandId?: string;
  readonly fencingGeneration?: number;
  readonly pauseRequested?: boolean;
  readonly stage?: string;
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
        .prepare(
          "SELECT command_id,project_id,semantic_request_fingerprint,schema_version,fingerprint_algorithm_version,resolution,result_json,terminal_error_json,created_at,settled_at FROM commands",
        )
        .all() as Array<{
        command_id: string;
        project_id: string;
        semantic_request_fingerprint: string;
        schema_version: string;
        fingerprint_algorithm_version: number;
        resolution: string;
        result_json: string | null;
        terminal_error_json: string | null;
        created_at: string;
        settled_at: string;
      }>,
      commandAttempts: db
        .prepare(
          "SELECT command_id,attempt_no,started_at,settled_at,outcome,failure_kind,metadata_json FROM command_attempts ORDER BY command_id,attempt_no",
        )
        .all() as Array<Record<string, unknown>>,
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

  it.each([
    {
      label: "Evidence C/P committed receipt",
      mode: "committed",
      actionKind: "record_verification_evidence",
    },
    {
      label: "Evidence R− receipt transaction",
      mode: "fence-before",
      actionKind: "record_verification_evidence",
    },
    {
      label: "Evidence R+ receipt transaction",
      mode: "fence-after",
      actionKind: "record_verification_evidence",
    },
    {
      label: "Conclude C/P committed receipt",
      mode: "committed",
      actionKind: "conclude_verification",
    },
    {
      label: "Conclude R− receipt transaction",
      mode: "fence-before",
      actionKind: "conclude_verification",
    },
    {
      label: "Conclude R+ receipt transaction",
      mode: "fence-after",
      actionKind: "conclude_verification",
    },
  ] as const)(
    "recovers $label after two-daemon restart",
    async ({ mode, actionKind }) => {
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
        preserveDirectoryOnStop: mode === "fence-before",
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
            const evidenceIds = [
              ...context.matchAll(/evd_[0-9a-f-]{36}/gu),
            ].map((match) => match[0]);
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
              if (actionKind === "record_verification_evidence") {
                targetActionCalls += 1;
              }
              return {
                _tag: "ToolCall",
                name: "record_verification_evidence",
                arguments: {
                  criterionId: "ah10-verification-takeover",
                  sourceCallRef: "1",
                },
              };
            }
            if (actionKind === "record_verification_evidence") {
              return {
                _tag: "Text",
                text: `Evidence recorded for ${marker}.`,
              };
            }
            targetActionCalls += 1;
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
          ...(mode === "committed"
            ? actionKind === "record_verification_evidence"
              ? {
                  ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "1",
                  ARBOR_AH10_PAUSE_AFTER_CONTROL_KIND: actionKind,
                }
              : { ARBOR_AH10_PAUSE_BEFORE_TERMINAL_ACTION: "1" }
            : {
                ARBOR_AH10_PAUSE_LEASE_RENEWAL: "1",
                ARBOR_AH10_PAUSE_BEFORE_FENCED_RECEIPT:
                  mode === "fence-before" ? "1" : "0",
              }),
          ARBOR_AH10_GATE_ACTION_KIND: actionKind,
        },
      });
      await client.command(project.projectId, "SteerWork", {
        workId: work.workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: waitingWork.revision,
        steer: {
          severity: "Normal",
          guidance: `Resume ${marker} verification.`,
        },
        provenance: { source: "HumanInput" },
      });
      const oldAction = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "old" &&
              event.boundary === "AH7AfterActionIntentCommit" &&
              event.actionKind === actionKind,
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
      const p8CommandNamespace =
        actionKind === "record_verification_evidence"
          ? "record-verification-evidence"
          : "conclude-verification";
      const occurrence = `${oldAction.providerTurnId}:${oldAction.actionIndex}`;
      const oldP8CommandId = `cmd_${newUuid7(p8CommandNamespace, occurrence)}`;
      const newP8CommandId = `cmd_${newUuid7(
        p8CommandNamespace,
        `${occurrence}:generation:1`,
      )}`;
      const oldActionTuple = readSnapshot(fixture.databaseFile).actions.find(
        (action) => action.logical_action_id === oldAction.logicalActionId,
      );
      if (oldActionTuple === undefined) {
        throw new Error("old P8 ActionIntent tuple is missing");
      }
      if (mode === "committed") {
        releaseGate(fixture, "old", "action-intent");
        const oldReturn = await waitForPublic(
          async () =>
            events.find(
              (event) =>
                event.role === "old" &&
                event.boundary ===
                  (actionKind === "record_verification_evidence"
                    ? "AH10AfterControlHandlerReturnBeforeObservationCommit"
                    : "AH9BeforeTerminalActionCommit") &&
                event.logicalActionId === oldAction.logicalActionId,
            ),
          (event) => event !== undefined,
          8_000,
        );
        expect(oldReturn).toBeDefined();
        const committed = readSnapshot(fixture.databaseFile);
        expect(committed.evidence).toHaveLength(1);
        expect(
          committed.commands.filter(
            (row) =>
              row.command_id === oldP8CommandId &&
              row.resolution === "Committed",
          ),
        ).toHaveLength(1);
        expect(committed.actions).toContainEqual(
          expect.objectContaining({
            logical_action_id: oldAction.logicalActionId,
            action_kind: actionKind,
            state: "Pending",
          }),
        );
        if (actionKind === "record_verification_evidence") {
          expect(
            committed.observations.filter((row) =>
              row.payload_json.includes("VerificationEvidenceRecorded("),
            ),
          ).toHaveLength(0);
        } else {
          expect(committed.verifications).toMatchObject([
            { state: "Concluded", verdict: "Pass" },
          ]);
          expect(committed.events).toHaveLength(1);
          expect(
            committed.executions.find(
              (row) => row.execution_id === oldAction.executionId,
            )?.settlement_kind,
          ).toBeNull();
        }
        expect(targetActionCalls).toBe(1);

        await fixture.crash();
        await expireExecutionLeaseAfterOwnerExitForQualification({
          databaseFile: fixture.databaseFile,
          executionId: oldAction.executionId,
          daemon: {
            crash: fixture.crash,
            snapshot: fixture.daemonProcessSnapshot,
          },
        });
      } else {
        const pausedRenewal = await waitForPublic(
          async () =>
            events.find(
              (event) =>
                event.role === "old" &&
                event.boundary === "AH10BeforeLeaseRenewal" &&
                event.executionId === oldAction.executionId &&
                event.pauseRequested === true,
            ),
          (event) => event !== undefined,
          25_000,
        );
        expect(pausedRenewal?.fencingGeneration).toBe(0);
        expect(
          readSnapshot(fixture.databaseFile).leases.find(
            (lease) => lease.execution_id === oldAction.executionId,
          ),
        ).toMatchObject({ generation: 0 });
        await waitForPublic(
          async () =>
            readSnapshot(fixture.databaseFile).leases.find(
              (lease) => lease.execution_id === oldAction.executionId,
            ),
          (lease) =>
            lease !== undefined && Date.parse(lease.expires_at) <= Date.now(),
          40_000,
        );
      }
      const newDaemon = await fixture.startAdditionalDaemon({
        entry: ah10Child,
        daemonEnvironment: {
          ARBOR_AH10_ROLE: "new",
          ...(actionKind === "record_verification_evidence"
            ? { ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN: "1" }
            : {}),
          ARBOR_AH10_PAUSE_AFTER_CONTROL_KIND: actionKind,
          ARBOR_AH10_GATE_ACTION_KIND: actionKind,
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
      const newActionIntent = await waitForPublic(
        async () =>
          events.find(
            (event) =>
              event.role === "new" &&
              event.boundary === "AH7AfterActionIntentCommit" &&
              event.executionId === oldAction.executionId &&
              event.logicalActionId === oldAction.logicalActionId,
          ),
        (event) => event !== undefined,
        45_000,
      );
      expect(newActionIntent).toMatchObject({
        role: "new",
        executionId: oldAction.executionId,
        providerTurnId: oldAction.providerTurnId,
        logicalActionId: oldAction.logicalActionId,
        callRef: oldAction.callRef,
        actionIndex: oldAction.actionIndex,
        actionKind,
      });
      const reopenedSnapshot = readSnapshot(fixture.databaseFile);
      expect(
        reopenedSnapshot.actions.find(
          (action) => action.logical_action_id === oldAction.logicalActionId,
        ),
      ).toMatchObject({
        execution_id: oldAction.executionId,
        provider_turn_id: oldAction.providerTurnId,
        logical_step_no: oldActionTuple.logical_step_no,
        repair_attempt: oldActionTuple.repair_attempt,
        action_index: oldAction.actionIndex,
        call_ref: oldAction.callRef,
        route_kind: "Control",
        action_kind: actionKind,
        state: "Pending",
        result_ref: null,
      });
      if (mode !== "committed") {
        releaseGate(fixture, "old", "action-intent");
        if (mode === "fence-before") {
          const beforeReceipt = await waitForPublic(
            async () =>
              events.find(
                (event) =>
                  event.role === "old" &&
                  event.boundary === "AH10BeforeFencedReceiptCommit" &&
                  event.executionId === oldAction.executionId,
              ),
            (event) => event !== undefined,
            20_000,
          );
          expect(beforeReceipt?.commandId).toMatch(/^cmd_/u);
          expect(beforeReceipt?.commandId).toBe(oldP8CommandId);
          const beforeReceiptSnapshot = readSnapshot(fixture.databaseFile);
          expect({
            commands: beforeReceiptSnapshot.commands.filter(
              (row) => row.command_id === oldP8CommandId,
            ),
            attempts: beforeReceiptSnapshot.commandAttempts.filter(
              (row) => row.command_id === oldP8CommandId,
            ),
          }).toEqual({ commands: [], attempts: [] });
        } else {
          await waitForPublic(
            async () =>
              readSnapshot(fixture.databaseFile).commands.filter(
                (row) =>
                  row.command_id === oldP8CommandId &&
                  row.resolution === "TerminalRejected" &&
                  row.terminal_error_json?.includes("FencingRejected"),
              ),
            (rows) => rows.length === 1,
            20_000,
          );
        }
        await fixture.crash();
        const beforeGen1 = readSnapshot(fixture.databaseFile);
        expect(beforeGen1.evidence).toHaveLength(
          actionKind === "record_verification_evidence" ? 0 : 1,
        );
        if (actionKind === "conclude_verification") {
          expect(beforeGen1.verifications).toMatchObject([
            { state: "Open", verdict: null },
          ]);
          expect(beforeGen1.events).toHaveLength(0);
        }
        expect(
          beforeGen1.actions.find(
            (action) => action.logical_action_id === oldAction.logicalActionId,
          ),
        ).toMatchObject({ state: "Pending", result_ref: null });
        expect(targetActionCalls).toBe(1);
      }
      releaseGate(fixture, "new", "action-intent");
      let recoveredAction: Probe | undefined;
      if (actionKind === "record_verification_evidence") {
        recoveredAction = await waitForPublic(
          async () =>
            events.find(
              (event) =>
                event.role === "new" &&
                event.boundary ===
                  "AH10AfterControlHandlerReturnBeforeObservationCommit" &&
                event.logicalActionId === oldAction.logicalActionId,
            ),
          (event) => event !== undefined,
          30_000,
        ).catch((error: unknown) => {
          const snapshot = readSnapshot(fixture.databaseFile);
          const priorTurnManifest = snapshot.turnManifests.find(
            (turn) => turn.provider_turn_id === oldAction.providerTurnId,
          );
          const priorTurnRoutes = JSON.parse(
            priorTurnManifest?.tool_routes ?? "[]",
          ) as Array<{ name?: unknown; route?: unknown; stableId?: unknown }>;
          throw new Error(
            `new daemon did not reopen the same P8 ActionIntent: ${error instanceof Error ? error.message : String(error)}; targetExecution=${oldAction.executionId}; leaseRows=${JSON.stringify(snapshot.leases.filter((row) => row.execution_id === oldAction.executionId))}; executionSettlement=${JSON.stringify(snapshot.executions.find((row) => row.execution_id === oldAction.executionId))}; stepRows=${JSON.stringify(snapshot.steps.filter((step) => step.execution_id === oldAction.executionId))}; everyActionTuple=${JSON.stringify(snapshot.actions.filter((action) => action.execution_id === oldAction.executionId))}; correspondingToolResults=${JSON.stringify(snapshot.toolResults)}; settlementEvents=${JSON.stringify(snapshot.settlementEvents)}; pinnedP8Route=${JSON.stringify(priorTurnRoutes.filter((route) => route.name === actionKind))}; allToolInvocations=${JSON.stringify(snapshot.toolInvocations.filter((row) => row.execution_id === oldAction.executionId))}; providerCalls=${JSON.stringify(fixture.providerCalls.slice(-6).map((call) => ({ tools: call.tools.map((tool) => tool.function?.name), messages: call.messages.slice(-5).map((message) => ({ role: message.role, content: message.content?.slice(-240) })) })))}; timeline=${JSON.stringify(snapshot.timeline.filter((row) => row.payload_json.includes("VerificationEvidenceRecorded") || row.payload_json.includes("ControlResult") || row.payload_json.includes(actionKind) || row.payload_json.includes("FUNCTIONAL_VERIFIED")))}; newErrors=${newDaemon.daemonErrors.join(" | ")}`,
          );
        });
      } else {
        await waitForPublic(
          async () => readSnapshot(fixture.databaseFile),
          (snapshot) =>
            snapshot.verifications.some((row) => row.state === "Concluded") &&
            snapshot.events.length === 1 &&
            snapshot.executions.find(
              (row) => row.execution_id === oldAction.executionId,
            )?.settlement_kind === "Completed" &&
            snapshot.actions.find(
              (row) => row.logical_action_id === oldAction.logicalActionId,
            )?.state === "Applied",
          30_000,
        ).catch((error: unknown) => {
          const snapshot = readSnapshot(fixture.databaseFile);
          throw new Error(
            `ConcludeVerification gen1 did not settle: ${error instanceof Error ? error.message : String(error)}; targetExecution=${oldAction.executionId}; action=${JSON.stringify(snapshot.actions.find((row) => row.logical_action_id === oldAction.logicalActionId))}; execution=${JSON.stringify(snapshot.executions.find((row) => row.execution_id === oldAction.executionId))}; commands=${JSON.stringify(snapshot.commands)}; verification=${JSON.stringify(snapshot.verifications)}; events=${JSON.stringify(snapshot.events)}`,
          );
        });
        recoveredAction = newActionIntent;
      }
      expect(recoveredAction?.logicalActionId).toBe(oldAction.logicalActionId);
      if (actionKind === "record_verification_evidence") {
        releaseGate(fixture, "new", "control-return");
      }
      releaseGate(fixture, "new", "action-result");
      const converged = await waitForPublic(
        async () => readSnapshot(fixture.databaseFile),
        (snapshot) =>
          actionKind === "record_verification_evidence"
            ? snapshot.observations.some((row) =>
                row.payload_json.includes("VerificationEvidenceRecorded("),
              ) && snapshot.evidence.length === 1
            : snapshot.verifications.some((row) => row.state === "Concluded") &&
              snapshot.events.length === 1 &&
              snapshot.executions.find(
                (row) => row.execution_id === oldAction.executionId,
              )?.settlement_kind === "Completed",
        30_000,
      );
      expect(converged.evidence).toHaveLength(1);
      expect(
        converged.commands.filter(
          (row) =>
            (row.command_id === oldP8CommandId ||
              row.command_id === newP8CommandId) &&
            row.resolution === "Committed",
        ),
      ).toHaveLength(1);
      expect(
        converged.commands.filter(
          (row) =>
            row.command_id === oldP8CommandId &&
            row.resolution === "TerminalRejected" &&
            row.terminal_error_json?.includes("FencingRejected"),
        ),
      ).toHaveLength(mode === "fence-after" ? 1 : 0);
      expect(
        converged.actions.find(
          (action) => action.logical_action_id === oldAction.logicalActionId,
        ),
      ).toMatchObject({
        action_kind: actionKind,
        state: "Applied",
        result_ref: expect.any(String),
      });
      if (actionKind === "record_verification_evidence") {
        expect(
          converged.commands.filter(
            (row) =>
              row.result_json?.includes('"evidenceId"') &&
              row.result_json.includes('"Recorded"'),
          ),
        ).toHaveLength(1);
        expect(
          converged.observations.filter((row) =>
            row.payload_json.includes("VerificationEvidenceRecorded("),
          ),
        ).toHaveLength(1);
      } else {
        expect(converged.events).toHaveLength(1);
        expect(converged.verifications).toMatchObject([
          { state: "Concluded", verdict: "Pass" },
        ]);
        expect(
          converged.commands.filter((row) =>
            row.result_json?.includes('"state":"Concluded"'),
          ),
        ).toHaveLength(1);
        expect(
          converged.executions.find(
            (row) => row.execution_id === oldAction.executionId,
          ),
        ).toMatchObject({ settlement_kind: "Completed" });
      }
      expect(targetActionCalls).toBe(1);
      await newDaemon.crash();
    },
    240_000,
  );
});
