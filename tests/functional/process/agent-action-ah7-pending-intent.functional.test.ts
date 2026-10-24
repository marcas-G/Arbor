import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../../../adapters/persistence-sqlite/src/index.js";
import { durableSnapshot } from "../support/ah-durable-snapshot.js";
import {
  type AhProbeHit,
  recordAhProbeLine,
} from "../support/ah-probe-line.js";
import {
  archiveProductionFixtureFailure,
  writeProductionFixtureArchiveSkipped,
} from "../support/fixture-failure-evidence.js";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../support/public-client.js";
import { removeFunctionalFixtureDirectory } from "../support/schema44-bootstrap.js";

const fixtures: ProductionFixture[] = [];
const fixturePhases = new Map<
  ProductionFixture,
  {
    readonly boundary: Ah7PendingIntentBoundary;
    projectId?: string;
    workspaceId?: string;
    executionId?: string;
    callRef?: string;
    providerTurnId?: string;
    logicalActionId?: string;
    readonly diagnosticState: () => Readonly<Record<string, unknown>>;
    phase: string;
  }
>();
const crashChild = resolve("tests/functional/support/ah-crash-child.mjs");
const ah7PendingIntentBoundaries = [
  "AH7AfterActionIntentCommit",
  "AH7AfterToolIntentCommit",
  "AH7BeforeToolSettlementTransaction",
  "AH7BeforeToolSettlementCommit",
  "AH7AfterToolSettlementCommit",
  "AH7BeforeActionResultCommit",
  "AH7AfterActionResultCommit",
] as const;

const readFailureProjectSnapshot = (input: {
  readonly databaseFile: string;
  readonly projectId: string;
  readonly executionId?: string;
  readonly callRef?: string;
}) => {
  const db = new DatabaseSync(input.databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN");
    const executionFilter = input.executionId ?? null;
    const sessionEntries = db
      .prepare(
        `SELECT DISTINCT se.sequence, se.session_id, se.payload_json,
                se.source_kind, se.source_ref
           FROM session_entries se JOIN executions e
             ON e.session_id = se.session_id
          WHERE e.project_id = ?
            AND (? IS NULL OR e.execution_id = ?)
            AND se.item_type = 'ToolResult'
          ORDER BY se.session_id, se.sequence`,
      )
      .all(input.projectId, executionFilter, executionFilter) as Array<{
      readonly sequence: number;
      readonly session_id: string;
      readonly payload_json: string;
      readonly source_kind: string | null;
      readonly source_ref: string | null;
    }>;
    const toolResults =
      input.callRef === undefined
        ? sessionEntries
        : sessionEntries.filter((entry) => {
            try {
              const payload: unknown = JSON.parse(entry.payload_json);
              return (
                typeof payload === "object" &&
                payload !== null &&
                "_tag" in payload &&
                payload._tag === "ToolResult" &&
                "callRef" in payload &&
                payload.callRef === input.callRef
              );
            } catch {
              return false;
            }
          });
    const snapshot = {
      projectId: input.projectId,
      executionId: input.executionId ?? null,
      executions: db
        .prepare(
          `SELECT execution_id, project_id, workspace_id, episode_kind,
                  episode_ref, stop_requested_at, settled_at, settlement_kind,
                  settlement_json
             FROM executions WHERE project_id = ? ORDER BY admitted_at`,
        )
        .all(input.projectId),
      workspaces: db
        .prepare(
          `SELECT workspace_id, parent_workspace_id, current_work_id, revision
             FROM workspaces WHERE project_id = ? ORDER BY workspace_id`,
        )
        .all(input.projectId),
      works: db
        .prepare(
          `SELECT w.work_id, w.workspace_id, w.lifecycle, w.revision
             FROM works w JOIN workspaces ws ON ws.workspace_id = w.workspace_id
            WHERE ws.project_id = ? ORDER BY w.created_at, w.work_id`,
        )
        .all(input.projectId),
      decisions: db
        .prepare(
          `SELECT d.decision_id, d.workspace_id, d.candidate_work_ids_json,
                  d.state, d.selected_work_id, d.revision
             FROM work_selection_decision_requests d
             JOIN workspaces ws ON ws.workspace_id = d.workspace_id
            WHERE ws.project_id = ? ORDER BY d.created_at, d.decision_id`,
        )
        .all(input.projectId),
      steps: db
        .prepare(
          `SELECT s.execution_id, s.logical_step_no, s.repair_attempt,
                  s.provider_turn_id, s.manifest_id, s.state, s.revision,
                  s.next_action_index, s.settlement_json
             FROM agent_loop_steps s
             JOIN executions e ON e.execution_id = s.execution_id
            WHERE e.project_id = ?
              AND (? IS NULL OR s.execution_id = ?)
            ORDER BY s.execution_id, s.logical_step_no, s.repair_attempt`,
        )
        .all(input.projectId, executionFilter, executionFilter),
      actions: db
        .prepare(
          `SELECT a.execution_id, a.logical_step_no, a.repair_attempt,
                  a.action_index, a.logical_action_id, a.call_ref,
                  a.action_kind, a.state, a.result_ref, a.observation_source_ref,
                  a.disposition_json
             FROM agent_loop_step_actions a
             JOIN executions e ON e.execution_id = a.execution_id
            WHERE e.project_id = ?
              AND (? IS NULL OR a.execution_id = ?)
            ORDER BY a.execution_id, a.logical_step_no, a.repair_attempt,
                     a.action_index`,
        )
        .all(input.projectId, executionFilter, executionFilter),
      toolInvocations: db
        .prepare(
          `SELECT t.invocation_id, t.execution_id, t.workspace_id,
                  t.tool_name, t.tool_version, t.side_effect_semantics,
                  t.arguments_json, t.resolved_regions_json, t.approval_id,
                  t.effect_admission_state, t.recovery_binding_state,
                  t.recovery_binding_sha256, t.settlement_provenance,
                  t.selected_attempt_no, t.selected_fact_id, t.intent_at,
                  t.settled_at, t.settlement_kind, t.settlement_json,
                  t.result_ref, t.observation_format_version,
                  t.observation_sha256
             FROM tool_invocations t
             JOIN executions e ON e.execution_id = t.execution_id
            WHERE e.project_id = ?
              AND (? IS NULL OR t.execution_id = ?)
            ORDER BY t.execution_id, t.invocation_id`,
        )
        .all(input.projectId, executionFilter, executionFilter),
      providerTurns: db
        .prepare(
          `SELECT p.provider_turn_id, p.execution_id, p.session_id,
                  p.manifest_id, p.settled_at, p.finish_reason
             FROM provider_turns p JOIN executions e
               ON e.execution_id = p.execution_id
            WHERE e.project_id = ?
              AND (? IS NULL OR p.execution_id = ?)
            ORDER BY p.provider_turn_id`,
        )
        .all(input.projectId, executionFilter, executionFilter),
      attempts: db
        .prepare(
          `SELECT a.provider_turn_id, a.attempt_no, a.outcome, a.settled_at,
                  a.success_evidence_version
             FROM provider_attempts a JOIN provider_turns p
               ON p.provider_turn_id = a.provider_turn_id
             JOIN executions e ON e.execution_id = p.execution_id
            WHERE e.project_id = ?
              AND (? IS NULL OR p.execution_id = ?)
            ORDER BY a.provider_turn_id, a.attempt_no`,
        )
        .all(input.projectId, executionFilter, executionFilter),
      artifacts: db
        .prepare(
          `SELECT a.artifact_id, a.invocation_id, a.content_hash
             FROM artifacts a JOIN tool_invocations t
               ON t.invocation_id = a.invocation_id
             JOIN executions e ON e.execution_id = t.execution_id
            WHERE e.project_id = ?
              AND (? IS NULL OR t.execution_id = ?)
            ORDER BY a.artifact_id`,
        )
        .all(input.projectId, executionFilter, executionFilter),
      toolResults,
      events: db
        .prepare(
          `SELECT event_id, project_id, sequence, event_type, aggregate_ref,
                  payload_json, occurred_at
             FROM domain_events WHERE project_id = ? ORDER BY sequence`,
        )
        .all(input.projectId),
    };
    db.exec("COMMIT");
    return snapshot;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original diagnostic snapshot error.
    }
    throw error;
  } finally {
    db.close();
  }
};
type Ah7PendingIntentBoundary = (typeof ah7PendingIntentBoundaries)[number];
type Ah7CrashSnapshotExpectation = {
  readonly actionState: "Pending" | "Applied";
  readonly actionCursor: 0 | 1;
  readonly p4Intent: "Absent" | "Pending" | "Success" | "ExpectedFailure";
  readonly toolResultCount: 0 | 1;
  readonly artifactCount: 0 | 1;
  readonly probeIdentity: "Action" | "Invocation";
  readonly timeoutMs: 120_000 | 180_000;
};
const ah7CrashSnapshotExpectations = {
  AH7AfterActionIntentCommit: {
    actionState: "Pending",
    actionCursor: 0,
    p4Intent: "Absent",
    toolResultCount: 0,
    artifactCount: 0,
    probeIdentity: "Action",
    timeoutMs: 120_000,
  },
  AH7AfterToolIntentCommit: {
    actionState: "Pending",
    actionCursor: 0,
    p4Intent: "Pending",
    toolResultCount: 0,
    artifactCount: 0,
    probeIdentity: "Invocation",
    timeoutMs: 120_000,
  },
  AH7BeforeToolSettlementTransaction: {
    actionState: "Pending",
    actionCursor: 0,
    p4Intent: "Pending",
    toolResultCount: 0,
    artifactCount: 0,
    probeIdentity: "Invocation",
    timeoutMs: 180_000,
  },
  AH7BeforeToolSettlementCommit: {
    actionState: "Pending",
    actionCursor: 0,
    p4Intent: "Pending",
    toolResultCount: 0,
    artifactCount: 0,
    probeIdentity: "Invocation",
    timeoutMs: 180_000,
  },
  AH7AfterToolSettlementCommit: {
    actionState: "Pending",
    actionCursor: 0,
    p4Intent: "Success",
    toolResultCount: 0,
    artifactCount: 1,
    probeIdentity: "Invocation",
    timeoutMs: 120_000,
  },
  AH7BeforeActionResultCommit: {
    actionState: "Pending",
    actionCursor: 0,
    p4Intent: "Success",
    toolResultCount: 0,
    artifactCount: 1,
    probeIdentity: "Action",
    timeoutMs: 120_000,
  },
  AH7AfterActionResultCommit: {
    actionState: "Applied",
    actionCursor: 1,
    p4Intent: "Success",
    toolResultCount: 1,
    artifactCount: 1,
    probeIdentity: "Action",
    timeoutMs: 120_000,
  },
} satisfies Record<Ah7PendingIntentBoundary, Ah7CrashSnapshotExpectation>;
const ah7PendingIntentScenarios = [
  ...ah7PendingIntentBoundaries.map((boundary) => ({
    boundary,
    expectedSettlement: "Success" as const,
  })),
  {
    boundary: "AH7AfterToolSettlementCommit",
    expectedSettlement: "ExpectedFailure" as const,
  },
] as const;
interface RawP4InvocationRow {
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
  readonly recovery_binding_state: string;
  readonly recovery_binding_sha256: string | null;
  readonly settlement_provenance: string | null;
  readonly selected_attempt_no: number | null;
  readonly selected_fact_id: string | null;
  readonly intent_at: string;
  readonly settled_at: string | null;
  readonly settlement_kind: string | null;
  readonly settlement_json: string | null;
  readonly result_ref: string | null;
  readonly observation_format_version: string | null;
  readonly observation_json: Uint8Array | null;
  readonly observation_sha256: string | null;
}

const readRawP4InvocationRows = (
  databaseFile: string,
  executionId: string,
): ReadonlyArray<RawP4InvocationRow> => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT * FROM tool_invocations WHERE execution_id = ? ORDER BY invocation_id",
      )
      .all(executionId) as unknown as ReadonlyArray<RawP4InvocationRow>;
  } finally {
    db.close();
  }
};

const p4ImmutableBinding = (row: RawP4InvocationRow) => ({
  invocationId: row.invocation_id,
  executionId: row.execution_id,
  workspaceId: row.workspace_id,
  toolName: row.tool_name,
  toolVersion: row.tool_version,
  sideEffectSemantics: row.side_effect_semantics,
  argumentsJson: row.arguments_json,
  resolvedRegionsJson: row.resolved_regions_json,
  approvalId: row.approval_id,
  intentAt: row.intent_at,
});
let activePhase: string | undefined;
let activeExecutionId: string | undefined;
let activeDiagnosticTimer: ReturnType<typeof setTimeout> | undefined;

afterEach(async ({ task }) => {
  if (activeDiagnosticTimer !== undefined) {
    clearTimeout(activeDiagnosticTimer);
    activeDiagnosticTimer = undefined;
  }
  activePhase = undefined;
  activeExecutionId = undefined;
  const failed = (task.result?.errors?.length ?? 0) > 0;
  for (const fixture of fixtures.splice(0)) {
    let stopError: unknown;
    try {
      await fixture.stop();
    } catch (error) {
      stopError = error;
    }
    const phase = fixturePhases.get(fixture);
    fixturePhases.delete(fixture);
    if (!fixture.daemonsExited()) {
      const resultDirectory = process.env.ARBOR_TEST_RESULT_DIRECTORY;
      if (resultDirectory === undefined) {
        throw new Error(
          `AH7 archive skipped because a daemon may still be active; result directory unavailable; database=${fixture.databaseFile}`,
          { cause: stopError },
        );
      }
      const skippedPath = writeProductionFixtureArchiveSkipped({
        fixture,
        resultDirectory,
        evidence: {
          testName: task.name,
          boundary: phase?.boundary ?? "unknown",
          phase: phase?.phase ?? "unknown",
          stopFailed: stopError !== undefined,
          startupDiagnostics: fixture.startupDiagnostics(),
          daemonErrors: fixture.daemonErrors,
        },
      });
      process.stdout.write(
        `[AH7_ARCHIVE_SKIPPED] ${JSON.stringify({ testName: task.name, databaseFile: fixture.databaseFile, skippedPath })}\n`,
      );
      if (stopError === undefined) {
        throw new Error(
          `AH7 fixture cleanup returned while a daemon may still be active; database=${fixture.databaseFile}`,
        );
      }
    } else if (failed || stopError !== undefined) {
      const resultDirectory = process.env.ARBOR_TEST_RESULT_DIRECTORY;
      if (resultDirectory === undefined) {
        throw new Error(
          `AH7 failure evidence cannot be archived without ARBOR_TEST_RESULT_DIRECTORY; database=${fixture.databaseFile}`,
          { cause: stopError },
        );
      }
      let snapshot: unknown;
      try {
        snapshot =
          phase?.projectId === undefined
            ? { snapshotUnavailable: "project not yet created" }
            : readFailureProjectSnapshot({
                databaseFile: fixture.databaseFile,
                projectId: phase.projectId,
                ...(phase.callRef === undefined
                  ? {}
                  : { callRef: phase.callRef }),
                ...(phase.executionId === undefined
                  ? {}
                  : { executionId: phase.executionId }),
              });
      } catch (error) {
        snapshot = {
          snapshotError: error instanceof Error ? error.message : String(error),
        };
      }
      const archivedDirectory = archiveProductionFixtureFailure({
        fixture,
        resultDirectory,
        artifactPrefix: "ah7-pending-intent",
        evidence: {
          testName: task.name,
          boundary: phase?.boundary ?? "unknown",
          phase: phase?.phase ?? "unknown",
          projectId: phase?.projectId ?? null,
          workspaceId: phase?.workspaceId ?? null,
          executionId: phase?.executionId ?? null,
          callRef: phase?.callRef ?? null,
          providerTurnId: phase?.providerTurnId ?? null,
          logicalActionId: phase?.logicalActionId ?? null,
          diagnosticState: phase?.diagnosticState() ?? {},
          primaryDaemon: fixture.daemonProcessSnapshot(),
          startupDiagnostics: fixture.startupDiagnostics(),
          daemonErrors: fixture.daemonErrors,
          snapshot,
          stopFailed: stopError !== undefined,
        },
      });
      process.stdout.write(
        `[AH7_FAILURE_ARTIFACT] ${JSON.stringify({ testName: task.name, boundary: phase?.boundary ?? "unknown", phase: phase?.phase ?? "unknown", archivedDirectory })}\n`,
      );
    } else {
      removeFunctionalFixtureDirectory(fixture.directory);
    }
    if (stopError !== undefined) throw stopError;
  }
});

describe("AH7 AgentLoop and P4 tool intent process crash", () => {
  for (const scenario of ah7PendingIntentScenarios) {
    const { boundary, expectedSettlement } = scenario;
    const testName =
      expectedSettlement === "ExpectedFailure"
        ? "replays the committed P40 ExpectedFailure observation after process crash"
        : `reuses the same action and tool identity after ${boundary}`;
    const baseCrash = ah7CrashSnapshotExpectations[boundary];
    const expectedCrash: Ah7CrashSnapshotExpectation =
      expectedSettlement === "ExpectedFailure"
        ? { ...baseCrash, p4Intent: "ExpectedFailure", artifactCount: 0 }
        : baseCrash;
    it(
      testName,
      async () => {
        const marker = `AH7-${crypto.randomUUID().slice(0, 8)}`;
        const lateProofPath = `ah7-late-proof-${marker}.txt`;
        const hits: AhProbeHit[] = [];
        const daemonOutput: string[] = [];
        let targetProviderCalls = 0;
        let targetReadToolCalls = 0;
        let probeArmed = false;
        let latestToolResult = "<none>";
        const fixture = await startProductionFixture({
          admitWorkspaceDirectory: true,
          daemonEnvironment: { ARBOR_AH19_STARTUP_TRACE: "1" },
          preserveDirectoryOnStop: true,
          reply: (call) => {
            const context = JSON.stringify(call.messages);
            const available = new Set(
              call.tools
                .map((tool) => tool.function?.name)
                .filter((name): name is string => name !== undefined),
            );
            const targetWorkTurn = available.has("read");
            if (context.includes(marker) && targetWorkTurn) {
              if (!probeArmed) {
                return { _tag: "HttpError", status: 503 };
              }
              targetProviderCalls += 1;
              latestToolResult =
                [...call.messages]
                  .reverse()
                  .find((message) => message.role === "tool")?.content ??
                "<no tool result in request>";
              if (targetProviderCalls > 5) {
                return { _tag: "HttpError", status: 429 };
              }
            }
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
                  objective: `Read proof.txt for ${marker}.`,
                  why: "qualify action intent recovery before P4 ToolRuntime",
                  constraints: [],
                  completionExpectation: "the Agent has observed proof.txt",
                  verificationMission: {
                    goal: `Verify the read result for ${marker}`,
                    criteria: [
                      {
                        criterionId: "proof-read",
                        requirement: "proof.txt contains FUNCTIONAL_VERIFIED",
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "AH7 functional test",
                },
              };
            }
            if (context.includes(marker) && targetWorkTurn) {
              const expectedFailureResult = call.messages.some(
                (message) =>
                  message.role === "tool" &&
                  message.content?.includes(
                    "filesystem target could not be resolved or accessed inside the sandbox",
                  ) === true,
              );
              if (
                expectedSettlement === "ExpectedFailure" &&
                expectedFailureResult
              ) {
                return {
                  _tag: "Text",
                  text: `Recovered original ExpectedFailure for ${marker}`,
                };
              }
              const readResult = call.messages.some(
                (message) =>
                  message.role === "tool" &&
                  message.content?.includes("FUNCTIONAL_VERIFIED") === true,
              );
              if (!readResult) targetReadToolCalls += 1;
              return readResult
                ? { _tag: "Text", text: `Read evidence for ${marker}` }
                : {
                    _tag: "ToolCall",
                    name: "read",
                    arguments: {
                      target: {
                        mount: "workspace",
                        path:
                          expectedSettlement === "ExpectedFailure"
                            ? lateProofPath
                            : "proof.txt",
                      },
                      limit: 200,
                    },
                  };
            }
            return { _tag: "Text", text: `Waiting for Work ${marker}` };
          },
          onDaemonStdout: (line) => {
            daemonOutput.push(line);
            recordAhProbeLine(hits, line);
          },
        });
        fixtures.push(fixture);
        fixturePhases.set(fixture, {
          boundary,
          phase: "fixture-ready",
          diagnosticState: () => ({
            marker,
            targetProviderCalls,
            targetReadToolCalls,
            latestToolResult,
            probeTail: hits.slice(-40),
            providerCallCount: fixture.providerCalls.length,
            providerCallTail: fixture.providerCalls.slice(-12).map((call) => ({
              tools: call.tools
                .map((tool) => tool.function?.name)
                .filter((name): name is string => name !== undefined)
                .sort(),
              candidateIds: [
                ...JSON.stringify(call.messages).matchAll(
                  /wrk_[0-9a-f-]{36}/gu,
                ),
              ].map((match) => match[0]),
            })),
          }),
        });
        activePhase = "fixture-ready";
        if (boundary === "AH7BeforeToolSettlementCommit") {
          activeDiagnosticTimer = setTimeout(() => {
            let snapshot: unknown = "<snapshot unavailable>";
            try {
              const durable = durableSnapshot(fixture.databaseFile);
              snapshot = {
                executions: durable.executions,
                steps:
                  activeExecutionId === undefined
                    ? durable.steps
                    : durable.steps.filter(
                        (step) => step.execution_id === activeExecutionId,
                      ),
                actions:
                  activeExecutionId === undefined
                    ? durable.actions
                    : durable.actions.filter(
                        (action) => action.execution_id === activeExecutionId,
                      ),
                toolInvocations:
                  activeExecutionId === undefined
                    ? durable.toolInvocations
                    : durable.toolInvocations.filter(
                        (invocation) =>
                          invocation.execution_id === activeExecutionId,
                      ),
              };
            } catch (error) {
              snapshot = error instanceof Error ? error.message : String(error);
            }
            console.error(
              `AH7 ${boundary} diagnostic: ${JSON.stringify({
                phase: activePhase,
                executionId: activeExecutionId ?? null,
                providerCalls: targetProviderCalls,
                daemonErrors: fixture.daemonErrors,
                daemon: fixture.daemonProcessSnapshot(),
                snapshot,
              })}`,
            );
          }, 90_000);
        }
        const client = makePublicClient(fixture.baseUrl);
        const project = await createFunctionalProject(
          client,
          fixture.workspaceDirectory,
          "AH7 Pending action intent",
          { resourceSelection: "Profile" },
        );
        {
          const phase = fixturePhases.get(fixture);
          if (phase !== undefined) {
            phase.projectId = project.projectId;
            phase.workspaceId = project.rootWorkspaceId;
          }
        }
        await submitHumanMessage(
          client,
          project,
          `请创建并执行一个读取 proof.txt 的目标 ${marker}`,
        );
        activePhase = "root-submitted";
        const approval = await waitForApproval(client, project, marker).catch(
          (error: unknown) => {
            throw new Error(
              `AH7 public Work approval absent: ${error instanceof Error ? error.message : String(error)}; provider=${JSON.stringify(fixture.providerCalls)}; daemon=${fixture.daemonErrors.join(" | ")}`,
            );
          },
        );
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
        activePhase = "work-approved";
        const currentWork = await waitForPublic(
          () =>
            client.view<{
              workId?: string;
              objective?: string;
              status: string;
            } | null>("current-work", {
              workspaceId: project.rootWorkspaceId,
            }),
          (value) => value?.workId !== undefined,
        );
        expect(currentWork).toMatchObject({
          objective: expect.stringContaining(marker),
          status: "Open",
        });
        // Keep the seed conversation outside the AH7 probe. If the normal daemon
        // reaches the new Work first, the fake provider returns a transport
        // failure (never a ToolCall/P4 effect); killing it now lets recovery
        // redispatch the same Open Work under the selected probe.
        await fixture.crash();
        activePhase = "seed-daemon-exited";
        const fixturePhase = fixturePhases.get(fixture);
        if (fixturePhase !== undefined)
          fixturePhase.phase = "probe-daemon-start";
        probeArmed = true;
        const targetProviderCallStart = fixture.providerCalls.length;
        await fixture.restart({
          entry: crashChild,
          daemonEnvironment: { ARBOR_AH_BOUNDARY: boundary },
        });
        activePhase = "probe-daemon-ready";
        if (fixturePhase !== undefined)
          fixturePhase.phase = "probe-daemon-ready";

        const observed = await waitForPublic(
          async () => ({ hits, targetProviderCalls }),
          (value) =>
            value.hits.some((hit) => hit.boundary === boundary) ||
            value.targetProviderCalls >= 5,
          15_000,
        ).catch((error: unknown) => {
          throw new Error(
            `AH7 Pending-action probe absent: ${error instanceof Error ? error.message : String(error)}; targetProviderCalls=${targetProviderCalls}; latestToolResult=${latestToolResult}; daemonOutput=${daemonOutput.slice(-10).join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
          );
        });
        if (
          !observed.hits.some((candidate) => candidate.boundary === boundary)
        ) {
          await fixture.crash();
          throw new Error(
            `AH7 provider-call cap reached before action-intent probe; targetProviderCalls=${targetProviderCalls}; latestToolResult=${latestToolResult}; calls=${JSON.stringify(fixture.providerCalls.slice(-2))}; daemonOutput=${daemonOutput.slice(-10).join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
          );
        }
        const hit = observed.hits.find(
          (candidate) => candidate.boundary === boundary,
        );
        activeExecutionId = hit?.executionId;
        activePhase = "boundary-reached";
        {
          const phase = fixturePhases.get(fixture);
          if (phase !== undefined) {
            phase.phase = "boundary-reached";
            if (hit?.executionId !== undefined)
              phase.executionId = hit.executionId;
            if (hit?.callRef !== undefined) phase.callRef = hit.callRef;
            if (hit?.providerTurnId !== undefined)
              phase.providerTurnId = hit.providerTurnId;
            if (hit?.logicalActionId !== undefined)
              phase.logicalActionId = hit.logicalActionId;
          }
        }
        expect(hit).toMatchObject({
          executionId: expect.stringMatching(/^exe_/u),
          callRef: expect.any(String),
          ...(expectedCrash.probeIdentity === "Action"
            ? {
                providerTurnId: expect.stringMatching(/^ptn_/u),
                logicalActionId: expect.stringMatching(/^lac_/u),
                actionIndex: 0,
              }
            : { invocationId: expect.stringMatching(/^tin_/u) }),
        });

        await fixture.crash();
        activePhase = "probe-daemon-exited";
        const crashed = durableSnapshot(fixture.databaseFile);
        activePhase = "kill-snapshot-read";
        const rawTargetInvocations = readRawP4InvocationRows(
          fixture.databaseFile,
          hit?.executionId ?? "",
        );
        const targetSteps = crashed.steps.filter(
          (step) => step.execution_id === hit?.executionId,
        );
        const targetActions = crashed.actions.filter(
          (action) => action.execution_id === hit?.executionId,
        );
        const targetInvocations = crashed.toolInvocations.filter(
          (invocation) => invocation.execution_id === hit?.executionId,
        );
        const targetToolResults = crashed.toolResults.filter((result) =>
          JSON.stringify(result).includes(hit?.callRef ?? ""),
        );
        const targetInvocationId = targetInvocations[0]?.invocation_id;
        const targetArtifacts = crashed.artifacts.filter(
          (artifact) => artifact.invocation_id === targetInvocationId,
        );
        let committedObservationBytes: Uint8Array | undefined;
        let committedObservationVersion: string | null | undefined;
        let committedObservationHash: string | null | undefined;
        expect(rawTargetInvocations).toHaveLength(
          expectedCrash.p4Intent === "Absent" ? 0 : 1,
        );
        expect(targetSteps).toEqual([
          expect.objectContaining({
            execution_id: hit?.executionId,
            provider_turn_id:
              hit?.providerTurnId ?? expect.stringMatching(/^ptn_/u),
            state: "ActionsInProgress",
            next_action_index: expectedCrash.actionCursor,
          }),
        ]);
        expect(targetActions).toEqual([
          expect.objectContaining({
            execution_id: hit?.executionId,
            action_index: 0,
            logical_action_id: expect.stringMatching(/^lac_/u),
            call_ref: hit?.callRef,
            action_kind: "read",
            state: expectedCrash.actionState,
          }),
        ]);
        expect(targetInvocations).toHaveLength(
          expectedCrash.p4Intent === "Absent" ? 0 : 1,
        );
        if (expectedCrash.p4Intent === "Pending") {
          expect(targetInvocations).toEqual([
            expect.objectContaining({
              execution_id: hit?.executionId,
              tool_name: "read",
              side_effect_semantics: "ReadOnly",
              settled_at: null,
              settlement_kind: null,
              result_ref: null,
            }),
          ]);
        } else if (
          expectedCrash.p4Intent === "Success" ||
          expectedCrash.p4Intent === "ExpectedFailure"
        ) {
          expect(targetInvocations).toEqual([
            expect.objectContaining({
              execution_id: hit?.executionId,
              tool_name: "read",
              side_effect_semantics: "ReadOnly",
              settled_at: expect.any(String),
              settlement_kind: expectedSettlement,
              result_ref:
                expectedSettlement === "Success" ? expect.any(String) : null,
            }),
          ]);
        }
        expect(targetToolResults).toHaveLength(expectedCrash.toolResultCount);
        expect(targetArtifacts).toHaveLength(expectedCrash.artifactCount);
        if (expectedCrash.p4Intent === "Success") {
          expect(targetInvocations[0]?.result_ref).toBe(
            targetArtifacts[0]?.artifact_id,
          );
        }
        if (expectedSettlement === "ExpectedFailure") {
          const currentSchema = new DatabaseSync(fixture.databaseFile, {
            readOnly: true,
          });
          try {
            const version = currentSchema
              .prepare("PRAGMA user_version")
              .get() as { readonly user_version?: number } | undefined;
            expect(Number(version?.user_version)).toBe(CURRENT_SCHEMA_VERSION);
          } finally {
            currentSchema.close();
          }
          const raw = rawTargetInvocations[0];
          if (raw === undefined || raw.observation_json === null) {
            throw new Error(
              "P40 ExpectedFailure evidence absent at the post-settlement crash boundary",
            );
          }
          committedObservationBytes = Uint8Array.from(raw.observation_json);
          committedObservationVersion = raw.observation_format_version;
          committedObservationHash = raw.observation_sha256;
          if (
            committedObservationVersion === null ||
            committedObservationHash === null
          ) {
            throw new Error("P40 ExpectedFailure version/hash is absent");
          }
          expect(
            JSON.parse(new TextDecoder().decode(raw.observation_json)),
          ).toMatchObject({
            _tag: "ExpectedFailure",
            observation: {
              text: "filesystem target could not be resolved or accessed inside the sandbox",
              truncated: false,
            },
          });
          expect(raw.observation_format_version).toBe(
            "p4-canonical-tool-observation-v1",
          );
          expect(raw.observation_sha256).toMatch(/^[0-9a-f]{64}$/u);
          expect(
            createHash("sha256")
              .update(`${committedObservationVersion}\n`)
              .update(committedObservationBytes)
              .digest("hex"),
          ).toBe(committedObservationHash);
          expect(raw.settlement_json).toBe(
            JSON.stringify({ _tag: "ExpectedFailure" }),
          );
          expect(raw.result_ref).toBeNull();
          expect(targetArtifacts).toHaveLength(0);
        }
        const logicalActionId = (
          targetActions[0] as { logical_action_id?: string } | undefined
        )?.logical_action_id;
        if (logicalActionId === undefined) {
          throw new Error("AH7 committed action identity absent");
        }

        if (expectedSettlement === "ExpectedFailure") {
          // If recovery accidentally re-enters the Read executor, the same
          // request would now succeed. P40 replay must return the exact
          // already-committed ExpectedFailure instead.
          writeFileSync(
            join(fixture.workspaceDirectory, lateProofPath),
            "must not be read by replayed invocation",
          );
        }
        activePhase = "recovery-daemon-start";
        if (fixturePhase !== undefined)
          fixturePhase.phase = "recovery-daemon-start";
        await fixture.restart();
        activePhase = "recovery-daemon-ready";
        if (fixturePhase !== undefined)
          fixturePhase.phase = "recovery-daemon-ready";
        const recovered = await waitForPublic(
          async () => durableSnapshot(fixture.databaseFile),
          (value) => {
            const actions = value.actions.filter(
              (action) => action.execution_id === hit?.executionId,
            );
            const invocations = value.toolInvocations.filter(
              (invocation) => invocation.execution_id === hit?.executionId,
            );
            const toolResults = value.toolResults.filter((result) =>
              JSON.stringify(result).includes(hit?.callRef ?? ""),
            );
            const invocationId = invocations[0]?.invocation_id;
            const artifacts = value.artifacts.filter(
              (artifact) => artifact.invocation_id === invocationId,
            );
            return (
              actions.length === 1 &&
              actions[0]?.logical_action_id === logicalActionId &&
              actions[0]?.call_ref === hit?.callRef &&
              actions[0]?.state === "Applied" &&
              invocations.length === 1 &&
              invocations[0]?.tool_name === "read" &&
              invocations[0]?.settlement_kind === expectedSettlement &&
              (expectedSettlement === "ExpectedFailure"
                ? invocations[0]?.result_ref === null && artifacts.length === 0
                : invocations[0]?.result_ref === artifacts[0]?.artifact_id &&
                  artifacts.length === 1) &&
              toolResults.length === 1 &&
              (expectedCrash.actionState !== "Applied" ||
                value.steps.some(
                  (step) =>
                    step.execution_id === hit?.executionId &&
                    step.state !== "ActionsInProgress",
                ))
            );
          },
          45_000,
        ).catch((error: unknown) => {
          throw new Error(
            `AH7 restart did not resume the committed Pending action: ${error instanceof Error ? error.message : String(error)}; targetProviderCalls=${targetProviderCalls}; latestToolResult=${latestToolResult}; daemonOutput=${daemonOutput.slice(-10).join(" | ")}; daemon=${fixture.daemonErrors.join(" | ")}`,
          );
        });
        const recoveredTargetActions = recovered.actions.filter(
          (action) => action.execution_id === hit?.executionId,
        );
        activePhase = "recovery-snapshot-ready";
        const recoveredTargetInvocations = recovered.toolInvocations.filter(
          (invocation) => invocation.execution_id === hit?.executionId,
        );
        const recoveredRawInvocations = readRawP4InvocationRows(
          fixture.databaseFile,
          hit?.executionId ?? "",
        );
        const recoveredInvocationId =
          targetInvocationId ?? recoveredTargetInvocations[0]?.invocation_id;
        const recoveredTargetToolResults = recovered.toolResults.filter(
          (result) => JSON.stringify(result).includes(hit?.callRef ?? ""),
        );
        const recoveredTargetArtifacts = recovered.artifacts.filter(
          (artifact) => artifact.invocation_id === recoveredInvocationId,
        );
        expect(recoveredTargetActions).toEqual([
          expect.objectContaining({
            execution_id: hit?.executionId,
            action_index: 0,
            logical_action_id: logicalActionId,
            call_ref: hit?.callRef,
            action_kind: "read",
            state: "Applied",
            result_ref: expect.stringMatching(/^result_/u),
            observation_source_ref: expect.stringMatching(/^observation_/u),
          }),
        ]);
        const recoveredActionRecord = recovered.actions.find(
          (action) => action.logical_action_id === logicalActionId,
        );
        const recoveredActionStep = recovered.steps.find(
          (step) =>
            step.execution_id === hit?.executionId &&
            step.logical_step_no === recoveredActionRecord?.logical_step_no,
        );
        expect(recoveredActionStep?.provider_turn_id).toBe(
          targetSteps[0]?.provider_turn_id,
        );
        if (expectedSettlement === "ExpectedFailure") {
          expect(targetSteps).toHaveLength(1);
          expect(targetSteps[0]).toMatchObject({
            execution_id: hit?.executionId,
            next_action_index: 0,
          });
          const recoveredMatchingSteps = recovered.steps.filter(
            (step) =>
              step.execution_id === hit?.executionId &&
              step.logical_step_no === recoveredActionRecord?.logical_step_no,
          );
          expect(recoveredMatchingSteps).toHaveLength(1);
          expect(recoveredMatchingSteps[0]).toMatchObject({
            execution_id: hit?.executionId,
            provider_turn_id: targetSteps[0]?.provider_turn_id,
            next_action_index: 1,
          });
          const recoveredMatchingActions = recovered.actions.filter(
            (action) =>
              action.execution_id === hit?.executionId &&
              action.logical_step_no === recoveredActionRecord?.logical_step_no,
          );
          expect(recoveredMatchingActions).toHaveLength(1);
          expect(recoveredMatchingActions[0]).toMatchObject({
            logical_action_id: logicalActionId,
            call_ref: hit?.callRef,
          });
          expect(recoveredTargetToolResults).toHaveLength(1);
          expect(recoveredTargetToolResults[0]?.source_ref).toBe(
            recoveredMatchingActions[0]?.observation_source_ref,
          );
        }
        expect(recoveredTargetInvocations).toEqual([
          expect.objectContaining({
            execution_id: hit?.executionId,
            tool_name: "read",
            side_effect_semantics: "ReadOnly",
            settlement_kind: expectedSettlement,
            result_ref:
              expectedSettlement === "Success" ? expect.any(String) : null,
          }),
        ]);
        expect(recoveredRawInvocations).toHaveLength(1);
        const recoveredRawInvocation = recoveredRawInvocations[0];
        if (recoveredRawInvocation === undefined) {
          throw new Error("AH7 recovered P4 raw invocation row absent");
        }
        expect(recoveredRawInvocation).toMatchObject({
          invocation_id: recoveredTargetInvocations[0]?.invocation_id,
          execution_id: hit?.executionId,
          workspace_id: project.rootWorkspaceId,
          tool_name: "read",
          side_effect_semantics: "ReadOnly",
          approval_id: null,
          settlement_kind: expectedSettlement,
          result_ref:
            expectedSettlement === "Success"
              ? recoveredTargetArtifacts[0]?.artifact_id
              : null,
        });
        expect(
          recoveredRawInvocation.tool_version.trim().length,
        ).toBeGreaterThan(0);
        expect(recoveredRawInvocation.intent_at.length).toBeGreaterThan(0);
        expect(
          Array.isArray(
            JSON.parse(recoveredRawInvocation.resolved_regions_json),
          ),
        ).toBe(true);
        expect(
          createHash("sha256")
            .update(recoveredRawInvocation.arguments_json)
            .digest("hex"),
        ).toBe(recoveredTargetActions[0]?.input_hash);
        if (targetInvocationId !== undefined) {
          expect(recoveredTargetInvocations[0]?.invocation_id).toBe(
            targetInvocationId,
          );
        }
        expect(recoveredTargetToolResults).toHaveLength(1);
        expect(recoveredTargetArtifacts).toHaveLength(
          expectedSettlement === "Success" ? 1 : 0,
        );
        expect(recoveredTargetInvocations[0]?.result_ref).toBe(
          expectedSettlement === "Success"
            ? recoveredTargetArtifacts[0]?.artifact_id
            : null,
        );
        if (expectedCrash.artifactCount === 1) {
          expect(recoveredTargetArtifacts).toEqual(targetArtifacts);
        }
        if (expectedCrash.p4Intent === "Pending") {
          expect(p4ImmutableBinding(recoveredRawInvocation)).toEqual(
            p4ImmutableBinding(rawTargetInvocations[0] as RawP4InvocationRow),
          );
        } else if (
          expectedCrash.p4Intent === "Success" ||
          expectedCrash.p4Intent === "ExpectedFailure"
        ) {
          expect(recoveredRawInvocations).toEqual(rawTargetInvocations);
          expect(recoveredTargetInvocations).toEqual(targetInvocations);
        }
        expect(recoveredTargetToolResults[0]).toMatchObject({
          source_kind: "AgentLoopAction",
        });
        const recoveredToolResult = JSON.parse(
          String(recoveredTargetToolResults[0]?.payload_json),
        ) as {
          callRef?: string;
          observationRef?: string;
          status?: string;
          outputText?: string;
          truncated?: boolean;
          artifactRefs?: ReadonlyArray<string>;
        };
        expect(recoveredToolResult).toMatchObject({
          callRef: hit?.callRef,
          observationRef: recoveredTargetActions[0]?.observation_source_ref,
        });
        expect(recoveredTargetToolResults[0]?.source_ref).toBe(
          recoveredToolResult.observationRef,
        );
        // ProviderCall count includes both the decision that emits a ToolCall
        // and a later turn that consumes its committed ToolResult. P3/P9
        // source identity is one ToolResult per exact ObservationRef, not one
        // ToolResult per Provider call.
        expect(
          recovered.toolResults.filter(
            (result) =>
              result.source_ref === recoveredToolResult.observationRef,
          ),
        ).toHaveLength(1);
        if (expectedSettlement === "ExpectedFailure") {
          expect(recoveredRawInvocation.observation_format_version).toBe(
            committedObservationVersion,
          );
          expect(recoveredRawInvocation.observation_sha256).toBe(
            committedObservationHash,
          );
          expect(recoveredRawInvocation.observation_json).toEqual(
            committedObservationBytes,
          );
          expect(recoveredRawInvocation.settlement_json).toBe(
            JSON.stringify({ _tag: "ExpectedFailure" }),
          );
          expect(recoveredToolResult).toMatchObject({
            status: "Failed",
            outputText:
              "filesystem target could not be resolved or accessed inside the sandbox",
            truncated: false,
            artifactRefs: [],
          });
          expect(targetReadToolCalls).toBe(1);
          expect(targetProviderCalls).toBeLessThanOrEqual(2);
          if (targetProviderCalls === 2) {
            expect(latestToolResult).toContain(
              "filesystem target could not be resolved or accessed inside the sandbox",
            );
          }
        }
        expect(
          JSON.stringify(recoveredTargetToolResults[0]).includes(
            hit?.callRef ?? "",
          ),
        ).toBe(true);
        expect(
          fixture.providerCalls
            .slice(targetProviderCallStart)
            .filter(
              (call) =>
                JSON.stringify(call.messages).includes(marker) &&
                call.tools.some((tool) => tool.function?.name === "read") &&
                !call.messages.some(
                  (message) =>
                    message.role === "tool" &&
                    message.content?.includes("FUNCTIONAL_VERIFIED") === true,
                ),
            ),
        ).toHaveLength(1);
        expect(fixture.daemonErrors).toEqual([]);
        activePhase = "final-assertions-passed";
      },
      expectedCrash.timeoutMs,
    );
  }
});
