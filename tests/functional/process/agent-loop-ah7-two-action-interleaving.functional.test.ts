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
const actionIntentBoundary = "AH7AfterActionIntentCommit";
const actionResultBoundary = "AH7AfterActionResultCommit";

const toolResultPayload = (
  value: unknown,
): {
  readonly callRef?: string;
  readonly invocationId?: string;
} => {
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

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("AH7 general two-action interleaving", () => {
  it("recovers action B after action A's Observation and cursor commit", async () => {
    const marker = `AH7-AB-${crypto.randomUUID().slice(0, 8)}`;
    const hits: AhProbeHit[] = [];
    const daemonOutput: string[] = [];
    let probeArmed = false;
    let seedWorkProviderCalls = 0;
    let targetProviderCalls = 0;
    let actionBatchSent = false;
    let providerActionBatches = 0;
    const fileA = "proof.txt";
    const fileB = `ah7-b-${marker}.txt`;
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
                  why: "qualify normal A/B action interleaving across restart",
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
                        requirement: "file B contains its marker once",
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "AH7 A/B test",
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
                reason: `AH7 setup waits for the two-action probe ${marker}`,
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
      `AH7 two-action interleaving ${marker}`,
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
      reason: "AH7 two-action public Work admission",
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
      throw new Error("AH7 two-action public Work absent");
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
    await fixture.restart({
      entry: crashChild,
      daemonEnvironment: { ARBOR_AH_BOUNDARY: actionIntentBoundary },
    });
    await client.command(project.projectId, "SteerWork", {
      workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: 0,
      steer: {
        severity: "Normal",
        guidance: `AH7 two-action probe ${marker}`,
      },
      provenance: { source: "HumanInput" },
    });

    const firstActionIntent = await waitForPublic(
      async () => ({ hits, providerCalls: fixture.providerCalls.length }),
      (value) =>
        value.hits.some(
          (hit) =>
            hit.boundary === actionIntentBoundary && hit.actionIndex === 0,
        ) || targetProviderCalls >= 5,
      30_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH7 A-intent probe absent: ${error instanceof Error ? error.message : String(error)}; targetProviderCalls=${targetProviderCalls}; tools=${JSON.stringify(fixture.providerCalls[0]?.tools.map((tool) => tool.function?.name))}; daemon=${fixture.daemonErrors.join(" | ")}; output=${daemonOutput.slice(-8).join(" | ")}`,
      );
    });
    const hitAIntent = firstActionIntent.hits.find(
      (hit) => hit.boundary === actionIntentBoundary && hit.actionIndex === 0,
    );
    if (hitAIntent === undefined) {
      await fixture.crash();
      throw new Error(
        "Provider-call cap reached before action A intent commit",
      );
    }
    expect(hitAIntent.providerTurnId).toMatch(/^ptn_/u);
    expect(hitAIntent.logicalActionId).toMatch(/^lac_/u);
    expect(hitAIntent.callRef).toMatch(/^call_/u);
    expect(actionBatchSent).toBe(true);
    expect(providerActionBatches).toBe(1);
    expect(seedExecutionIds.has(hitAIntent.executionId)).toBe(false);
    expect(targetProviderCalls).toBe(1);

    await fixture.crash();
    const beforeAEffect = durableSnapshot(fixture.databaseFile);
    const beforeAEffectSteps = beforeAEffect.steps.filter(
      (step) => step.execution_id === hitAIntent.executionId,
    );
    const beforeAEffectActions = beforeAEffect.actions.filter(
      (action) => action.execution_id === hitAIntent.executionId,
    );
    const beforeAEffectInvocations = beforeAEffect.toolInvocations.filter(
      (invocation) => invocation.execution_id === hitAIntent.executionId,
    );
    const beforeAEffectToolResults = beforeAEffect.toolResults.filter((entry) =>
      isObservationForExecution(entry.source_ref, hitAIntent.executionId),
    );
    const beforeAEffectInvocationIds = new Set(
      beforeAEffectInvocations.map((invocation) => invocation.invocation_id),
    );
    const beforeAEffectArtifacts = beforeAEffect.artifacts.filter((artifact) =>
      beforeAEffectInvocationIds.has(artifact.invocation_id),
    );
    expect(beforeAEffectSteps).toEqual([
      expect.objectContaining({
        execution_id: hitAIntent.executionId,
        logical_step_no: 0,
        provider_turn_id: hitAIntent.providerTurnId,
        state: "ActionsInProgress",
        next_action_index: 0,
      }),
    ]);
    expect(beforeAEffectActions).toEqual([
      expect.objectContaining({
        execution_id: hitAIntent.executionId,
        logical_step_no: 0,
        action_index: 0,
        logical_action_id: hitAIntent.logicalActionId,
        call_ref: hitAIntent.callRef,
        action_kind: "patch",
        state: "Pending",
      }),
    ]);
    expect(beforeAEffectActions).toHaveLength(1);
    expect(beforeAEffectInvocations).toEqual([]);
    expect(beforeAEffectToolResults).toEqual([]);
    expect(beforeAEffectArtifacts).toEqual([]);
    expect(() =>
      readFileSync(join(fixture.workspaceDirectory, fileB), "utf8"),
    ).toThrow();
    expect(targetProviderCalls).toBe(1);

    await fixture.restart({
      entry: crashChild,
      daemonEnvironment: { ARBOR_AH_BOUNDARY: actionResultBoundary },
    });
    const firstActionCommit = await waitForPublic(
      async () => ({ hits, providerCalls: fixture.providerCalls.length }),
      (value) =>
        value.hits.some(
          (hit) =>
            hit.boundary === actionResultBoundary && hit.actionIndex === 0,
        ) || targetProviderCalls >= 5,
      30_000,
    );
    const hitA = firstActionCommit.hits.find(
      (hit) => hit.boundary === actionResultBoundary && hit.actionIndex === 0,
    );
    if (hitA === undefined) {
      await fixture.crash();
      throw new Error("Restart did not commit action A's result");
    }
    expect(hitA.providerTurnId).toBe(hitAIntent.providerTurnId);
    expect(hitA.executionId).toBe(hitAIntent.executionId);
    expect(hitA.logicalActionId).toBe(hitAIntent.logicalActionId);
    expect(hitA.callRef).toBe(hitAIntent.callRef);
    expect(targetProviderCalls).toBe(1);

    await fixture.crash();
    const afterA = durableSnapshot(fixture.databaseFile);
    const afterASteps = afterA.steps.filter(
      (step) => step.execution_id === hitA.executionId,
    );
    const afterAActions = afterA.actions.filter(
      (action) => action.execution_id === hitA.executionId,
    );
    const afterAInvocations = afterA.toolInvocations.filter(
      (invocation) => invocation.execution_id === hitA.executionId,
    );
    const afterAToolResults = afterA.toolResults.filter((entry) =>
      isObservationForExecution(entry.source_ref, hitA.executionId),
    );
    const afterAInvocationIds = new Set(
      afterAInvocations.map((invocation) => invocation.invocation_id),
    );
    const afterAArtifacts = afterA.artifacts.filter((artifact) =>
      afterAInvocationIds.has(artifact.invocation_id),
    );
    expect(afterASteps).toEqual([
      expect.objectContaining({
        execution_id: hitA.executionId,
        logical_step_no: 0,
        provider_turn_id: hitA.providerTurnId,
        state: "ActionsInProgress",
        next_action_index: 1,
      }),
    ]);
    expect(afterAActions).toEqual([
      expect.objectContaining({
        execution_id: hitA.executionId,
        logical_step_no: 0,
        action_index: 0,
        logical_action_id: hitA.logicalActionId,
        call_ref: hitA.callRef,
        action_kind: "patch",
        state: "Applied",
        result_ref: expect.stringMatching(/^result_/u),
        observation_source_ref: expect.stringMatching(/^observation_/u),
      }),
    ]);
    expect(afterAInvocations).toHaveLength(1);
    expect(afterAInvocations).toEqual([
      expect.objectContaining({
        execution_id: hitA.executionId,
        tool_name: "patch",
        side_effect_semantics: "Idempotent",
        settlement_kind: "Success",
        result_ref: expect.any(String),
      }),
    ]);
    expect(afterAToolResults).toHaveLength(1);
    expect(
      afterAToolResults.map(
        (entry) => toolResultPayload(entry.payload_json).callRef,
      ),
    ).toEqual([hitA.callRef]);
    expect(afterAArtifacts).toHaveLength(1);
    expect(readFileSync(join(fixture.workspaceDirectory, fileA), "utf8")).toBe(
      valueA,
    );
    expect(() =>
      readFileSync(join(fixture.workspaceDirectory, fileB), "utf8"),
    ).toThrow();

    await fixture.restart();
    const afterB = await waitForPublic(
      async () => durableSnapshot(fixture.databaseFile),
      (snapshot) =>
        snapshot.actions.some(
          (action) =>
            action.execution_id === hitA.executionId &&
            action.action_index === 1 &&
            action.state === "Applied",
        ) &&
        snapshot.toolInvocations.filter(
          (tool) =>
            tool.execution_id === hitA.executionId &&
            tool.tool_name === "patch",
        ).length === 2 &&
        snapshot.toolResults.filter((entry) =>
          isObservationForExecution(entry.source_ref, hitA.executionId),
        ).length === 2,
      45_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH7 B recovery absent: ${error instanceof Error ? error.message : String(error)}; targetProviderCalls=${targetProviderCalls}; calls=${JSON.stringify(fixture.providerCalls.slice(-3))}; snapshot=${JSON.stringify(durableSnapshot(fixture.databaseFile))}; daemon=${fixture.daemonErrors.join(" | ")}; output=${daemonOutput.slice(-8).join(" | ")}`,
      );
    });
    const actionB = afterB.actions.find(
      (action) =>
        action.execution_id === hitA.executionId && action.action_index === 1,
    );
    if (actionB === undefined) {
      await fixture.crash();
      throw new Error("Action B durable result missing after restart");
    }
    const afterBActions = afterB.actions.filter(
      (action) => action.execution_id === hitA.executionId,
    );
    const afterBInvocations = afterB.toolInvocations.filter(
      (invocation) => invocation.execution_id === hitA.executionId,
    );
    const afterBToolResults = afterB.toolResults.filter((entry) =>
      isObservationForExecution(entry.source_ref, hitA.executionId),
    );
    const afterBInvocationIds = new Set(
      afterBInvocations.map((invocation) => invocation.invocation_id),
    );
    const afterBArtifacts = afterB.artifacts.filter((artifact) =>
      afterBInvocationIds.has(artifact.invocation_id),
    );
    expect(actionB.logical_action_id).toMatch(/^lac_/u);
    expect(actionB.logical_action_id).not.toBe(hitA.logicalActionId);
    expect(actionB.call_ref).toMatch(/^call_/u);
    expect(actionB.call_ref).not.toBe(hitA.callRef);
    expect(
      afterB.steps.filter((step) => step.execution_id === hitA.executionId),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execution_id: hitA.executionId,
          logical_step_no: 0,
          provider_turn_id: hitA.providerTurnId,
          next_action_index: 2,
        }),
      ]),
    );
    expect(afterBActions).toHaveLength(2);
    expect(afterBActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_index: 0,
          logical_action_id: hitA.logicalActionId,
          call_ref: hitA.callRef,
          action_kind: "patch",
          state: "Applied",
        }),
        expect.objectContaining({
          action_index: 1,
          logical_action_id: actionB.logical_action_id,
          call_ref: actionB.call_ref,
          action_kind: "patch",
          state: "Applied",
        }),
      ]),
    );
    expect(afterBInvocations).toHaveLength(2);
    expect(afterBInvocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execution_id: hitA.executionId,
          tool_name: "patch",
          side_effect_semantics: "Idempotent",
          settlement_kind: "Success",
        }),
        expect.objectContaining({
          execution_id: hitA.executionId,
          tool_name: "patch",
          side_effect_semantics: "Idempotent",
          settlement_kind: "Success",
        }),
      ]),
    );
    expect(afterBToolResults).toHaveLength(2);
    expect(afterBArtifacts).toHaveLength(2);
    const toolResultPayloads = afterBToolResults.map((entry) =>
      toolResultPayload(entry.payload_json),
    );
    expect(toolResultPayloads.map((result) => result.callRef).sort()).toEqual(
      [hitA.callRef, actionB.call_ref].sort(),
    );
    const toolResultInvocationIds = toolResultPayloads
      .map((result) => result.invocationId)
      .sort();
    expect(toolResultInvocationIds).toHaveLength(2);
    expect(new Set(toolResultInvocationIds).size).toBe(2);
    expect(
      afterBInvocations.map((invocation) => invocation.invocation_id).sort(),
    ).toEqual(toolResultInvocationIds);
    expect(
      afterBArtifacts.map((artifact) => artifact.invocation_id).sort(),
    ).toEqual(toolResultInvocationIds);
    expect(readFileSync(join(fixture.workspaceDirectory, fileA), "utf8")).toBe(
      valueA,
    );
    expect(readFileSync(join(fixture.workspaceDirectory, fileB), "utf8")).toBe(
      valueB,
    );
    const originalTurnAfterRecovery = readPinnedProviderTurn(
      fixture.databaseFile,
      hitA.providerTurnId ?? "",
    );
    expect(originalTurnAfterRecovery.modelOutputs).toHaveLength(1);
    expect(
      originalTurnAfterRecovery.calls.map((call) => call.callRef).sort(),
    ).toEqual([hitA.callRef, actionB.call_ref].sort());
    expect(targetProviderCalls).toBeLessThanOrEqual(2);
    expect(fixture.daemonErrors).toEqual([]);
    await fixture.crash();
  }, 120_000);
});
