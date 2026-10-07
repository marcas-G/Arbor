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

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("AH7 multi-action B effect before settlement", () => {
  it("replays B's Idempotent effect after A is applied and B settlement is interrupted", async () => {
    const marker = `AH7-AB-EFFECT-${crypto.randomUUID().slice(0, 8)}`;
    const hits: AhProbeHit[] = [];
    const daemonOutput: string[] = [];
    let targetProviderCalls = 0;
    let actionBatchSent = false;
    let providerActionBatches = 0;
    const fileA = "proof.txt";
    const fileB = `ah7-b-effect-${marker}.txt`;
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
      daemonEnvironment: { ARBOR_AH_BOUNDARY: actionResultBoundary },
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
      why: "qualify Idempotent B effect recovery after A is durable",
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
            requirement: "file B contains its marker once after replay",
            required: true,
          },
        ],
        riskRequirements: [],
      },
      provenance: { predecessorWorkId: null, reason: "AH7 B effect test" },
      revision: 0,
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
    expect(actionBatchSent).toBe(true);
    expect(providerActionBatches).toBe(1);
    expect(targetProviderCalls).toBe(1);

    await fixture.crash();
    const afterA = durableSnapshot(fixture.databaseFile);
    expect(afterA.steps).toEqual([
      expect.objectContaining({
        execution_id: actionACommit.executionId,
        logical_step_no: 0,
        provider_turn_id: actionACommit.providerTurnId,
        state: "ActionsInProgress",
        next_action_index: 1,
      }),
    ]);
    expect(afterA.actions).toEqual([
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
    expect(afterA.toolInvocations).toHaveLength(1);
    expect(afterA.toolInvocations[0]).toMatchObject({
      execution_id: actionACommit.executionId,
      tool_name: "patch",
      side_effect_semantics: "Idempotent",
      settlement_kind: "Success",
      settled_at: expect.any(String),
    });
    expect(afterA.toolResults).toHaveLength(1);
    expect(toolResultPayload(afterA.toolResults[0]?.payload_json).callRef).toBe(
      actionACommit.callRef,
    );
    expect(afterA.artifacts).toHaveLength(1);
    expect(readActionObservations(fixture.databaseFile)).toHaveLength(1);
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
    expect(actionBEffect.callRef).not.toBe(actionACommit.callRef);
    expect(readFileSync(join(fixture.workspaceDirectory, fileA), "utf8")).toBe(
      valueA,
    );
    expect(readFileSync(join(fixture.workspaceDirectory, fileB), "utf8")).toBe(
      valueB,
    );

    await fixture.crash();
    const afterBEffectBeforeSettlement = durableSnapshot(fixture.databaseFile);
    expect(afterBEffectBeforeSettlement.steps).toEqual([
      expect.objectContaining({
        execution_id: actionACommit.executionId,
        logical_step_no: 0,
        provider_turn_id: actionACommit.providerTurnId,
        state: "ActionsInProgress",
        next_action_index: 1,
      }),
    ]);
    expect(afterBEffectBeforeSettlement.actions).toEqual(
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
    expect(afterBEffectBeforeSettlement.actions).toHaveLength(2);
    expect(afterBEffectBeforeSettlement.toolInvocations).toHaveLength(2);
    expect(afterBEffectBeforeSettlement.toolInvocations).toEqual(
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
    expect(afterBEffectBeforeSettlement.toolResults).toHaveLength(1);
    expect(
      toolResultPayload(
        afterBEffectBeforeSettlement.toolResults[0]?.payload_json,
      ).callRef,
    ).toBe(actionACommit.callRef);
    expect(afterBEffectBeforeSettlement.artifacts).toHaveLength(1);
    const observationsBeforeRecovery = readActionObservations(
      fixture.databaseFile,
    );
    expect(observationsBeforeRecovery).toHaveLength(1);
    expect(
      JSON.parse(observationsBeforeRecovery[0]?.payload_json ?? "{}"),
    ).toMatchObject({ callRef: actionACommit.callRef });
    expect(targetProviderCalls).toBe(1);
    expect(providerActionBatches).toBe(1);
    expect(fixture.providerCalls).toHaveLength(1);

    await fixture.restart();
    const recovered = await waitForPublic(
      async () => durableSnapshot(fixture.databaseFile),
      (snapshot) =>
        snapshot.actions.some(
          (action) =>
            action.execution_id === actionACommit.executionId &&
            action.call_ref === actionBEffect.callRef &&
            action.action_index === 1 &&
            action.state === "Applied",
        ) &&
        snapshot.toolInvocations.some(
          (invocation) =>
            invocation.invocation_id === actionBEffect.invocationId &&
            invocation.settled_at !== null,
        ) &&
        snapshot.toolResults.length === 2,
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
    expect(recovered.toolResults).toHaveLength(2);
    const toolResults = recovered.toolResults.map((entry) =>
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
    const observationsAfterRecovery = readActionObservations(
      fixture.databaseFile,
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
    expect(providerActionBatches).toBe(1);
    expect(fixture.daemonErrors).toEqual([]);
  }, 120_000);
});
