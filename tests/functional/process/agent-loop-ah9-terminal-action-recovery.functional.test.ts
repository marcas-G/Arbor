import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
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
const boundaries = [
  "AH9BeforeTerminalActionCommit",
  "AH9AfterTerminalActionCommit",
] as const;

type Snapshot = ReturnType<typeof durableSnapshot>;

const durableSnapshot = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      executions: db
        .prepare(
          "SELECT execution_id, settled_at, settlement_kind FROM executions",
        )
        .all(),
      steps: db
        .prepare(
          "SELECT execution_id, logical_step_no, state, next_action_index, settlement_json FROM agent_loop_steps ORDER BY logical_step_no",
        )
        .all(),
      actions: db
        .prepare(
          "SELECT execution_id, logical_step_no, action_index, logical_action_id, call_ref, action_kind, state, settlement_ref, disposition_json FROM agent_loop_step_actions ORDER BY logical_step_no, action_index",
        )
        .all(),
      toolInvocations: db
        .prepare(
          "SELECT invocation_id, execution_id, tool_name, settled_at FROM tool_invocations ORDER BY invocation_id",
        )
        .all(),
      controlResults: db
        .prepare(
          "SELECT payload_json FROM session_entries WHERE item_type = 'ControlResult' ORDER BY sequence",
        )
        .all(),
      works: db
        .prepare(
          "SELECT work_id, workspace_id, lifecycle, revision FROM works ORDER BY work_id",
        )
        .all(),
      workWaits: db
        .prepare("SELECT work_id, wait_mode, conditions_json FROM work_waits")
        .all(),
      events: db
        .prepare("SELECT event_type, aggregate_ref FROM domain_events")
        .all(),
    };
  } finally {
    db.close();
  }
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("AH9 terminal action and early-skip transaction", () => {
  it.each(boundaries)(
    "%s recovers one terminal action with later calls marked SkippedEarlySettlement",
    async (boundary) => {
      const marker = `AH9-${crypto.randomUUID().slice(0, 8)}`;
      const hits: AhProbeHit[] = [];
      const daemonOutput: string[] = [];
      let probeArmed = false;
      let seedWorkProviderCalls = 0;
      let targetProviderCalls = 0;
      let actionBatchSent = false;
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
            !available.has("wait")
          ) {
            return context.includes("WorkAssigned(")
              ? { _tag: "Text", text: `Work admitted for ${marker}` }
              : {
                  _tag: "ToolCall",
                  name: "assign_work",
                  arguments: {
                    objective: `Exercise AH9 terminal handoff ${marker}.`,
                    why: "qualify action settlement and early skip recovery",
                    constraints: [],
                    completionExpectation: "later calls are skipped after Wait",
                    verificationMission: {
                      goal: `Verify AH9 ${marker}`,
                      criteria: [
                        {
                          criterionId: "ah9-terminal-step",
                          requirement:
                            "Wait settles the execution before later calls",
                          required: true,
                        },
                      ],
                      riskRequirements: [],
                    },
                    reason: "AH9 process test",
                  },
                };
          }
          if (
            context.includes(marker) &&
            available.has("wait") &&
            available.has("assign_work")
          ) {
            if (!probeArmed) {
              seedWorkProviderCalls += 1;
              return {
                _tag: "ToolCall",
                name: "wait",
                arguments: {
                  reason: `AH9 setup waits for probe ${marker}`,
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
            if (actionBatchSent) {
              return { _tag: "HttpError", status: 429 };
            }
            actionBatchSent = true;
            return {
              _tag: "ToolCalls",
              calls: [
                {
                  name: "wait",
                  arguments: {
                    reason: `settle AH9 ${marker}`,
                    waitSpec: {
                      mode: "Any",
                      conditions: [{ _tag: "Manual" }],
                    },
                  },
                },
                {
                  name: "assign_work",
                  arguments: {
                    objective: `Must be skipped after terminal action ${marker}`,
                    why: "AH9 early-settlement qualification",
                    constraints: [],
                    completionExpectation: "the later call is not applied",
                    verificationMission: {
                      goal: `Verify AH9 ${marker}`,
                      criteria: [
                        {
                          criterionId: "ah9-no-later-work",
                          requirement: "no Work is created by the skipped call",
                          required: true,
                        },
                      ],
                      riskRequirements: [],
                    },
                    reason: "AH9 second action should be skipped",
                  },
                },
              ],
            };
          }
          return { _tag: "Text", text: `Waiting for AH9 ${marker}` };
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
        `AH9 terminal settlement ${marker}`,
      );
      await submitHumanMessage(
        client,
        project,
        `请创建并执行 AH9 终端动作恢复目标 ${marker}`,
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
        reason: "AH9 public Work admission",
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
      if (workId === undefined) throw new Error("AH9 public Work absent");
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

      // The seed Work only enters a legal Manual wait. Install the terminal
      // action crash probe before public SteerWork starts the measured turn.
      await fixture.crash();
      probeArmed = true;
      await fixture.restart({
        entry: crashChild,
        daemonEnvironment: { ARBOR_AH_BOUNDARY: boundary },
      });
      await client.command(project.projectId, "SteerWork", {
        workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: 0,
        steer: {
          severity: "Normal",
          guidance: `AH9 terminal probe ${marker}`,
        },
        provenance: { source: "HumanInput" },
      });

      const atBoundary = await waitForPublic(
        async () => ({ hits, targetProviderCalls }),
        (value) =>
          value.hits.some((hit) => hit.boundary === boundary) ||
          value.targetProviderCalls >= 5,
        30_000,
      ).catch((error: unknown) => {
        throw new Error(
          `AH9 terminal probe absent at ${boundary}: ${error instanceof Error ? error.message : String(error)}; targetProviderCalls=${targetProviderCalls}; visibleTools=${JSON.stringify(fixture.providerCalls[0]?.tools.map((tool) => tool.function?.name))}; daemon=${fixture.daemonErrors.join(" | ")}; output=${daemonOutput.slice(-8).join(" | ")}`,
        );
      });
      const hit = atBoundary.hits.find(
        (candidate) => candidate.boundary === boundary,
      );
      if (hit === undefined) {
        await fixture.crash();
        throw new Error(
          `AH9 provider-call cap reached before ${boundary}; calls=${JSON.stringify(fixture.providerCalls.slice(-2))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      }
      expect(hit.providerTurnId).toMatch(/^ptn_/u);
      expect(hit.executionId).toMatch(/^exe_/u);
      expect(hit.actionIndex).toBe(0);
      expect(hit.callRef).toMatch(/^call_/u);
      expect(actionBatchSent).toBe(true);
      expect(seedExecutionIds.has(hit.executionId)).toBe(false);

      await fixture.crash();
      const killed = durableSnapshot(fixture.databaseFile);
      const killedTargetControlResults = killed.controlResults.filter(
        (result) =>
          JSON.stringify(result).includes(`observation_${hit.executionId}_`),
      );
      const killedTargetInvocations = killed.toolInvocations.filter(
        (invocation) => invocation.execution_id === hit.executionId,
      );
      expect(killedTargetInvocations).toEqual([]);
      if (boundary === "AH9BeforeTerminalActionCommit") {
        expect(
          killed.steps.filter((step) => step.execution_id === hit.executionId),
        ).toEqual([
          expect.objectContaining({
            execution_id: hit.executionId,
            logical_step_no: 0,
            state: "ActionsInProgress",
            next_action_index: 0,
            settlement_json: null,
          }),
        ]);
        expect(
          killed.actions.filter(
            (action) => action.execution_id === hit.executionId,
          ),
        ).toEqual([
          expect.objectContaining({
            action_index: 0,
            call_ref: hit.callRef,
            action_kind: "wait",
            state: "Pending",
          }),
        ]);
        expect(
          killed.executions.filter(
            (execution) => execution.execution_id === hit.executionId,
          ),
        ).toEqual([expect.objectContaining({ settled_at: null })]);
        expect(killedTargetControlResults).toEqual([]);
      } else {
        expect(
          killed.steps.filter((step) => step.execution_id === hit.executionId),
        ).toEqual([
          expect.objectContaining({
            execution_id: hit.executionId,
            logical_step_no: 0,
            state: "SettlementProposed",
            next_action_index: 2,
            settlement_json: expect.stringContaining("Yielded"),
          }),
        ]);
        expect(
          killed.actions.filter(
            (action) => action.execution_id === hit.executionId,
          ),
        ).toEqual([
          expect.objectContaining({
            action_index: 0,
            call_ref: hit.callRef,
            action_kind: "wait",
            state: "Applied",
            settlement_ref: expect.stringMatching(/^settlement_/u),
          }),
          expect.objectContaining({
            action_index: 1,
            action_kind: "assign_work",
            state: "SkippedEarlySettlement",
            disposition_json: expect.stringContaining("SkippedEarlySettlement"),
          }),
        ]);
        expect(killedTargetControlResults).toHaveLength(2);
        expect(
          killed.executions.filter(
            (execution) => execution.execution_id === hit.executionId,
          ),
        ).toEqual([expect.objectContaining({ settled_at: null })]);
      }

      await fixture.restart();
      let recovered: Snapshot;
      try {
        recovered = await waitForPublic(
          async () => durableSnapshot(fixture.databaseFile),
          (snapshot) =>
            snapshot.executions.some(
              (execution) =>
                execution.execution_id === hit.executionId &&
                execution.settled_at !== null,
            ) &&
            snapshot.steps.some(
              (step) =>
                step.execution_id === hit.executionId &&
                step.logical_step_no === 0 &&
                step.state === "SettlementProposed",
            ) &&
            snapshot.actions.some(
              (action) =>
                action.execution_id === hit.executionId &&
                action.action_index === 1 &&
                action.state === "SkippedEarlySettlement",
            ),
          45_000,
        );
      } catch (error) {
        throw new Error(
          `AH9 restart failed to recover terminal proposal from ${boundary}: ${error instanceof Error ? error.message : String(error)}; providerCalls=${fixture.providerCalls.length}; targetProviderCalls=${targetProviderCalls}; snapshot=${JSON.stringify(durableSnapshot(fixture.databaseFile))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      }

      expect(
        recovered.executions.filter(
          (execution) => execution.execution_id === hit.executionId,
        ),
      ).toEqual([
        expect.objectContaining({
          execution_id: hit.executionId,
          settled_at: expect.any(String),
          settlement_kind: "Completed",
        }),
      ]);
      expect(
        recovered.steps.filter((step) => step.execution_id === hit.executionId),
      ).toEqual([
        expect.objectContaining({
          execution_id: hit.executionId,
          logical_step_no: 0,
          state: "SettlementProposed",
          next_action_index: 2,
          settlement_json: expect.stringContaining("Yielded"),
        }),
      ]);
      expect(
        recovered.actions.filter(
          (action) => action.execution_id === hit.executionId,
        ),
      ).toEqual([
        expect.objectContaining({
          action_index: 0,
          call_ref: hit.callRef,
          action_kind: "wait",
          state: "Applied",
          settlement_ref: expect.stringMatching(/^settlement_/u),
        }),
        expect.objectContaining({
          action_index: 1,
          action_kind: "assign_work",
          state: "SkippedEarlySettlement",
          disposition_json: expect.stringContaining("SkippedEarlySettlement"),
        }),
      ]);
      expect(
        recovered.toolInvocations.filter(
          (invocation) => invocation.execution_id === hit.executionId,
        ),
      ).toEqual([]);
      expect(
        recovered.controlResults.filter((result) =>
          JSON.stringify(result).includes(`observation_${hit.executionId}_`),
        ),
      ).toHaveLength(2);
      expect(recovered.workWaits).toEqual([
        expect.objectContaining({ work_id: workId }),
      ]);
      expect(recovered.works).toEqual([
        expect.objectContaining({ work_id: workId, revision: 1 }),
      ]);
      expect(
        recovered.events.filter((event) => event.event_type === "WorkAssigned"),
      ).toHaveLength(1);
      expect(targetProviderCalls).toBe(1);
      expect(fixture.daemonErrors).toEqual([]);
    },
  );
});
