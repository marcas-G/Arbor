import { resolve } from "node:path";
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
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];
const crashChild = resolve("tests/functional/support/ah-crash-child.mjs");
const ah8Boundary = "AH7AfterActionResultCommit";

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("AH8 action A commit followed by stale action B", () => {
  it("keeps A applied and skips B after public SteerWork changes ControlBasis across restart", async () => {
    const marker = `AH8-${crypto.randomUUID().slice(0, 8)}`;
    const hits: AhProbeHit[] = [];
    const daemonOutput: string[] = [];
    let targetProviderCalls = 0;
    let seedWorkProviderCalls = 0;
    let probeArmed = false;
    let batchSent = false;
    const fixture = await startProductionFixture({
      reply: (call) => {
        const context = JSON.stringify(call.messages);
        const available = new Set(
          call.tools
            .map((tool) => tool.function?.name)
            .filter((name): name is string => name !== undefined),
        );
        if (
          available.has("assign_work") &&
          !available.has("update_plan") &&
          context.includes(marker)
        ) {
          return context.includes("WorkAssigned(")
            ? { _tag: "Text", text: `Work admitted for ${marker}` }
            : {
                _tag: "ToolCall",
                name: "assign_work",
                arguments: {
                  objective: `Exercise AH8 action recovery ${marker}.`,
                  why: "qualify action A commit followed by stale action B",
                  constraints: [],
                  completionExpectation:
                    "action A is committed and stale B is skipped",
                  verificationMission: {
                    goal: `Verify AH8 ${marker}`,
                    criteria: [
                      {
                        criterionId: "ah8-stale-b",
                        requirement:
                          "the stale action does not create another Work",
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  },
                  reason: "AH8 stale-basis qualification",
                },
              };
        }
        if (available.has("update_plan") && context.includes(marker)) {
          if (!probeArmed) {
            seedWorkProviderCalls += 1;
            return {
              _tag: "ToolCall",
              name: "wait",
              arguments: {
                reason: `AH8 setup waits for probe ${marker}`,
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
          if (!batchSent) {
            batchSent = true;
            if (
              !available.has("update_plan") ||
              !available.has("assign_work")
            ) {
              return { _tag: "HttpError", status: 422 };
            }
            return {
              _tag: "ToolCalls",
              calls: [
                {
                  name: "update_plan",
                  arguments: {
                    items: [
                      {
                        itemId: "ah8-action-a",
                        text: `Action A committed for ${marker}`,
                        status: "InProgress",
                      },
                    ],
                  },
                },
                {
                  name: "assign_work",
                  arguments: {
                    objective: `This must be skipped as stale: ${marker}`,
                    why: "AH8 second action after the basis changes",
                    constraints: [],
                    completionExpectation:
                      "the stale action must not create Work",
                    verificationMission: {
                      goal: `Verify AH8 ${marker}`,
                      criteria: [
                        {
                          criterionId: "ah8-stale-action",
                          requirement: "the stale second action was skipped",
                          required: true,
                        },
                      ],
                      riskRequirements: [],
                    },
                    reason: "AH8 stale-basis qualification",
                  },
                },
              ],
            };
          }
          return {
            _tag: "ToolCall",
            name: "wait",
            arguments: {
              reason: `AH8 stale action qualified for ${marker}`,
              waitSpec: {
                mode: "Any",
                conditions: [{ _tag: "Manual" }],
              },
            },
          };
        }
        return {
          _tag: "ToolCall",
          name: "wait",
          arguments: {
            reason: `AH8 stale action qualified for ${marker}`,
            waitSpec: {
              mode: "Any",
              conditions: [{ _tag: "Manual" }],
            },
          },
        };
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
      "AH8 stale second action",
    );
    await submitHumanMessage(
      client,
      project,
      `请创建工作目标 Exercise AH8 action recovery ${marker}.`,
    );
    const approval = await waitForApproval(client, project, marker);
    expect(
      await client.view("current-work", {
        workspaceId: project.rootWorkspaceId,
      }),
    ).toBeNull();
    await client.command(project.projectId, "ResolveControlApproval", {
      approvalId: approval.approvalId,
      expectedRevision: approval.revision,
      decision: "Approve",
      reason: "AH8 public Work admission",
    });
    const currentWork = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
        } | null>("current-work", {
          workspaceId: project.rootWorkspaceId,
        }),
      (work) => work?.workId !== undefined,
    );
    const workId = currentWork?.workId;
    if (workId === undefined) throw new Error("AH8 public Work absent");
    expect(currentWork).toMatchObject({ revision: 0, status: "Open" });
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

    // The seed ProviderTurn only enters a safe Manual wait. Install the AH8
    // probe before a new public SteerWork resumes the measured A/B batch.
    await fixture.crash();
    probeArmed = true;
    const targetProviderCallStart = fixture.providerCalls.length;
    await fixture.restart({
      entry: crashChild,
      daemonEnvironment: { ARBOR_AH_BOUNDARY: ah8Boundary },
    });
    await client.command(project.projectId, "SteerWork", {
      workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: 0,
      steer: { severity: "Normal", guidance: `AH8 probe armed ${marker}` },
      provenance: { source: "HumanInput" },
    });

    const atActionACommit = await waitForPublic(
      async () => ({ hits, targetProviderCalls }),
      (value) =>
        value.hits.some(
          (hit) =>
            hit.boundary === ah8Boundary &&
            hit.actionIndex === 0 &&
            hit.callRef !== undefined,
        ) || value.targetProviderCalls >= 5,
      30_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH8 A-result probe absent: ${error instanceof Error ? error.message : String(error)}; targetProviderCalls=${targetProviderCalls}; tools=${JSON.stringify(fixture.providerCalls[0]?.tools.map((tool) => tool.function?.name))}; daemon=${fixture.daemonErrors.join(" | ")}; output=${daemonOutput.slice(-8).join(" | ")}`,
      );
    });
    const hit = atActionACommit.hits.find(
      (candidate) =>
        candidate.boundary === ah8Boundary &&
        candidate.actionIndex === 0 &&
        candidate.callRef !== undefined,
    );
    if (hit === undefined) {
      await fixture.crash();
      throw new Error(
        `AH8 provider-call cap reached before action A commit; calls=${JSON.stringify(fixture.providerCalls.slice(-2))}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    }
    expect(batchSent).toBe(true);
    expect(hit.providerTurnId).toMatch(/^ptn_/u);
    expect(hit.executionId).toMatch(/^exe_/u);
    expect(seedExecutionIds.has(hit.executionId)).toBe(false);

    const actionACommitted = durableSnapshot(fixture.databaseFile);
    expect(
      actionACommitted.steps.filter(
        (step) => step.execution_id === hit.executionId,
      ),
    ).toEqual([
      expect.objectContaining({
        execution_id: hit.executionId,
        logical_step_no: 0,
        provider_turn_id: hit.providerTurnId,
        state: "ActionsInProgress",
        next_action_index: 1,
      }),
    ]);
    expect(
      actionACommitted.actions.filter(
        (action) => action.execution_id === hit.executionId,
      ),
    ).toEqual([
      expect.objectContaining({
        execution_id: hit.executionId,
        logical_step_no: 0,
        action_index: 0,
        call_ref: hit.callRef,
        action_kind: "update_plan",
        state: "Applied",
      }),
    ]);
    expect(actionACommitted.works).toHaveLength(1);

    // The AH probe parks the execution after A is durable while the daemon's
    // public command endpoint remains available. SteerWork changes the trusted
    // Work revision before killing this process and recovering the pinned turn.
    await client.command(project.projectId, "SteerWork", {
      workId,
      workspaceId: project.rootWorkspaceId,
      expectedWorkRevision: 1,
      steer: { severity: "Normal", guidance: `basis changed ${marker}` },
      provenance: { source: "HumanInput" },
    });
    const steered = await waitForPublic(
      () =>
        client.view<{
          workId?: string;
          revision: number;
          status: string;
        } | null>("current-work", { workspaceId: project.rootWorkspaceId }),
      (work) => work?.workId === workId && work.revision === 2,
      10_000,
    );
    expect(steered?.status).toBe("Open");

    await fixture.crash();
    await fixture.restart();

    let recovered: ReturnType<typeof durableSnapshot>;
    try {
      recovered = await waitForPublic(
        async () => durableSnapshot(fixture.databaseFile),
        (snapshot) =>
          snapshot.steps.some(
            (step) =>
              step.execution_id === hit.executionId &&
              step.logical_step_no === 0 &&
              step.state === "NextStepReady",
          ) &&
          snapshot.actions.some(
            (action) =>
              action.execution_id === hit.executionId &&
              action.action_index === 1 &&
              action.state === "SkippedStale",
          ) &&
          snapshot.steps.some(
            (step) =>
              step.execution_id === hit.executionId &&
              step.logical_step_no === 1,
          ),
        45_000,
      );
    } catch (error) {
      throw new Error(
        `AH8 recovery did not persist stale B/successor: ${error instanceof Error ? error.message : String(error)}; targetProviderCalls=${targetProviderCalls}; calls=${JSON.stringify(fixture.providerCalls.slice(-3))}; snapshot=${JSON.stringify(durableSnapshot(fixture.databaseFile))}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    }

    const originalStep = recovered.steps.find(
      (step) =>
        step.execution_id === hit.executionId && step.logical_step_no === 0,
    );
    expect(originalStep).toMatchObject({
      state: "NextStepReady",
      next_action_index: 2,
      next_step_reason: "DecisionStale",
      successor_json: expect.stringContaining("logicalStepNo"),
    });
    const successorRows = recovered.steps.filter(
      (step) =>
        step.execution_id === hit.executionId && step.logical_step_no === 1,
    );
    expect(successorRows).toHaveLength(1);
    expect(successorRows[0]).toMatchObject({
      logical_step_no: 1,
      repair_attempt: 0,
    });
    expect(["Prepared", "SettlementProposed"]).toContain(
      successorRows[0]?.state,
    );
    expect(
      recovered.actions.filter(
        (action) =>
          action.execution_id === hit.executionId &&
          action.logical_step_no === 0,
      ),
    ).toEqual([
      expect.objectContaining({
        action_index: 0,
        call_ref: hit.callRef,
        action_kind: "update_plan",
        state: "Applied",
      }),
      expect.objectContaining({
        action_index: 1,
        call_ref: expect.stringMatching(/^call_/u),
        action_kind: "assign_work",
        state: "SkippedStale",
        disposition_json: expect.stringContaining("DecisionStale"),
      }),
    ]);
    expect(recovered.works).toHaveLength(1);
    expect(recovered.works).toEqual([
      expect.objectContaining({ work_id: workId, revision: 2 }),
    ]);
    expect(
      fixture.providerCalls
        .slice(targetProviderCallStart)
        .filter(
          (call) =>
            call.tools.some((tool) => tool.function?.name === "update_plan") &&
            JSON.stringify(call.messages).includes(marker),
        ).length,
    ).toBeLessThanOrEqual(3);
    expect(fixture.daemonErrors).toEqual([]);
  }, 90_000);
});
