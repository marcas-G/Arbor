import { resolve } from "node:path";
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
  admitRootWorkThroughPublicConversation,
  createFunctionalProject,
  makePublicClient,
  waitForPublic,
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];
const crashChild = resolve("tests/functional/support/ah-crash-child.mjs");
const boundaries = [
  "AH12BeforeSettleGatewaySubmission",
  "AH12BeforeSettleExecutionCommit",
  "AH12AfterSettleCommandCommit",
] as const;

const settlementReceipts = (databaseFile: string, executionId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT command_id, resolution, result_json, terminal_error_json FROM commands WHERE command_id LIKE ? ORDER BY command_id",
      )
      .all(`cmd_settle_${executionId}_%`);
  } finally {
    db.close();
  }
};

const commandAttempts = (databaseFile: string, commandId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT command_id, attempt_no, outcome FROM command_attempts WHERE command_id = ? ORDER BY attempt_no",
      )
      .all(commandId);
  } finally {
    db.close();
  }
};

const verificationSnapshot = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      verifications: db
        .prepare(
          "SELECT verification_id, work_id, target_work_revision, state, verdict, verification_execution_ids FROM verifications ORDER BY verification_id",
        )
        .all(),
      verificationExecutions: db
        .prepare(
          "SELECT verification_id, execution_id FROM verification_executions ORDER BY verification_id, execution_id",
        )
        .all(),
      executionEpisodes: db
        .prepare(
          "SELECT execution_id, episode_kind, episode_ref, episode_revision, settled_at FROM executions ORDER BY execution_id",
        )
        .all(),
      startVerificationReceipts: db
        .prepare(
          "SELECT command_id, resolution, result_json FROM commands WHERE json_extract(result_json, '$.verificationId') IS NOT NULL ORDER BY command_id",
        )
        .all(),
      executionSettledEvents: db
        .prepare(
          "SELECT event_id, payload_json FROM domain_events WHERE event_type = 'ExecutionSettled' ORDER BY event_id",
        )
        .all() as Array<{ event_id: string; payload_json: string }>,
      workLifecycle: db
        .prepare(
          "SELECT work_id, lifecycle, revision FROM works ORDER BY work_id",
        )
        .all(),
    };
  } finally {
    db.close();
  }
};

const settledEventsForExecution = (
  events: Array<{ event_id: string; payload_json: string }>,
  executionId: string,
) =>
  events.filter((event) => {
    const payload = JSON.parse(event.payload_json) as { executionId?: string };
    return payload.executionId === executionId;
  });

/** One SQLite read snapshot for the recovered cross-table invariants. */
const recoverySnapshot = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  db.exec("BEGIN");
  try {
    const snapshot = {
      executions: db
        .prepare(
          "SELECT execution_id, episode_kind, episode_ref, episode_revision, settled_at, settlement_kind, settlement_json FROM executions ORDER BY execution_id",
        )
        .all(),
      steps: db
        .prepare(
          "SELECT execution_id, logical_step_no, provider_turn_id, repair_attempt, state, revision, next_action_index, successor_json, next_step_reason, decoder_version, decoded_output_hash, model_output_session_sequence FROM agent_loop_steps ORDER BY execution_id, logical_step_no, repair_attempt",
        )
        .all(),
      actions: db
        .prepare(
          "SELECT execution_id, logical_step_no, repair_attempt, action_index, logical_action_id, call_ref, route_kind, action_kind, input_hash, state, result_ref, disposition_json, observation_source_ref, revision FROM agent_loop_step_actions ORDER BY execution_id, logical_step_no, repair_attempt, action_index",
        )
        .all(),
      works: db
        .prepare(
          "SELECT work_id, workspace_id, lifecycle, revision FROM works ORDER BY work_id",
        )
        .all(),
      verifications: db
        .prepare(
          "SELECT verification_id, work_id, target_work_revision, state, verdict, verification_execution_ids FROM verifications ORDER BY verification_id",
        )
        .all(),
      verificationExecutions: db
        .prepare(
          "SELECT verification_id, execution_id FROM verification_executions ORDER BY verification_id, execution_id",
        )
        .all(),
      startVerificationReceipts: db
        .prepare(
          "SELECT command_id, resolution, result_json FROM commands WHERE json_extract(result_json, '$.verificationId') IS NOT NULL ORDER BY command_id",
        )
        .all(),
      settlementReceipts: db
        .prepare(
          "SELECT command_id, resolution, result_json FROM commands WHERE command_id LIKE 'cmd_settle_%' ORDER BY command_id",
        )
        .all(),
      executionSettledEvents: db
        .prepare(
          "SELECT event_id, aggregate_ref, payload_json FROM domain_events WHERE event_type = 'ExecutionSettled' ORDER BY event_id",
        )
        .all() as Array<{
        event_id: string;
        aggregate_ref: string;
        payload_json: string;
      }>,
    };
    db.exec("COMMIT");
    return snapshot;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
};

const proposedStepSettlement = (databaseFile: string, executionId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT settlement_json FROM agent_loop_steps WHERE execution_id = ? ORDER BY logical_step_no DESC, repair_attempt DESC LIMIT 1",
      )
      .get(executionId) as { settlement_json: string | null } | undefined;
  } finally {
    db.close();
  }
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("AH12 CompletionClaimed settlement to Verification recovery", () => {
  it.each(boundaries)(
    "%s settles once after hard restart",
    async (boundary) => {
      const marker = `AH12-${crypto.randomUUID().slice(0, 8)}`;
      const hits: AhProbeHit[] = [];
      const daemonOutput: string[] = [];
      let probeArmed = false;
      let seedWaitIssued = false;
      let targetProviderCalls = 0;
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
            !available.has("claim_completion")
          ) {
            return context.includes("WorkAssigned(")
              ? { _tag: "Text", text: `Work admitted for ${marker}.` }
              : {
                  _tag: "ToolCall",
                  name: "assign_work",
                  arguments: {
                    objective: `Complete this bounded qualification Work ${marker}.`,
                    why: "qualify CompletionClaimed verification startup recovery",
                    constraints: [],
                    completionExpectation:
                      "the Work completion claim is recorded for verification",
                    verificationMission: {
                      goal: `Verify AH12 ${marker}`,
                      criteria: [
                        {
                          criterionId: "ah12-completion",
                          requirement:
                            "the exact Work revision completion claim is independently verified",
                          required: true,
                        },
                      ],
                      riskRequirements: [],
                    },
                    reason: "AH12 process test",
                  },
                };
          }
          if (context.includes(marker) && available.has("claim_completion")) {
            if (!probeArmed) {
              seedWaitIssued = true;
              return {
                _tag: "ToolCall",
                name: "wait",
                arguments: {
                  reason: `AH12 setup waits for settlement probe ${marker}`,
                  waitSpec: {
                    mode: "Any",
                    conditions: [{ _tag: "Manual" }],
                  },
                },
              };
            }
            targetProviderCalls += 1;
            if (targetProviderCalls > 1) {
              return { _tag: "HttpError", status: 429 };
            }
          }
          const completionTool = call.tools.find(
            (tool) => tool.function?.name === "claim_completion",
          );
          if (completionTool !== undefined) {
            return {
              _tag: "ToolCall",
              name: "claim_completion",
              arguments: {
                claim: `AH12 completed Work ${marker}; completion expectation is satisfied.`,
              },
            };
          }
          if (
            call.tools.some(
              (tool) => tool.function?.name === "conclude_verification",
            )
          ) {
            return {
              _tag: "Text",
              text: `AH12 verifier startup ${marker}; no verdict supplied.`,
            };
          }
          if (!call.tools.some((tool) => tool.function?.name === "wait")) {
            return { _tag: "HttpError", status: 422 };
          }
          return {
            _tag: "ToolCall",
            name: "wait",
            arguments: {
              reason: `AH12 unexpected wait ${marker}`,
              waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
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
        `AH12 completion recovery ${marker}`,
      );
      const seededWork = await admitRootWorkThroughPublicConversation(
        client,
        project,
        marker,
        `Please complete this bounded qualification Work ${marker}.`,
      );
      const workId = seededWork.workId;
      expect(seededWork).toMatchObject({ revision: 0, status: "Open" });
      const seedWork = await waitForPublic(
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
          seedWaitIssued &&
          work?.workId === workId &&
          work.revision === 0 &&
          work.status === "Open" &&
          work.activeExecution === undefined,
      );
      if (seedWork?.workId !== workId) {
        throw new Error("AH12 public seed Work did not reach Manual wait");
      }
      const targetWorkRevision = seedWork.revision + 1;
      const seedExecutionIds = new Set(
        durableSnapshot(fixture.databaseFile).executions.map(
          (execution) => execution.execution_id,
        ),
      );
      expect(
        durableSnapshot(fixture.databaseFile).executions.every(
          (execution) => execution.settlement_kind !== "Failed",
        ),
      ).toBe(true);

      await fixture.crash();
      probeArmed = true;
      await fixture.restart({
        entry: crashChild,
        daemonEnvironment: { ARBOR_AH_BOUNDARY: boundary },
      });
      const steer = await client.command(project.projectId, "SteerWork", {
        workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: seedWork.revision,
        steer: {
          severity: "Normal",
          guidance: `Resume completion qualification ${marker}.`,
        },
        provenance: { source: "HumanInput" },
      });
      expect(
        (steer.body as { resolution?: string } | undefined)?.resolution,
      ).toBe("Committed");
      const steeredWork = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            revision: number;
            status: string;
          } | null>("current-work", {
            workspaceId: project.rootWorkspaceId,
          }),
        (work) =>
          work?.workId === workId &&
          work.revision === targetWorkRevision &&
          work.status === "Open",
      );
      expect(steeredWork?.revision).toBe(targetWorkRevision);

      const observed = await waitForPublic(
        async () => ({ hits, providerCalls: fixture.providerCalls.length }),
        (value) =>
          value.hits.some((hit) => hit.boundary === boundary) ||
          value.providerCalls >= 5,
        30_000,
      );
      const hit = observed.hits.find(
        (candidate) => candidate.boundary === boundary,
      );
      if (hit?.executionId === undefined || hit.commandId === undefined) {
        await fixture.crash();
        throw new Error(
          `AH12 probe absent at ${boundary}; daemon=${fixture.daemonErrors.join(" | ")}; output=${daemonOutput.slice(-8).join(" | ")}`,
        );
      }
      expect(seedExecutionIds.has(hit.executionId)).toBe(false);

      if (boundary === "AH12BeforeSettleExecutionCommit") {
        // The gateway hook runs after SettleExecution's handler, event append,
        // command receipt, and attempt writes, but before TransactionPort's
        // COMMIT. This fresh connection must still see the old committed view.
        const concurrentRead = durableSnapshot(fixture.databaseFile);
        const concurrentVerification = verificationSnapshot(
          fixture.databaseFile,
        );
        expect(
          concurrentRead.executions.find(
            (execution) => execution.execution_id === hit.executionId,
          ),
        ).toEqual(
          expect.objectContaining({
            settled_at: null,
            settlement_json: null,
          }),
        );
        expect(
          settlementReceipts(fixture.databaseFile, hit.executionId),
        ).toEqual([]);
        expect(commandAttempts(fixture.databaseFile, hit.commandId)).toEqual(
          [],
        );
        expect(
          settledEventsForExecution(
            concurrentVerification.executionSettledEvents,
            hit.executionId,
          ),
        ).toEqual([]);
        expect(concurrentVerification.verifications).toEqual([]);
        expect(concurrentVerification.workLifecycle).toEqual([
          expect.objectContaining({
            work_id: workId,
            lifecycle: "Open",
            revision: targetWorkRevision,
          }),
        ]);
      }

      await fixture.crash();
      const killed = durableSnapshot(fixture.databaseFile);
      const killedReceipts = settlementReceipts(
        fixture.databaseFile,
        hit.executionId,
      );
      const killedVerification = verificationSnapshot(fixture.databaseFile);
      const producerExecution = killed.executions.find(
        (execution) => execution.execution_id === hit.executionId,
      );
      const proposedJson =
        producerExecution?.settlement_json ??
        proposedStepSettlement(fixture.databaseFile, hit.executionId)
          ?.settlement_json;
      const proposedSettlement = proposedJson
        ? JSON.parse(String(proposedJson))
        : null;
      const completionResult =
        proposedSettlement?.settlement?.result ?? proposedSettlement?.result;
      expect(completionResult).toEqual(
        expect.objectContaining({
          _tag: "CompletionClaimed",
          workRevision: targetWorkRevision,
          claimRef: expect.any(String),
        }),
      );
      expect(completionResult.claimRef).toEqual(expect.any(String));
      expect(completionResult.claimRef.length).toBeGreaterThan(0);
      const killedTargetActions = killed.actions.filter(
        (action) => action.execution_id === hit.executionId,
      );
      expect(killedTargetActions).toHaveLength(1);
      expect(killedTargetActions[0]).toEqual(
        expect.objectContaining({
          execution_id: hit.executionId,
          action_kind: "claim_completion",
          state: "Applied",
        }),
      );
      const killedTargetExecutions = killed.executions.filter(
        (execution) => execution.execution_id === hit.executionId,
      );
      expect(killedTargetExecutions).toEqual([
        expect.objectContaining({
          execution_id: hit.executionId,
          settled_at:
            boundary === "AH12AfterSettleCommandCommit"
              ? expect.any(String)
              : null,
        }),
      ]);
      const killedTargetEpisodes = killedVerification.executionEpisodes.filter(
        (execution) => execution.execution_id === hit.executionId,
      );
      expect(killedTargetEpisodes).toEqual([
        expect.objectContaining({
          execution_id: hit.executionId,
          episode_kind: "WorkEpisode",
          episode_ref: workId,
          episode_revision: targetWorkRevision,
          settled_at:
            boundary === "AH12AfterSettleCommandCommit"
              ? expect.any(String)
              : null,
        }),
      ]);
      expect(killedReceipts).toEqual(
        boundary !== "AH12AfterSettleCommandCommit"
          ? []
          : [expect.objectContaining({ resolution: "Committed" })],
      );
      if (boundary === "AH12AfterSettleCommandCommit") {
        expect(killedReceipts[0]).toEqual(
          expect.objectContaining({ command_id: hit.commandId }),
        );
      }
      expect(killedVerification.verifications).toEqual([]);
      const killedTargetSettledEvents = settledEventsForExecution(
        killedVerification.executionSettledEvents,
        hit.executionId,
      );
      expect(killedTargetSettledEvents).toEqual(
        boundary !== "AH12AfterSettleCommandCommit" ? [] : [expect.anything()],
      );
      if (boundary !== "AH12AfterSettleCommandCommit") {
        expect(producerExecution?.settled_at).toBeNull();
        expect(producerExecution?.settlement_json).toBeNull();
        expect(killedVerification.workLifecycle).toEqual([
          expect.objectContaining({
            work_id: workId,
            lifecycle: "Open",
            revision: targetWorkRevision,
          }),
        ]);
        expect(killedTargetEpisodes).toEqual([
          expect.objectContaining({
            execution_id: hit.executionId,
            settled_at: null,
          }),
        ]);
        expect(killedReceipts).toEqual([]);
        expect(
          JSON.parse(
            String(
              proposedStepSettlement(fixture.databaseFile, hit.executionId)
                ?.settlement_json,
            ),
          ),
        ).toEqual(
          expect.objectContaining({
            _tag: "Completed",
            result: expect.objectContaining({
              _tag: "CompletionClaimed",
              workRevision: targetWorkRevision,
              claimRef: completionResult.claimRef,
            }),
          }),
        );
      } else {
        expect(producerExecution?.settled_at).not.toBeNull();
        expect(killedTargetSettledEvents).toHaveLength(1);
        const settledPayload = JSON.parse(
          String(killedTargetSettledEvents[0]?.payload_json),
        );
        expect(settledPayload).toEqual(
          expect.objectContaining({
            executionId: hit.executionId,
            workId,
            workRevision: targetWorkRevision,
            claimRef: completionResult.claimRef,
            settlement: expect.objectContaining({
              _tag: "Completed",
              result: expect.objectContaining({
                _tag: "CompletionClaimed",
                workRevision: targetWorkRevision,
                claimRef: completionResult.claimRef,
              }),
            }),
          }),
        );
      }

      await fixture.restart();
      const recovered = await waitForPublic(
        async () => recoverySnapshot(fixture.databaseFile),
        (value) => {
          if (value.verifications.length !== 1) return false;
          const verification = value.verifications[0];
          const verifierExecutionId = JSON.parse(
            String(verification?.verification_execution_ids ?? "[]"),
          )[0];
          return (
            typeof verifierExecutionId === "string" &&
            value.executions.some(
              (execution) =>
                execution.execution_id === verifierExecutionId &&
                execution.settled_at === null,
            ) &&
            value.verificationExecutions.some(
              (binding) =>
                binding.verification_id === verification?.verification_id &&
                binding.execution_id === verifierExecutionId,
            )
          );
        },
        45_000,
      );
      expect(
        recovered.steps.filter((step) => step.execution_id === hit.executionId),
      ).toEqual(
        killed.steps.filter((step) => step.execution_id === hit.executionId),
      );
      expect(
        recovered.actions.filter(
          (action) => action.execution_id === hit.executionId,
        ),
      ).toEqual(
        killed.actions.filter(
          (action) => action.execution_id === hit.executionId,
        ),
      );
      const recoveredProducer = recovered.executions.find(
        (execution) => execution.execution_id === hit.executionId,
      );
      const recoveredVerification = recovered.verifications[0];
      const verifierExecutionId = JSON.parse(
        String(recoveredVerification?.verification_execution_ids ?? "[]"),
      )[0];
      expect(recoveredProducer).toEqual(
        expect.objectContaining({
          execution_id: hit.executionId,
          settlement_kind: "Completed",
          settled_at: expect.any(String),
          settlement_json: expect.any(String),
        }),
      );
      expect(JSON.parse(String(recoveredProducer?.settlement_json))).toEqual(
        expect.objectContaining({
          _tag: "Completed",
          result: expect.objectContaining({
            _tag: "CompletionClaimed",
            workRevision: targetWorkRevision,
            claimRef: completionResult.claimRef,
          }),
        }),
      );
      const recoveredTargetWorkExecutions = recovered.executions.filter(
        (execution) =>
          execution.episode_kind === "WorkEpisode" &&
          execution.episode_ref === workId,
      );
      expect(recoveredTargetWorkExecutions).toHaveLength(2);
      expect(recoveredTargetWorkExecutions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            execution_id: hit.executionId,
            episode_kind: "WorkEpisode",
            episode_ref: workId,
            episode_revision: targetWorkRevision,
            settlement_kind: "Completed",
            settled_at: expect.any(String),
          }),
        ]),
      );
      expect(
        recovered.executions.find(
          (execution) => execution.execution_id === verifierExecutionId,
        ),
      ).toMatchObject({ settled_at: null });
      const recoveredSettlementReceipts = recovered.settlementReceipts.filter(
        (receipt) =>
          String(receipt.command_id).startsWith(
            `cmd_settle_${hit.executionId}_`,
          ),
      );
      expect(recoveredSettlementReceipts).toEqual([
        expect.objectContaining({ resolution: "Committed" }),
      ]);
      if (boundary === "AH12BeforeSettleExecutionCommit") {
        expect(recoveredSettlementReceipts[0]?.command_id).not.toBe(
          hit.commandId,
        );
      }
      expect(recovered.verifications).toEqual([
        expect.objectContaining({
          verification_id: expect.any(String),
          work_id: workId,
          target_work_revision: targetWorkRevision,
          state: "Open",
          verdict: null,
        }),
      ]);
      expect(recovered.verificationExecutions).toEqual([
        expect.objectContaining({
          verification_id: recoveredVerification?.verification_id,
          execution_id: verifierExecutionId,
        }),
      ]);
      const recoveredTargetSettledEvents = settledEventsForExecution(
        recovered.executionSettledEvents,
        hit.executionId,
      );
      expect(recoveredTargetSettledEvents).toHaveLength(1);
      const recoveredSettledPayload = JSON.parse(
        String(recoveredTargetSettledEvents[0]?.payload_json),
      );
      expect(recoveredSettledPayload).toEqual(
        expect.objectContaining({
          executionId: hit.executionId,
          workId,
          workRevision: targetWorkRevision,
          claimRef: completionResult.claimRef,
          settlement: expect.objectContaining({
            _tag: "Completed",
            result: expect.objectContaining({
              _tag: "CompletionClaimed",
              workRevision: targetWorkRevision,
              claimRef: completionResult.claimRef,
            }),
          }),
        }),
      );
      expect(recovered.startVerificationReceipts).toEqual([
        expect.objectContaining({
          command_id: expect.stringMatching(/^cmd_/),
          resolution: "Committed",
        }),
      ]);
      expect(recovered.startVerificationReceipts).toHaveLength(1);
      expect(
        JSON.parse(String(recovered.startVerificationReceipts[0]?.result_json)),
      ).toEqual(
        expect.objectContaining({
          verificationId: recoveredVerification?.verification_id,
          workId,
          targetWorkRevision,
          verifierExecutionId,
          state: "Open",
        }),
      );
      expect(recovered.works.filter((work) => work.work_id === workId)).toEqual(
        [
          expect.objectContaining({
            work_id: workId,
            lifecycle: "Open",
            revision: targetWorkRevision,
          }),
        ],
      );
      expect(targetProviderCalls).toBe(1);
      expect(fixture.daemonErrors).toEqual([]);
    },
    120_000,
  );
});
