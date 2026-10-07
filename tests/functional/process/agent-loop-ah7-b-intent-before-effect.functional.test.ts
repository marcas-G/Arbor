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
const toolIntentBoundary = "AH7AfterToolIntentCommit";

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
              toolInvocations?: Array<{ callRef?: string; toolName?: string }>;
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
    return {
      modelOutputs,
      calls,
    };
  } finally {
    db.close();
  }
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

const readWorkWait = (databaseFile: string, workId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT work_id, wait_mode, conditions_json FROM work_waits WHERE work_id = ?",
      )
      .get(workId) as
      | { work_id: string; wait_mode: string; conditions_json: string }
      | undefined;
  } finally {
    db.close();
  }
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("AH7 action B intent before effect", () => {
  it("replays B once after killing the process at its committed P4 intent", async () => {
    const marker = `AH7-B-INTENT-${crypto.randomUUID().slice(0, 8)}`;
    const hits: AhProbeHit[] = [];
    const daemonOutput: string[] = [];
    let targetProviderCalls = 0;
    let actionBatchSent = false;
    let providerActionBatches = 0;
    let successorWaitCalls = 0;
    const fileA = "proof.txt";
    const fileB = `ah7-b-intent-${marker}.txt`;
    const valueA = `ACTION_A_${marker}`;
    const valueB = `ACTION_B_${marker}`;

    const fixture = await startProductionFixture({
      reply: (call) => {
        if (JSON.stringify(call.messages).includes(marker)) {
          targetProviderCalls += 1;
        }
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        if (!actionBatchSent) {
          actionBatchSent = true;
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
        if (available.has("wait")) {
          successorWaitCalls += 1;
          return {
            _tag: "ToolCall",
            name: "wait",
            arguments: {
              reason: `wait after both ordered patches for ${marker}`,
              waitSpec: {
                mode: "Any",
                conditions: [{ _tag: "Manual" }],
              },
            },
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
      `AH7 B intent before effect ${marker}`,
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
      why: "qualify B recovery after P4 intent but before effect",
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
      provenance: { predecessorWorkId: null, reason: "AH7 B intent test" },
      revision: 0,
    });

    const actionA = await waitForPublic(
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
    if (actionA === undefined) {
      throw new Error("Provider did not commit action A");
    }
    const executionId = actionA.executionId;
    const providerTurnId = actionA.providerTurnId;
    const actionACallRef = actionA.callRef;
    if (
      executionId === undefined ||
      providerTurnId === undefined ||
      actionACallRef === undefined
    ) {
      throw new Error("AH7 action A omitted its pinned identity");
    }
    expect(actionA.actionIndex).toBe(0);
    expect(actionA.logicalActionId).toMatch(/^lac_/u);
    expect(actionACallRef).toMatch(/^call_/u);
    expect(actionBatchSent).toBe(true);
    expect(providerActionBatches).toBe(1);
    expect(targetProviderCalls).toBe(1);

    await fixture.crash();
    const afterA = durableSnapshot(fixture.databaseFile);
    expect(afterA.steps).toEqual([
      expect.objectContaining({
        execution_id: executionId,
        logical_step_no: 0,
        provider_turn_id: providerTurnId,
        state: "ActionsInProgress",
        next_action_index: 1,
        decoded_output_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
    const originalStep = afterA.steps[0] as {
      readonly decoded_output_hash: string;
    };
    const originalTurnAfterA = readPinnedProviderTurn(
      fixture.databaseFile,
      providerTurnId,
    );
    expect(originalTurnAfterA.modelOutputs).toHaveLength(1);
    expect(originalTurnAfterA.calls).toHaveLength(2);
    expect(originalTurnAfterA.calls.map((call) => call.toolRef)).toEqual([
      "patch",
      "patch",
    ]);
    expect(originalTurnAfterA.calls.map((call) => call.callRef)).toContain(
      actionACallRef,
    );
    const expectedBCallRef = originalTurnAfterA.calls.find(
      (call) => call.callRef !== actionACallRef,
    )?.callRef;
    expect(expectedBCallRef).toMatch(/^call_/u);
    expect(afterA.actions).toEqual([
      expect.objectContaining({
        execution_id: executionId,
        action_index: 0,
        logical_action_id: actionA.logicalActionId,
        call_ref: actionACallRef,
        action_kind: "patch",
        state: "Applied",
      }),
    ]);
    expect(afterA.toolInvocations).toEqual([
      expect.objectContaining({
        execution_id: executionId,
        tool_name: "patch",
        side_effect_semantics: "Idempotent",
        settlement_kind: "Success",
      }),
    ]);
    expect(afterA.toolResults).toHaveLength(1);
    expect(toolResultPayload(afterA.toolResults[0]?.payload_json).callRef).toBe(
      actionACallRef,
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
      daemonEnvironment: { ARBOR_AH_BOUNDARY: toolIntentBoundary },
    });
    const bIntent = await waitForPublic(
      async () =>
        hits.find(
          (hit) =>
            hit.boundary === toolIntentBoundary &&
            hit.executionId === executionId &&
            hit.callRef !== actionACallRef,
        ),
      (hit) => hit?.invocationId !== undefined,
      45_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH7 B P4 intent probe absent: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(durableSnapshot(fixture.databaseFile))}; daemon=${fixture.daemonErrors.join(" | ")}; output=${daemonOutput.slice(-8).join(" | ")}`,
      );
    });
    if (bIntent?.invocationId === undefined || bIntent.callRef === undefined) {
      throw new Error("AH7 B P4 intent probe omitted its identity");
    }
    expect(bIntent.callRef).toMatch(/^call_/u);
    expect(bIntent.callRef).toBe(expectedBCallRef);
    expect(bIntent.callRef).not.toBe(actionACallRef);
    expect(bIntent.invocationId).toMatch(/^tin_/u);

    // The ToolRuntime probe fires synchronously after recordIntent commits and
    // before it opens the sandbox handle or invokes the patch executor. These
    // durable facts plus the absent B file identify the pre-effect side without
    // a timing delay.
    const beforeBEffect = durableSnapshot(fixture.databaseFile);
    expect(beforeBEffect.steps).toEqual([
      expect.objectContaining({
        execution_id: executionId,
        logical_step_no: 0,
        provider_turn_id: providerTurnId,
        state: "ActionsInProgress",
        next_action_index: 1,
        decoded_output_hash: originalStep.decoded_output_hash,
      }),
    ]);
    const originalTurnBeforeBEffect = readPinnedProviderTurn(
      fixture.databaseFile,
      providerTurnId,
    );
    expect(originalTurnBeforeBEffect.modelOutputs).toHaveLength(1);
    expect(
      originalTurnBeforeBEffect.calls.map((call) => call.callRef).sort(),
    ).toEqual([actionACallRef, expectedBCallRef].sort());
    expect(beforeBEffect.actions).toHaveLength(2);
    expect(beforeBEffect.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execution_id: executionId,
          action_index: 0,
          call_ref: actionACallRef,
          action_kind: "patch",
          state: "Applied",
        }),
        expect.objectContaining({
          execution_id: executionId,
          action_index: 1,
          call_ref: bIntent.callRef,
          action_kind: "patch",
          state: "Pending",
          observation_source_ref: null,
        }),
      ]),
    );
    expect(beforeBEffect.toolInvocations).toHaveLength(2);
    expect(beforeBEffect.toolInvocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          execution_id: executionId,
          tool_name: "patch",
          side_effect_semantics: "Idempotent",
          settlement_kind: "Success",
          settled_at: expect.any(String),
        }),
        expect.objectContaining({
          invocation_id: bIntent.invocationId,
          execution_id: executionId,
          tool_name: "patch",
          side_effect_semantics: "Idempotent",
          settlement_kind: null,
          settled_at: null,
        }),
      ]),
    );
    expect(beforeBEffect.toolResults).toHaveLength(1);
    expect(beforeBEffect.artifacts).toHaveLength(1);
    const beforeBObservations = readActionObservations(fixture.databaseFile);
    expect(beforeBObservations).toHaveLength(1);
    expect(
      (
        JSON.parse(beforeBObservations[0]?.payload_json ?? "{}") as {
          callRef?: string;
        }
      ).callRef,
    ).toBe(actionACallRef);
    expect(readFileSync(join(fixture.workspaceDirectory, fileA), "utf8")).toBe(
      valueA,
    );
    expect(() =>
      readFileSync(join(fixture.workspaceDirectory, fileB), "utf8"),
    ).toThrow();
    expect(targetProviderCalls).toBe(1);
    expect(providerActionBatches).toBe(1);
    expect(fixture.providerCalls).toHaveLength(1);

    await fixture.crash();
    const afterOldKill = durableSnapshot(fixture.databaseFile);
    expect(afterOldKill.toolInvocations).toHaveLength(2);
    expect(afterOldKill.toolInvocations).toContainEqual(
      expect.objectContaining({
        invocation_id: bIntent.invocationId,
        execution_id: executionId,
        settlement_kind: null,
      }),
    );
    expect(() =>
      readFileSync(join(fixture.workspaceDirectory, fileB), "utf8"),
    ).toThrow();

    await fixture.restart();
    await waitForPublic(
      async () => durableSnapshot(fixture.databaseFile),
      (snapshot) =>
        snapshot.actions.some(
          (action) =>
            action.execution_id === executionId &&
            action.action_index === 1 &&
            action.call_ref === bIntent.callRef &&
            action.state === "Applied",
        ) &&
        snapshot.toolInvocations.some(
          (invocation) =>
            invocation.invocation_id === bIntent.invocationId &&
            invocation.settlement_kind === "Success",
        ) &&
        snapshot.steps.some(
          (step) =>
            step.execution_id === executionId &&
            step.logical_step_no === 0 &&
            step.provider_turn_id === providerTurnId &&
            step.next_action_index === 2,
        ),
      45_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH7 B intent recovery absent: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(durableSnapshot(fixture.databaseFile))}; daemon=${fixture.daemonErrors.join(" | ")}; output=${daemonOutput.slice(-8).join(" | ")}`,
      );
    });
    await waitForPublic(
      async () => ({
        execution: durableSnapshot(fixture.databaseFile).executions.find(
          (candidate) => candidate.execution_id === executionId,
        ),
        workWait: readWorkWait(fixture.databaseFile, workId),
      }),
      ({ execution, workWait }) =>
        execution?.settlement_kind === "Completed" && workWait !== undefined,
      30_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH7 successor Wait did not settle the WorkEpisode: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(durableSnapshot(fixture.databaseFile))}; workWait=${JSON.stringify(readWorkWait(fixture.databaseFile, workId))}; providerCalls=${JSON.stringify(fixture.providerCalls.slice(-3))}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    const recovered = durableSnapshot(fixture.databaseFile);

    const actions = recovered.actions.filter(
      (action) =>
        action.execution_id === executionId &&
        action.logical_step_no === 0 &&
        action.repair_attempt === 0,
    );
    expect(actions).toHaveLength(2);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_index: 0,
          call_ref: actionACallRef,
          state: "Applied",
        }),
        expect.objectContaining({
          action_index: 1,
          call_ref: bIntent.callRef,
          state: "Applied",
          observation_source_ref: expect.stringMatching(/^observation_/u),
        }),
      ]),
    );
    const step = recovered.steps.find(
      (candidate) =>
        candidate.execution_id === executionId &&
        candidate.logical_step_no === 0 &&
        candidate.provider_turn_id === providerTurnId,
    );
    expect(step).toMatchObject({
      next_action_index: 2,
      provider_turn_id: providerTurnId,
      decoded_output_hash: originalStep.decoded_output_hash,
    });
    const originalTurnAfterRecovery = readPinnedProviderTurn(
      fixture.databaseFile,
      providerTurnId,
    );
    expect(originalTurnAfterRecovery.modelOutputs).toHaveLength(1);
    expect(
      originalTurnAfterRecovery.calls.map((call) => call.callRef).sort(),
    ).toEqual([actionACallRef, expectedBCallRef].sort());
    expect(["StepEffectsCommitted", "NextStepReady"]).toContain(step?.state);
    const successorStep = recovered.steps.find(
      (candidate) =>
        candidate.execution_id === executionId &&
        candidate.logical_step_no !== null &&
        candidate.logical_step_no !== undefined &&
        Number(candidate.logical_step_no) > 0,
    );
    expect(successorStep).toBeDefined();
    expect(successorStep?.provider_turn_id).not.toBe(providerTurnId);
    const execution = recovered.executions.find(
      (candidate) => candidate.execution_id === executionId,
    );
    expect(execution?.settlement_kind).toBe("Completed");
    const wait = readWorkWait(fixture.databaseFile, workId);
    expect(wait).toMatchObject({ work_id: workId, wait_mode: "Any" });
    expect(JSON.parse(wait?.conditions_json ?? "[]")).toEqual([
      { _tag: "Manual" },
    ]);
    const invocations = recovered.toolInvocations.filter(
      (invocation) => invocation.execution_id === executionId,
    );
    expect(invocations).toHaveLength(2);
    expect(
      invocations.filter(
        (invocation) => invocation.invocation_id === bIntent.invocationId,
      ),
    ).toEqual([
      expect.objectContaining({
        side_effect_semantics: "Idempotent",
        settlement_kind: "Success",
        settled_at: expect.any(String),
      }),
    ]);
    expect(recovered.toolResults).toHaveLength(2);
    const results = recovered.toolResults.map((entry) =>
      toolResultPayload(entry.payload_json),
    );
    expect(results.map((result) => result.callRef).sort()).toEqual(
      [actionACallRef, bIntent.callRef].sort(),
    );
    expect(
      results.filter((result) => result.invocationId === bIntent.invocationId),
    ).toHaveLength(1);
    expect(recovered.artifacts).toHaveLength(2);
    expect(
      recovered.artifacts.filter(
        (artifact) => artifact.invocation_id === bIntent.invocationId,
      ),
    ).toHaveLength(1);
    const observations = readActionObservations(fixture.databaseFile);
    const pinnedActionObservations = observations
      .map(
        (observation) =>
          JSON.parse(observation.payload_json) as { callRef?: string },
      )
      .filter((observation) =>
        [actionACallRef, bIntent.callRef].includes(observation.callRef ?? ""),
      );
    expect(pinnedActionObservations).toHaveLength(2);
    expect(
      pinnedActionObservations.map((observation) => observation.callRef).sort(),
    ).toEqual([actionACallRef, bIntent.callRef].sort());
    expect(readFileSync(join(fixture.workspaceDirectory, fileA), "utf8")).toBe(
      valueA,
    );
    expect(readFileSync(join(fixture.workspaceDirectory, fileB), "utf8")).toBe(
      valueB,
    );
    expect(
      (
        readFileSync(join(fixture.workspaceDirectory, fileB), "utf8").match(
          new RegExp(valueB, "gu"),
        ) ?? []
      ).length,
    ).toBe(1);
    expect(
      recovered.attempts.filter(
        (attempt) => attempt.provider_turn_id === providerTurnId,
      ),
    ).toHaveLength(1);
    expect(providerActionBatches).toBe(1);
    expect(successorWaitCalls).toBe(1);
    expect(fixture.daemonErrors).toEqual([]);
    await fixture.crash();
  }, 120_000);
});
