import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
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
  waitForPublic,
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];
const crashChild = resolve("tests/functional/support/ah-crash-child.mjs");
const actionResultBoundary = "AH7AfterActionResultCommit";
const toolEffectBoundary = "AH7AfterToolEffectBeforeSettlement";

const toolResultPayload = (
  value: unknown,
): { readonly callRef?: string; readonly invocationId?: string } => {
  if (typeof value !== "string") {
    throw new Error("AH7 sourced ToolResult payload is not JSON text");
  }
  return JSON.parse(value) as {
    readonly callRef?: string;
    readonly invocationId?: string;
  };
};

const isObservationForExecution = (
  sourceRef: unknown,
  executionId: unknown,
): boolean =>
  typeof sourceRef === "string" &&
  typeof executionId === "string" &&
  sourceRef.startsWith(`observation_${executionId}_`);

const readActionObservations = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT source_ref, payload_json
           FROM session_entries
          WHERE source_kind = 'AgentLoopAction'
            AND entry_kind = 'Observation'
          ORDER BY sequence`,
      )
      .all() as Array<{ source_ref: string; payload_json: string }>;
  } finally {
    db.close();
  }
};

const readPinnedProviderTurn = (
  databaseFile: string,
  providerTurnId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const entries = db
      .prepare(
        `SELECT source_kind, source_ref, entry_kind, item_type, payload_json
           FROM session_entries
          WHERE source_kind IN ('ProviderTurn', 'ProviderTurnCall')
          ORDER BY sequence`,
      )
      .all() as Array<{
      source_kind: string;
      source_ref: string;
      entry_kind: string;
      item_type: string | null;
      payload_json: string;
    }>;
    const modelOutputs = entries.filter(
      (entry) =>
        entry.source_kind === "ProviderTurn" &&
        ((entry.entry_kind === "ModelOutput" &&
          entry.source_ref === providerTurnId) ||
          (entry.item_type === "AssistantMessage" &&
            entry.source_ref === `${providerTurnId}:assistant`)),
    );
    const typedCalls = entries
      .filter(
        (entry) =>
          entry.source_kind === "ProviderTurnCall" &&
          entry.source_ref.startsWith(`${providerTurnId}:`),
      )
      .map(
        (entry) =>
          JSON.parse(entry.payload_json) as {
            callRef?: string;
            toolRef?: string;
          },
      );
    const legacyCalls =
      typedCalls.length > 0 || modelOutputs.length !== 1
        ? []
        : ((
            JSON.parse(modelOutputs[0]?.payload_json ?? "{}") as {
              toolInvocations?: Array<{
                callRef?: string;
                toolName?: string;
              }>;
            }
          ).toolInvocations ?? []);
    const calls =
      typedCalls.length > 0
        ? typedCalls.map((call) => ({
            callRef: call.callRef,
            toolRef: call.toolRef,
          }))
        : legacyCalls.map((call) => ({
            callRef: call.callRef,
            toolRef: call.toolName,
          }));
    return { modelOutputs, calls };
  } finally {
    db.close();
  }
};

const readConsistentRecoverySnapshot = (
  databaseFile: string,
  executionId: string,
  providerTurnId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN DEFERRED TRANSACTION");
    const snapshot = {
      steps: db
        .prepare(
          `SELECT execution_id, logical_step_no, provider_turn_id,
                  repair_attempt, state, revision, next_action_index
             FROM agent_loop_steps WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt`,
        )
        .all(executionId) as Array<{
        execution_id: string;
        logical_step_no: number;
        provider_turn_id: string;
        repair_attempt: number;
        state: string;
        revision: number;
        next_action_index: number;
      }>,
      actions: db
        .prepare(
          `SELECT execution_id, logical_step_no, repair_attempt, action_index,
                  logical_action_id, call_ref, action_kind, state,
                  observation_source_ref
             FROM agent_loop_step_actions WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt, action_index`,
        )
        .all(executionId) as Array<{
        execution_id: string;
        logical_step_no: number;
        repair_attempt: number;
        action_index: number;
        logical_action_id: string;
        call_ref: string;
        action_kind: string;
        state: string;
        observation_source_ref: string | null;
      }>,
      toolInvocations: db
        .prepare(
          `SELECT invocation_id, execution_id, tool_name,
                  side_effect_semantics, settled_at, settlement_kind, result_ref
             FROM tool_invocations WHERE execution_id = ? ORDER BY invocation_id`,
        )
        .all(executionId) as Array<{
        invocation_id: string;
        execution_id: string;
        tool_name: string;
        side_effect_semantics: string;
        settled_at: string | null;
        settlement_kind: string | null;
        result_ref: string | null;
      }>,
      toolResults: db
        .prepare(
          `SELECT sequence, payload_json, source_kind, source_ref
             FROM session_entries WHERE item_type = 'ToolResult'
            ORDER BY sequence`,
        )
        .all() as Array<{
        sequence: number;
        payload_json: string;
        source_kind: string;
        source_ref: string;
      }>,
      artifacts: db
        .prepare(
          `SELECT a.artifact_id, a.invocation_id, a.content_hash
             FROM artifacts a JOIN tool_invocations ti
               ON ti.invocation_id = a.invocation_id
            WHERE ti.execution_id = ? ORDER BY a.artifact_id`,
        )
        .all(executionId) as Array<{
        artifact_id: string;
        invocation_id: string;
        content_hash: string;
      }>,
      observations: db
        .prepare(
          `SELECT source_ref, payload_json FROM session_entries
            WHERE source_kind = 'AgentLoopAction'
              AND entry_kind = 'Observation' ORDER BY sequence`,
        )
        .all() as Array<{ source_ref: string; payload_json: string }>,
      attempts: db
        .prepare(
          `SELECT provider_turn_id, attempt_no, outcome, settled_at,
                  success_evidence_version FROM provider_attempts
            WHERE provider_turn_id = ? ORDER BY attempt_no`,
        )
        .all(providerTurnId) as Array<{
        provider_turn_id: string;
        attempt_no: number;
        outcome: string;
        settled_at: string | null;
        success_evidence_version: number | null;
      }>,
    };
    db.exec("COMMIT");
    return snapshot;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The read transaction may already have closed after a commit failure.
    }
    throw error;
  } finally {
    db.close();
  }
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("AH7 multi-action B effect before settlement", () => {
  it("replays B's Idempotent effect after A is applied and B settlement is interrupted", async () => {
    const marker = `AH7-AB-EFFECT-${crypto.randomUUID().slice(0, 8)}`;
    const hits: AhProbeHit[] = [];
    const daemonOutput: string[] = [];
    let probeArmed = false;
    let seedWorkProviderCalls = 0;
    let targetProviderCalls = 0;
    let actionBatchSent = false;
    let providerActionBatches = 0;
    const fileA = "proof.txt";
    const fileB = `ah7-b-effect-${marker}.txt`;
    const valueA = `ACTION_A_${marker}`;
    const valueB = `ACTION_B_${marker}`;

    const fixture = await startProductionFixture({
      reply: (call) => {
        const context = JSON.stringify(call.messages);
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        if (
          context.includes(marker) &&
          available.has("assign_work") &&
          !available.has("patch")
        ) {
          return context.includes("WorkAssigned(")
            ? { _tag: "Text", text: `Work admitted for ${marker}.` }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Apply two ordered patches for ${marker}.`,
                  why: "qualify Idempotent B effect recovery after A is durable",
                  constraints: [],
                  completionExpectation:
                    "both patch files contain their distinct marker",
                  verificationMission: {
                    goal: `Verify both ordered patches for ${marker}`,
                    criteria: [
                      {
                        criterionId: "patch-a",
                        requirement: "file A contains its marker once",
                        required: true,
                      },
                      {
                        criterionId: "patch-b",
                        requirement:
                          "file B contains its marker once after replay",
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "AH7 B effect test",
                },
              };
        }
        if (context.includes(marker) && available.has("patch")) {
          if (!probeArmed) {
            if (!available.has("wait")) {
              return { _tag: "HttpError", status: 422 };
            }
            seedWorkProviderCalls += 1;
            return {
              _tag: "ToolCall",
              name: "wait",
              arguments: {
                reason: `AH7 setup waits for the B-effect probe ${marker}`,
                waitSpec: {
                  mode: "Any",
                  conditions: [{ _tag: "Manual" }],
                },
              },
            };
          }
          targetProviderCalls += 1;
          if (targetProviderCalls > 5) {
            return { _tag: "HttpError", status: 429 };
          }
          if (!actionBatchSent) {
            actionBatchSent = true;
            providerActionBatches += 1;
            return {
              _tag: "ToolCalls",
              calls: [
                {
                  name: "patch",
                  arguments: {
                    target: { mount: "workspace", path: fileA },
                    unifiedDiff: `@@ -1,1 +1,1 @@\n-FUNCTIONAL_VERIFIED\n+${valueA}`,
                  },
                },
                {
                  name: "patch",
                  arguments: {
                    target: { mount: "workspace", path: fileB },
                    unifiedDiff: `@@ -0,0 +1,1 @@\n+${valueB}`,
                  },
                },
              ],
            };
          }
          return {
            _tag: "Text",
            text: `Both ordered patches finished for ${marker}.`,
          };
        }
        return { _tag: "Text", text: `Waiting for Work ${marker}.` };
      },
      onDaemonStdout: (line) => {
        daemonOutput.push(line);
        recordAhProbeLine(hits, line);
      },
    });
    fixtures.push(fixture);

    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      `AH7 B effect before settlement ${marker}`,
    );
    await submitHumanMessage(
      client,
      project,
      `Please create a Work to apply two ordered patches for ${marker}.`,
    );
    const approval = await waitForApproval(client, project, marker);
    await client.command(project.projectId, "GrantPermission", {
      permissionGrantId: functionalId("pgr"),
      issuer: "user:local",
      subject: {
        _tag: "WorkspaceAgent",
        workspaceId: project.rootWorkspaceId,
      },
      capability: "fs:write",
      target: project.rootWorkspaceId,
      expiresAt: null,
    });
    await client.command(project.projectId, "ResolveControlApproval", {
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: "Approve",
      reason: "AH7 B effect public Work admission",
    });
    const currentWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          objective?: string;
          revision: number;
          status: string;
        } | null>("current-work", {
          workspaceId: project.rootWorkspaceId,
        }),
      (work) => work?.workId !== undefined,
    );
    const workId = currentWork?.workId;
    if (workId === undefined)
      throw new Error("AH7 B effect public Work absent");
    expect(currentWork).toMatchObject({
      objective: expect.stringContaining(marker),
      revision: 0,
      status: "Open",
    });
    await waitForPublic(
      async () => seedWorkProviderCalls,
      (count) => count >= 1,
    );
    await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
          activeExecution?: { executionId: string };
        } | null>("current-work", {
          workspaceId: project.rootWorkspaceId,
        }),
      (work) =>
        work?.workId === workId &&
        work.revision === 0 &&
        work.activeExecution === undefined,
    );
    const seedSnapshot = durableSnapshot(fixture.databaseFile);
    const seedExecutionIds = new Set(
      seedSnapshot.executions.map((execution) => execution.execution_id),
    );
    expect(
      seedSnapshot.executions.every(
        (execution) => execution.settlement_kind !== "Failed",
      ),
    ).toBe(true);

    await fixture.crash();
    probeArmed = true;
    const targetProviderCallStart = fixture.providerCalls.length;
    await fixture.restart({
      entry: crashChild,
      daemonEnvironment: { ARBOR_AH_BOUNDARY: actionResultBoundary },
    });
    await client.command(project.projectId, "SteerWork", {
      workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: 0,
      steer: {
        severity: "Normal",
        guidance: `AH7 B-effect probe ${marker}`,
      },
      provenance: { source: "HumanInput" },
    });

    const actionACommit = await waitForPublic(
      async () =>
        hits.find(
          (hit) =>
            hit.boundary === actionResultBoundary && hit.actionIndex === 0,
        ),
      (hit) => hit !== undefined,
      30_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH7 A-result probe absent: ${error instanceof Error ? error.message : String(error)}; providerCalls=${JSON.stringify(fixture.providerCalls.slice(-3))}; daemon=${fixture.daemonErrors.join(" | ")}; output=${daemonOutput.slice(-8).join(" | ")}`,
      );
    });
    if (actionACommit === undefined) {
      throw new Error("Provider did not commit action A");
    }
    expect(actionACommit.executionId).toMatch(/^exe_/u);
    expect(actionACommit.providerTurnId).toMatch(/^ptn_/u);
    expect(actionACommit.logicalActionId).toMatch(/^lac_/u);
    expect(actionACommit.callRef).toMatch(/^call_/u);
    const providerTurnId = actionACommit.providerTurnId;
    const executionId = actionACommit.executionId;
    if (providerTurnId === undefined || executionId === undefined) {
      throw new Error(
        "AH7 action A omitted its pinned execution/ProviderTurn id",
      );
    }
    const originalProviderTurn = readPinnedProviderTurn(
      fixture.databaseFile,
      providerTurnId,
    );
    expect(originalProviderTurn.modelOutputs).toHaveLength(1);
    expect(originalProviderTurn.calls).toHaveLength(2);
    expect(originalProviderTurn.calls.map((call) => call.toolRef)).toEqual([
      "patch",
      "patch",
    ]);
    const expectedBCallRef = originalProviderTurn.calls.find(
      (call) => call.callRef !== actionACommit.callRef,
    )?.callRef;
    expect(expectedBCallRef).toMatch(/^call_/u);
    expect(actionBatchSent).toBe(true);
    expect(providerActionBatches).toBe(1);
    expect(targetProviderCalls).toBe(1);
    expect(seedExecutionIds.has(actionACommit.executionId)).toBe(false);

    await fixture.crash();
    const afterA = durableSnapshot(fixture.databaseFile);
    const afterASteps = afterA.steps.filter(
      (step) => step.execution_id === actionACommit.executionId,
    );
    const afterAActions = afterA.actions.filter(
      (action) => action.execution_id === actionACommit.executionId,
    );
    const afterAInvocations = afterA.toolInvocations.filter(
      (invocation) => invocation.execution_id === actionACommit.executionId,
    );
    const afterAToolResults = afterA.toolResults.filter((entry) =>
      isObservationForExecution(entry.source_ref, actionACommit.executionId),
    );
    const afterAInvocationIds = new Set(
      afterAInvocations.map((invocation) => invocation.invocation_id),
    );
    const afterAArtifacts = afterA.artifacts.filter((artifact) =>
      afterAInvocationIds.has(artifact.invocation_id),
    );
    expect(afterASteps).toEqual([
      expect.objectContaining({
        execution_id: actionACommit.executionId,
        logical_step_no: 0,
        provider_turn_id: actionACommit.providerTurnId,
        state: "ActionsInProgress",
        next_action_index: 1,
      }),
    ]);
    expect(afterAActions).toEqual([
      expect.objectContaining({
        execution_id: actionACommit.executionId,
        action_index: 0,
        logical_action_id: actionACommit.logicalActionId,
        call_ref: actionACommit.callRef,
        action_kind: "patch",
        state: "Applied",
        observation_source_ref: expect.stringMatching(/^observation_/u),
      }),
    ]);
    expect(afterAInvocations).toHaveLength(1);
    expect(afterAInvocations[0]).toMatchObject({
      execution_id: actionACommit.executionId,
      tool_name: "patch",
      side_effect_semantics: "Idempotent",
      settlement_kind: "Success",
      settled_at: expect.any(String),
    });
    expect(afterAToolResults).toHaveLength(1);
    expect(toolResultPayload(afterAToolResults[0]?.payload_json).callRef).toBe(
      actionACommit.callRef,
    );
    expect(afterAArtifacts).toHaveLength(1);
    expect(
      readActionObservations(fixture.databaseFile).filter((observation) =>
        observation.source_ref.startsWith(
          `observation_${actionACommit.executionId}_`,
        ),
      ),
    ).toHaveLength(1);
    expect(readFileSync(join(fixture.workspaceDirectory, fileA), "utf8")).toBe(
      valueA,
    );
    expect(() =>
      readFileSync(join(fixture.workspaceDirectory, fileB), "utf8"),
    ).toThrow();

    await fixture.restart({
      entry: crashChild,
      daemonEnvironment: { ARBOR_AH_BOUNDARY: toolEffectBoundary },
    });
    const actionBEffect = await waitForPublic(
      async () =>
        hits.find(
          (hit) =>
            hit.boundary === toolEffectBoundary &&
            hit.executionId === actionACommit.executionId &&
            hit.callRef !== actionACommit.callRef,
        ),
      (hit) => hit !== undefined && hit.invocationId !== undefined,
      45_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH7 B effect probe absent: ${error instanceof Error ? error.message : String(error)}; providerCalls=${JSON.stringify(fixture.providerCalls.slice(-4))}; snapshot=${JSON.stringify(durableSnapshot(fixture.databaseFile))}; daemon=${fixture.daemonErrors.join(" | ")}; output=${daemonOutput.slice(-8).join(" | ")}`,
      );
    });
    if (
      actionBEffect === undefined ||
      actionBEffect.invocationId === undefined
    ) {
      throw new Error("Action B effect probe lacked a P4 invocation identity");
    }
    expect(actionBEffect.callRef).toMatch(/^call_/u);
    expect(actionBEffect.callRef).toBe(expectedBCallRef);
    expect(actionBEffect.callRef).not.toBe(actionACommit.callRef);
    expect(readFileSync(join(fixture.workspaceDirectory, fileA), "utf8")).toBe(
      valueA,
    );
    expect(readFileSync(join(fixture.workspaceDirectory, fileB), "utf8")).toBe(
      valueB,
    );

    await fixture.crash();
    const afterBEffectBeforeSettlement = durableSnapshot(fixture.databaseFile);
    const beforeSettlementSteps = afterBEffectBeforeSettlement.steps.filter(
      (step) => step.execution_id === actionACommit.executionId,
    );
    const beforeSettlementActions = afterBEffectBeforeSettlement.actions.filter(
      (action) => action.execution_id === actionACommit.executionId,
    );
    const beforeSettlementInvocations =
      afterBEffectBeforeSettlement.toolInvocations.filter(
        (invocation) => invocation.execution_id === actionACommit.executionId,
      );
    const beforeSettlementToolResults =
      afterBEffectBeforeSettlement.toolResults.filter((entry) =>
        isObservationForExecution(entry.source_ref, actionACommit.executionId),
      );
    const beforeSettlementInvocationIds = new Set(
      beforeSettlementInvocations.map((invocation) => invocation.invocation_id),
    );
    const beforeSettlementArtifacts =
      afterBEffectBeforeSettlement.artifacts.filter((artifact) =>
        beforeSettlementInvocationIds.has(artifact.invocation_id),
      );
    expect(beforeSettlementSteps).toEqual([
      expect.objectContaining({
        execution_id: actionACommit.executionId,
        logical_step_no: 0,
        provider_turn_id: actionACommit.providerTurnId,
        state: "ActionsInProgress",
        next_action_index: 1,
      }),
    ]);
    expect(beforeSettlementActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execution_id: actionACommit.executionId,
          action_index: 0,
          logical_action_id: actionACommit.logicalActionId,
          call_ref: actionACommit.callRef,
          action_kind: "patch",
          state: "Applied",
        }),
        expect.objectContaining({
          execution_id: actionACommit.executionId,
          action_index: 1,
          call_ref: actionBEffect.callRef,
          action_kind: "patch",
          state: "Pending",
          observation_source_ref: null,
        }),
      ]),
    );
    expect(beforeSettlementActions).toHaveLength(2);
    expect(beforeSettlementInvocations).toHaveLength(2);
    expect(beforeSettlementInvocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execution_id: actionACommit.executionId,
          tool_name: "patch",
          side_effect_semantics: "Idempotent",
          settlement_kind: "Success",
          settled_at: expect.any(String),
        }),
        expect.objectContaining({
          invocation_id: actionBEffect.invocationId,
          execution_id: actionACommit.executionId,
          tool_name: "patch",
          side_effect_semantics: "Idempotent",
          settlement_kind: null,
          settled_at: null,
        }),
      ]),
    );
    expect(beforeSettlementToolResults).toHaveLength(1);
    expect(
      toolResultPayload(beforeSettlementToolResults[0]?.payload_json).callRef,
    ).toBe(actionACommit.callRef);
    expect(beforeSettlementArtifacts).toHaveLength(1);
    const observationsBeforeRecovery = readActionObservations(
      fixture.databaseFile,
    ).filter((observation) =>
      observation.source_ref.startsWith(
        `observation_${actionACommit.executionId}_`,
      ),
    );
    expect(observationsBeforeRecovery).toHaveLength(1);
    expect(
      JSON.parse(observationsBeforeRecovery[0]?.payload_json ?? "{}"),
    ).toMatchObject({ callRef: actionACommit.callRef });
    expect(targetProviderCalls).toBe(1);
    expect(providerActionBatches).toBe(1);
    expect(
      fixture.providerCalls
        .slice(targetProviderCallStart)
        .filter(
          (call) =>
            JSON.stringify(call.messages).includes(marker) &&
            call.tools.some((tool) => tool.function?.name === "patch"),
        ),
    ).toHaveLength(1);

    await fixture.restart();
    const recovered = await waitForPublic(
      async () =>
        readConsistentRecoverySnapshot(
          fixture.databaseFile,
          executionId,
          providerTurnId,
        ),
      (snapshot) => {
        const step = snapshot.steps.find(
          (candidate) =>
            candidate.execution_id === actionACommit.executionId &&
            candidate.logical_step_no === 0 &&
            candidate.repair_attempt === 0 &&
            candidate.provider_turn_id === actionACommit.providerTurnId,
        );
        return (
          step !== undefined &&
          step.next_action_index === 2 &&
          ["StepEffectsCommitted", "NextStepReady"].includes(step.state) &&
          snapshot.actions.some(
            (action) =>
              action.execution_id === actionACommit.executionId &&
              action.logical_step_no === 0 &&
              action.repair_attempt === 0 &&
              action.call_ref === actionBEffect.callRef &&
              action.action_index === 1 &&
              action.state === "Applied",
          ) &&
          snapshot.toolInvocations.some(
            (invocation) =>
              invocation.invocation_id === actionBEffect.invocationId &&
              invocation.settled_at !== null &&
              invocation.settlement_kind === "Success",
          ) &&
          snapshot.toolResults.filter((result) =>
            isObservationForExecution(
              result.source_ref,
              actionACommit.executionId,
            ),
          ).length === 2 &&
          snapshot.artifacts.length === 2 &&
          snapshot.observations.filter((observation) =>
            observation.source_ref.startsWith(
              `observation_${actionACommit.executionId}_`,
            ),
          ).length === 2 &&
          snapshot.attempts.length === 1
        );
      },
      45_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH7 B idempotent replay absent: ${error instanceof Error ? error.message : String(error)}; providerCalls=${JSON.stringify(fixture.providerCalls.slice(-4))}; snapshot=${JSON.stringify(durableSnapshot(fixture.databaseFile))}; daemon=${fixture.daemonErrors.join(" | ")}; output=${daemonOutput.slice(-8).join(" | ")}`,
      );
    });

    const actionA = recovered.actions.find(
      (action) =>
        action.execution_id === actionACommit.executionId &&
        action.action_index === 0,
    );
    const actionB = recovered.actions.find(
      (action) =>
        action.execution_id === actionACommit.executionId &&
        action.action_index === 1,
    );
    const recoveredStep = recovered.steps.find(
      (step) =>
        step.execution_id === actionACommit.executionId &&
        step.logical_step_no === 0 &&
        step.provider_turn_id === actionACommit.providerTurnId,
    );
    expect(recoveredStep).toMatchObject({ next_action_index: 2 });
    expect(["StepEffectsCommitted", "NextStepReady"]).toContain(
      recoveredStep?.state,
    );
    expect(actionA).toMatchObject({
      logical_action_id: actionACommit.logicalActionId,
      call_ref: actionACommit.callRef,
      action_kind: "patch",
      state: "Applied",
    });
    expect(actionB).toMatchObject({
      call_ref: actionBEffect.callRef,
      action_kind: "patch",
      state: "Applied",
      observation_source_ref: expect.stringMatching(/^observation_/u),
    });
    expect(actionB?.logical_action_id).not.toBe(actionA?.logical_action_id);
    expect(recovered.toolInvocations).toHaveLength(2);
    expect(
      recovered.toolInvocations.filter(
        (invocation) => invocation.invocation_id === actionBEffect.invocationId,
      ),
    ).toEqual([
      expect.objectContaining({
        side_effect_semantics: "Idempotent",
        settlement_kind: "Success",
        settled_at: expect.any(String),
      }),
    ]);
    const recoveredTargetToolResults = recovered.toolResults.filter((entry) =>
      isObservationForExecution(entry.source_ref, actionACommit.executionId),
    );
    expect(recoveredTargetToolResults).toHaveLength(2);
    const toolResults = recoveredTargetToolResults.map((entry) =>
      toolResultPayload(entry.payload_json),
    );
    expect(toolResults.map((result) => result.callRef).sort()).toEqual(
      [actionACommit.callRef, actionBEffect.callRef].sort(),
    );
    expect(
      toolResults.filter(
        (result) => result.invocationId === actionBEffect.invocationId,
      ),
    ).toHaveLength(1);
    expect(recovered.artifacts).toHaveLength(2);
    expect(
      recovered.artifacts.filter(
        (artifact) => artifact.invocation_id === actionBEffect.invocationId,
      ),
    ).toHaveLength(1);
    const observationsAfterRecovery = recovered.observations.filter(
      (observation) =>
        observation.source_ref.startsWith(
          `observation_${actionACommit.executionId}_`,
        ),
    );
    expect(observationsAfterRecovery).toHaveLength(2);
    const observedCallRefs = observationsAfterRecovery.map(
      (observation) =>
        (JSON.parse(observation.payload_json) as { callRef?: string }).callRef,
    );
    expect(observedCallRefs.sort()).toEqual(
      [actionACommit.callRef, actionBEffect.callRef].sort(),
    );
    expect(readFileSync(join(fixture.workspaceDirectory, fileA), "utf8")).toBe(
      valueA,
    );
    expect(readFileSync(join(fixture.workspaceDirectory, fileB), "utf8")).toBe(
      valueB,
    );
    expect(
      recovered.attempts.filter(
        (attempt) => attempt.provider_turn_id === actionACommit.providerTurnId,
      ),
    ).toHaveLength(1);
    const providerTurnAfterRecovery = readPinnedProviderTurn(
      fixture.databaseFile,
      providerTurnId,
    );
    expect(providerTurnAfterRecovery.modelOutputs).toHaveLength(1);
    expect(
      providerTurnAfterRecovery.calls.map((call) => call.callRef).sort(),
    ).toEqual([actionACommit.callRef, expectedBCallRef].sort());
    expect(providerActionBatches).toBe(1);
    expect(fixture.daemonErrors).toEqual([]);
  }, 120_000);
});
