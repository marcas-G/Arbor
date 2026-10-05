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
  createFunctionalProject,
  functionalId,
  makePublicClient,
  waitForPublic,
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];
const crashChild = resolve("tests/functional/support/ah-crash-child.mjs");
const boundaries = [
  "AH12BeforeSettleCommandCommit",
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

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("AH12 SettlementProposed to SettleExecution command", () => {
  it.each(boundaries)(
    "%s settles once after hard restart",
    async (boundary) => {
      const marker = `AH12-${crypto.randomUUID().slice(0, 8)}`;
      const hits: AhProbeHit[] = [];
      const daemonOutput: string[] = [];
      let targetProviderCalls = 0;
      const fixture = await startProductionFixture({
        reply: (call) => {
          if (JSON.stringify(call.messages).includes(marker)) {
            targetProviderCalls += 1;
            if (targetProviderCalls > 1) {
              return { _tag: "HttpError", status: 429 };
            }
          }
          if (!call.tools.some((tool) => tool.function?.name === "wait")) {
            return { _tag: "HttpError", status: 422 };
          }
          return {
            _tag: "ToolCall",
            name: "wait",
            arguments: {
              reason: `AH12 terminal wait ${marker}`,
              waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
            },
          };
        },
        firstDaemonEntry: crashChild,
        daemonEnvironment: { ARBOR_AH_BOUNDARY: boundary },
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
        `AH12 settlement ${marker}`,
      );
      const workId = functionalId("wrk");
      await client.command(project.projectId, "AssignWork", {
        workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkspaceRevision: 0,
        objective: `Wait for a manual signal for ${marker}.`,
        why: "qualify settlement command process crash",
        constraints: [],
        completionExpectation: "the execution records a bounded WorkWait",
        verificationMission: {
          goal: `Verify AH12 ${marker}`,
          criteria: [
            {
              criterionId: "ah12-wait",
              requirement: "the terminal wait is recorded once",
              required: true,
            },
          ],
          riskRequirements: [],
        },
        provenance: { predecessorWorkId: null, reason: "AH12 process test" },
        revision: 0,
      });

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
      if (hit?.executionId === undefined) {
        await fixture.crash();
        throw new Error(
          `AH12 probe absent at ${boundary}; daemon=${fixture.daemonErrors.join(" | ")}; output=${daemonOutput.slice(-8).join(" | ")}`,
        );
      }

      await fixture.crash();
      const killed = durableSnapshot(fixture.databaseFile);
      const killedReceipts = settlementReceipts(
        fixture.databaseFile,
        hit.executionId,
      );
      expect(killed.steps).toEqual([
        expect.objectContaining({
          execution_id: hit.executionId,
          logical_step_no: 0,
          state: "SettlementProposed",
        }),
      ]);
      expect(killed.actions).toEqual([
        expect.objectContaining({
          execution_id: hit.executionId,
          action_kind: "wait",
          state: "Applied",
        }),
      ]);
      expect(killed.executions).toEqual([
        expect.objectContaining({
          execution_id: hit.executionId,
          settled_at:
            boundary === "AH12BeforeSettleCommandCommit"
              ? null
              : expect.any(String),
        }),
      ]);
      expect(killedReceipts).toEqual(
        boundary === "AH12BeforeSettleCommandCommit"
          ? []
          : [expect.objectContaining({ resolution: "Committed" })],
      );

      await fixture.restart();
      const recovered = await waitForPublic(
        async () => durableSnapshot(fixture.databaseFile),
        (value) =>
          value.executions.some(
            (execution) =>
              execution.execution_id === hit.executionId &&
              execution.settled_at !== null,
          ),
        45_000,
      );
      expect(recovered.steps).toEqual(killed.steps);
      expect(recovered.actions).toEqual(killed.actions);
      expect(recovered.executions).toEqual([
        expect.objectContaining({
          execution_id: hit.executionId,
          settlement_kind: "Completed",
          settled_at: expect.any(String),
        }),
      ]);
      expect(settlementReceipts(fixture.databaseFile, hit.executionId)).toEqual(
        [expect.objectContaining({ resolution: "Committed" })],
      );
      expect(recovered.works).toEqual([
        expect.objectContaining({ work_id: workId, revision: 0 }),
      ]);
      expect(fixture.providerCalls).toHaveLength(1);
      expect(fixture.daemonErrors).toEqual([]);
    },
    120_000,
  );
});
