import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AhProbeHit,
  recordAhProbeLine,
} from "../support/ah-probe-line.js";
import {
  type CapturedProviderCall,
  type ProductionFixture,
  type ScriptedProviderResponse,
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

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

type Boundary =
  | "RAI-DG02BeforeFinalAttemptSettlementCommit"
  | "RAI-DG02AfterFinalAttemptSettlementCommit"
  | "AH4BeforeSettlementProposal"
  | "AH4AfterSettlementProposal"
  | "AH12BeforeSettleGatewaySubmission"
  | "AH12BeforeSettleExecutionCommit"
  | "AH12AfterSettleCommandCommit";

const terminalProvider =
  (marker: string) =>
  (call: CapturedProviderCall): ScriptedProviderResponse => {
    const names = new Set(
      call.tools
        .map((tool) => tool.function?.name)
        .filter((name): name is string => name !== undefined),
    );
    const context = JSON.stringify(call.messages);
    if (names.has("claim_completion")) {
      return { _tag: "HttpError", status: 400 };
    }
    if (names.has("assign_work") && context.includes(marker)) {
      return context.includes("WorkAssigned(")
        ? { _tag: "Text", text: `Work admitted for ${marker}` }
        : {
            _tag: "ToolCall",
            name: "assign_work",
            arguments: {
              objective: `Complete ${marker}.`,
              why: "qualify terminal Provider crash recovery",
              constraints: ["no external side effects"],
              completionExpectation: "terminal failure is held once",
              verificationMission: {
                goal: `Verify ${marker}`,
                criteria: [
                  {
                    criterionId: "rai-terminal-crash-hold",
                    requirement: "same Work revision is not readmitted",
                    required: true,
                  },
                ],
                riskRequirements: ["no repeated Provider request"],
              },
              reason: "RAI-DG-02 crash matrix qualification",
            },
          };
    }
    return { _tag: "Text", text: `Observed ${marker}` };
  };

const stateSnapshot = (
  databaseFile: string,
  workId: string,
  providerTurnId?: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  db.exec("BEGIN");
  try {
    const rows = {
      executions: db
        .prepare(
          "SELECT execution_id, settlement_kind, settlement_json, settled_at FROM executions WHERE episode_kind = 'WorkEpisode' AND episode_ref = ? ORDER BY admitted_at, execution_id",
        )
        .all(workId) as Array<{
        execution_id: string;
        settlement_kind: string | null;
        settlement_json: string | null;
        settled_at: string | null;
      }>,
      steps: db
        .prepare(
          `SELECT execution_id, provider_turn_id, state, settlement_json FROM agent_loop_steps WHERE execution_id IN (SELECT execution_id FROM executions WHERE episode_ref = ?)${providerTurnId === undefined ? "" : " AND provider_turn_id = ?"} ORDER BY execution_id, logical_step_no, repair_attempt`,
        )
        .all(
          ...(providerTurnId === undefined
            ? [workId]
            : [workId, providerTurnId]),
        ) as Array<{
        execution_id: string;
        provider_turn_id: string;
        state: string;
        settlement_json: string | null;
      }>,
      turns: db
        .prepare(
          `SELECT provider_turn_id, settled_at, finish_reason FROM provider_turns WHERE execution_id IN (SELECT execution_id FROM executions WHERE episode_ref = ?)${providerTurnId === undefined ? "" : " AND provider_turn_id = ?"} ORDER BY provider_turn_id`,
        )
        .all(
          ...(providerTurnId === undefined
            ? [workId]
            : [workId, providerTurnId]),
        ) as Array<{
        provider_turn_id: string;
        settled_at: string | null;
        finish_reason: string | null;
      }>,
      attempts: db
        .prepare(
          providerTurnId === undefined
            ? "SELECT provider_turn_id, attempt_no, settled_at, outcome, provider_error_kind, failure_taxonomy_version, retry_decision FROM provider_attempts WHERE provider_turn_id IN (SELECT provider_turn_id FROM provider_turns WHERE execution_id IN (SELECT execution_id FROM executions WHERE episode_ref = ?)) ORDER BY provider_turn_id, attempt_no"
            : "SELECT provider_turn_id, attempt_no, settled_at, outcome, provider_error_kind, failure_taxonomy_version, retry_decision FROM provider_attempts WHERE provider_turn_id = ? ORDER BY attempt_no",
        )
        .all(
          ...(providerTurnId === undefined ? [workId] : [providerTurnId]),
        ) as Array<{
        provider_turn_id: string;
        attempt_no: number;
        settled_at: string | null;
        outcome: string | null;
        provider_error_kind: string | null;
        failure_taxonomy_version: string | null;
        retry_decision: string | null;
      }>,
    };
    db.exec("COMMIT");
    return rows;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
};

const executionSettlementEvents = (
  databaseFile: string,
  executionId: string,
) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT event_id FROM domain_events WHERE event_type = 'ExecutionSettled' AND aggregate_ref = ?",
      )
      .all(executionId);
  } finally {
    db.close();
  }
};

describe("RAI-DG-02 terminal Provider failure process crash submatrix", () => {
  for (const boundary of [
    "RAI-DG02BeforeFinalAttemptSettlementCommit",
    "RAI-DG02AfterFinalAttemptSettlementCommit",
    "AH4BeforeSettlementProposal",
    "AH4AfterSettlementProposal",
    "AH12BeforeSettleGatewaySubmission",
    "AH12BeforeSettleExecutionCommit",
    "AH12AfterSettleCommandCommit",
  ] as const satisfies ReadonlyArray<Boundary>) {
    it(`recovers the same failed Work Execution at ${boundary} without readmission`, async () => {
      const marker = `RAI-DG-02-CRASH-${boundary}-${crypto.randomUUID().slice(0, 8)}`;
      const hits: AhProbeHit[] = [];
      const initialBoundary = boundary.startsWith("AH12")
        ? "AH4AfterSettlementProposal"
        : boundary;
      const fixture = await startProductionFixture({
        reply: terminalProvider(marker),
        firstDaemonEntry: crashChild,
        daemonEnvironment: { ARBOR_AH_BOUNDARY: initialBoundary },
        onDaemonStdout: (line) => recordAhProbeLine(hits, line),
      });
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `RAI terminal crash ${boundary}`,
      );
      await submitHumanMessage(client, project, `Create ${marker}`);
      const approval = await waitForApproval(client, project, marker);
      await client.command(project.projectId, "ResolveControlApproval", {
        approvalId: approval.approvalId,
        expectedRevision: approval.revision,
        decision: "Approve",
        reason: "qualify terminal Provider failure recovery",
      });

      const work = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            revision: number;
            status: string;
          } | null>("current-work", {
            workspaceId: project.rootWorkspaceId,
          }),
        (value) => value?.workId !== undefined,
      );
      const workId = work?.workId;
      if (workId === undefined) throw new Error("RAI WorkId missing");

      const firstHit = await waitForPublic(
        async () => hits,
        (value) => value.some((probe) => probe.boundary === initialBoundary),
        30_000,
      ).then((value) =>
        value.find((probe) => probe.boundary === initialBoundary),
      );
      if (firstHit === undefined) {
        throw new Error(
          `initial probe missing at ${initialBoundary}; providerCalls=${fixture.providerCalls.length}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      }

      await fixture.crash();
      let crashed = stateSnapshot(
        fixture.databaseFile,
        workId,
        firstHit.providerTurnId,
      );
      if (boundary !== initialBoundary) {
        await fixture.restart({
          entry: crashChild,
          daemonEnvironment: { ARBOR_AH_BOUNDARY: boundary },
        });
        const recoveryHit = await waitForPublic(
          async () => hits,
          (value) => value.some((probe) => probe.boundary === boundary),
          30_000,
        ).then((value) => value.find((probe) => probe.boundary === boundary));
        if (recoveryHit === undefined) {
          const calls = fixture.providerCalls.length;
          await fixture.crash();
          throw new Error(
            `recovery probe missing at ${boundary}; providerCalls=${calls}; state=${JSON.stringify(stateSnapshot(fixture.databaseFile, workId, firstHit.providerTurnId))}; daemon=${fixture.daemonErrors.join(" | ")}`,
          );
        }
        await fixture.crash();
        crashed = stateSnapshot(
          fixture.databaseFile,
          workId,
          firstHit.providerTurnId,
        );
      }
      expect(crashed.executions).toHaveLength(1);
      if (boundary === "RAI-DG02BeforeFinalAttemptSettlementCommit") {
        expect(crashed.attempts).toEqual([
          expect.objectContaining({
            provider_turn_id: firstHit.providerTurnId,
            attempt_no: 0,
            outcome: "InProgress",
            settled_at: null,
            provider_error_kind: null,
            retry_decision: null,
          }),
        ]);
      } else {
        expect(crashed.attempts[0]).toMatchObject({
          provider_turn_id: firstHit.providerTurnId,
          attempt_no: 0,
          outcome: "TerminalFailure",
          provider_error_kind: "RequestRejected",
          failure_taxonomy_version: "phase1-v2",
          settled_at: expect.any(String),
          retry_decision: "Stop",
        });
      }
      // The provider's in-flight HTTP result is not durable before this commit.
      // Recovery must remain on the original Turn/Execution and fail closed
      // from ProcessLost evidence instead of inventing RequestRejected.
      expect(crashed.executions[0]?.settlement_kind).toBe(
        boundary === "AH12AfterSettleCommandCommit" ? "Failed" : null,
      );
      if (
        boundary === "AH4BeforeSettlementProposal" ||
        boundary === "RAI-DG02BeforeFinalAttemptSettlementCommit" ||
        boundary === "RAI-DG02AfterFinalAttemptSettlementCommit"
      ) {
        expect(crashed.turns[0]).toMatchObject({
          settled_at: null,
          finish_reason: null,
        });
        expect(crashed.steps[0]?.state).toBe("Prepared");
      } else {
        expect(crashed.turns[0]).toMatchObject({
          settled_at: expect.any(String),
          finish_reason: "Failed",
        });
        expect(crashed.steps[0]?.state).toBe("SettlementProposed");
      }
      if (boundary === "AH4AfterSettlementProposal") {
        // AH4's transaction commits ProviderTurn failure and Step proposal
        // atomically, so the frozen implementation exposes their joint edge.
        expect(crashed.turns[0]?.finish_reason).toBe("Failed");
        expect(crashed.steps[0]?.state).toBe("SettlementProposed");
      }
      if (
        boundary !== "AH12AfterSettleCommandCommit" &&
        boundary !== "AH4BeforeSettlementProposal" &&
        !boundary.startsWith("RAI-DG02")
      ) {
        expect(crashed.steps[0]?.settlement_json).toContain(
          "ProviderFailure:RequestRejected",
        );
      }
      const callsAtCrash = fixture.providerCalls.length;

      await fixture.restart();
      const recovered = await waitForPublic(
        async () =>
          stateSnapshot(fixture.databaseFile, workId, firstHit.providerTurnId),
        (value) => value.executions[0]?.settlement_kind === "Failed",
        45_000,
      );
      expect(
        recovered.executions,
        JSON.stringify(recovered.executions),
      ).toHaveLength(1);
      expect(recovered.steps).toHaveLength(1);
      expect(recovered.steps[0]?.state).toBe("SettlementProposed");
      expect(recovered.turns).toEqual([
        expect.objectContaining({
          provider_turn_id: firstHit.providerTurnId,
          finish_reason: "Failed",
        }),
      ]);
      if (boundary === "RAI-DG02BeforeFinalAttemptSettlementCommit") {
        expect(recovered.attempts).toHaveLength(1);
        expect(recovered.attempts).toEqual([
          expect.objectContaining({
            provider_turn_id: firstHit.providerTurnId,
            attempt_no: 0,
            outcome: "TerminalFailure",
            settled_at: expect.any(String),
            provider_error_kind: null,
            retry_decision: "Stop",
          }),
        ]);
      } else {
        expect(recovered.attempts).toEqual(crashed.attempts);
      }
      const executionId = crashed.executions[0]?.execution_id;
      if (executionId === undefined)
        throw new Error("crashed Execution missing");
      expect(
        executionSettlementEvents(fixture.databaseFile, executionId),
      ).toHaveLength(1);
      expect(fixture.providerCalls).toHaveLength(callsAtCrash);
      if (boundary === "RAI-DG02BeforeFinalAttemptSettlementCommit") {
        const detail = await client.view<{
          terminalProviderFailure?: { kind: string };
        }>("work-detail", {
          projectId: project.projectId,
          workspaceId: project.rootWorkspaceId,
          workId,
        });
        expect(detail.terminalProviderFailure?.kind).toBe(
          "TerminalProviderFailureIntegrity",
        );
      }
      const callsAfterRecovery = fixture.providerCalls.length;
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_200));
      expect(
        stateSnapshot(fixture.databaseFile, workId, firstHit.providerTurnId)
          .executions,
      ).toHaveLength(1);
      expect(fixture.providerCalls).toHaveLength(callsAfterRecovery);
      expect(fixture.daemonErrors).toEqual([]);
    }, 180_000);
  }
});
