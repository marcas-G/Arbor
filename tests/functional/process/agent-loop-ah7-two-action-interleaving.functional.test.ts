import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("AH7 general two-action interleaving", () => {
  it("recovers action B after action A's Observation and cursor commit", async () => {
    const marker = `AH7-AB-${crypto.randomUUID().slice(0, 8)}`;
    const hits: AhProbeHit[] = [];
    const daemonOutput: string[] = [];
    let targetProviderCalls = 0;
    let actionBatchSent = false;
    let providerActionBatches = 0;
    const fileA = "proof.txt";
    const fileB = `ah7-b-${marker}.txt`;
    const valueA = `ACTION_A_${marker}`;
    const valueB = `ACTION_B_${marker}`;
    const fixture = await startProductionFixture({
      reply: (call) => {
        if (JSON.stringify(call.messages).includes(marker)) {
          targetProviderCalls += 1;
          if (targetProviderCalls > 5) {
            return { _tag: "HttpError", status: 429 };
          }
        }
        if (!actionBatchSent) {
          actionBatchSent = true;
          const available = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
          if (!available.has("patch")) {
            return { _tag: "HttpError", status: 422 };
          }
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
      },
      firstDaemonEntry: crashChild,
      daemonEnvironment: { ARBOR_AH_BOUNDARY: actionIntentBoundary },
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
    const workId = functionalId("wrk");
    await client.command(project.projectId, "AssignWork", {
      workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkspaceRevision: 0,
      objective: `Apply two ordered patches for ${marker}.`,
      why: "qualify normal A/B action interleaving across restart",
      constraints: [],
      completionExpectation: "both patch files contain their distinct marker",
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
      provenance: { predecessorWorkId: null, reason: "AH7 A/B test" },
      revision: 0,
    });

    const firstActionIntent = await waitForPublic(
      async () => ({ hits, providerCalls: fixture.providerCalls.length }),
      (value) =>
        value.hits.some(
          (hit) =>
            hit.boundary === actionIntentBoundary && hit.actionIndex === 0,
        ) || value.providerCalls >= 5,
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

    await fixture.crash();
    const beforeAEffect = durableSnapshot(fixture.databaseFile);
    expect(beforeAEffect.steps).toEqual([
      expect.objectContaining({
        execution_id: hitAIntent.executionId,
        logical_step_no: 0,
        provider_turn_id: hitAIntent.providerTurnId,
        state: "ActionsInProgress",
        next_action_index: 0,
      }),
    ]);
    expect(beforeAEffect.actions).toEqual([
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
    expect(beforeAEffect.actions).toHaveLength(1);
    expect(beforeAEffect.toolInvocations).toEqual([]);
    expect(beforeAEffect.toolResults).toEqual([]);
    expect(beforeAEffect.artifacts).toEqual([]);
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
        ) || value.providerCalls >= 5,
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
    expect(afterA.steps).toEqual([
      expect.objectContaining({
        execution_id: hitA.executionId,
        logical_step_no: 0,
        provider_turn_id: hitA.providerTurnId,
        state: "ActionsInProgress",
        next_action_index: 1,
      }),
    ]);
    expect(afterA.actions).toEqual([
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
    expect(afterA.toolInvocations).toHaveLength(1);
    expect(afterA.toolInvocations).toEqual([
      expect.objectContaining({
        execution_id: hitA.executionId,
        tool_name: "patch",
        side_effect_semantics: "Idempotent",
        settlement_kind: "Success",
        result_ref: expect.any(String),
      }),
    ]);
    expect(afterA.toolResults).toHaveLength(1);
    expect(
      afterA.toolResults.map(
        (entry) => toolResultPayload(entry.payload_json).callRef,
      ),
    ).toEqual([hitA.callRef]);
    expect(afterA.artifacts).toHaveLength(1);
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
        snapshot.toolResults.length === 2,
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
    expect(actionB.logical_action_id).toMatch(/^lac_/u);
    expect(actionB.logical_action_id).not.toBe(hitA.logicalActionId);
    expect(actionB.call_ref).toMatch(/^call_/u);
    expect(actionB.call_ref).not.toBe(hitA.callRef);
    expect(afterB.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execution_id: hitA.executionId,
          logical_step_no: 0,
          provider_turn_id: hitA.providerTurnId,
          next_action_index: 2,
        }),
      ]),
    );
    expect(afterB.actions).toHaveLength(2);
    expect(afterB.actions).toEqual(
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
    expect(afterB.toolInvocations).toHaveLength(2);
    expect(afterB.toolInvocations).toEqual(
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
    expect(afterB.toolResults).toHaveLength(2);
    expect(afterB.artifacts).toHaveLength(2);
    const toolResultPayloads = afterB.toolResults.map((entry) =>
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
      afterB.toolInvocations
        .map((invocation) => invocation.invocation_id)
        .sort(),
    ).toEqual(toolResultInvocationIds);
    expect(
      afterB.artifacts.map((artifact) => artifact.invocation_id).sort(),
    ).toEqual(toolResultInvocationIds);
    expect(readFileSync(join(fixture.workspaceDirectory, fileA), "utf8")).toBe(
      valueA,
    );
    expect(readFileSync(join(fixture.workspaceDirectory, fileB), "utf8")).toBe(
      valueB,
    );
    const targetCalls = fixture.providerCalls.filter((call) =>
      JSON.stringify(call.messages).includes(marker),
    );
    const toolResultCounts = targetCalls.map(
      (call) =>
        call.messages.filter((message) => message.role === "tool").length,
    );
    expect(toolResultCounts.filter((count) => count === 0)).toHaveLength(1);
    expect(toolResultCounts.filter((count) => count === 1)).toHaveLength(0);
    expect(targetProviderCalls).toBeLessThanOrEqual(2);
    expect(fixture.daemonErrors).toEqual([]);
    await fixture.crash();
  }, 120_000);
});
