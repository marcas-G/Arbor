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
  waitForPublic,
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];
const crashChild = resolve("tests/functional/support/ah-crash-child.mjs");
const boundaries = [
  "AH13BeforeResponseSweepCommit",
  "AH13AfterResponseSweepCommit",
] as const;

const conversationSnapshot = (databaseFile: string, messageId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      jobs: db
        .prepare(
          "SELECT message_id, state, active_execution_id, response_body, response_execution_id, revision FROM conversation_response_jobs WHERE message_id = ?",
        )
        .all(messageId),
      attempts: db
        .prepare(
          "SELECT message_id, attempt_no, execution_id, settled_at, settlement_kind FROM conversation_attempts WHERE message_id = ? ORDER BY attempt_no",
        )
        .all(messageId),
      executions: db
        .prepare(
          "SELECT execution_id, settled_at, settlement_kind FROM executions WHERE execution_id IN (SELECT execution_id FROM conversation_attempts WHERE message_id = ?)",
        )
        .all(messageId),
      outputs: db
        .prepare(
          "SELECT source_ref FROM session_entries WHERE entry_kind = 'ModelOutput' AND session_id IN (SELECT session_id FROM executions WHERE execution_id IN (SELECT execution_id FROM conversation_attempts WHERE message_id = ?))",
        )
        .all(messageId),
    };
  } finally {
    db.close();
  }
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("AH13 settled Execution to conversation response convergence", () => {
  it.each(boundaries)(
    "%s yields one visible answer after hard restart",
    async (boundary) => {
      const marker = `AH13-${crypto.randomUUID().slice(0, 8)}`;
      const answer = `ANSWER ${marker}`;
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
            return { _tag: "Text", text: answer };
          }
          return { _tag: "Text", text: "ack" };
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
        `AH13 conversation ${marker}`,
      );
      await submitHumanMessage(client, project, `请回复 ${marker}`);

      const observed = await waitForPublic(
        async () => ({ hits, providerCalls: fixture.providerCalls.length }),
        (value) =>
          value.hits.some((hit) => hit.boundary === boundary) ||
          value.providerCalls >= 4,
        30_000,
      );
      const hit = observed.hits.find(
        (candidate) => candidate.boundary === boundary,
      );
      if (hit?.messageId === undefined || hit.executionId === undefined) {
        await fixture.crash();
        throw new Error(
          `AH13 probe absent at ${boundary}; calls=${targetProviderCalls}; daemon=${fixture.daemonErrors.join(" | ")}; output=${daemonOutput.slice(-8).join(" | ")}`,
        );
      }

      await fixture.crash();
      const killed = conversationSnapshot(fixture.databaseFile, hit.messageId);
      expect(killed.executions).toEqual([
        expect.objectContaining({
          execution_id: hit.executionId,
          settled_at: expect.any(String),
          settlement_kind: "Completed",
        }),
      ]);
      expect(killed.jobs).toEqual([
        expect.objectContaining({
          message_id: hit.messageId,
          state:
            boundary === "AH13BeforeResponseSweepCommit"
              ? "Running"
              : "Answered",
        }),
      ]);
      expect(killed.attempts).toEqual([
        expect.objectContaining({
          execution_id: hit.executionId,
          settled_at:
            boundary === "AH13BeforeResponseSweepCommit"
              ? null
              : expect.any(String),
        }),
      ]);
      expect(killed.outputs).toHaveLength(1);

      await fixture.restart();
      const recovered = await waitForPublic(
        async () =>
          conversationSnapshot(fixture.databaseFile, hit.messageId ?? ""),
        (value) => value.jobs.some((job) => job.state === "Answered"),
        45_000,
      );
      expect(recovered.jobs).toEqual([
        expect.objectContaining({
          message_id: hit.messageId,
          state: "Answered",
          response_body: answer,
          response_execution_id: hit.executionId,
        }),
      ]);
      expect(recovered.attempts).toHaveLength(1);
      expect(recovered.outputs).toEqual(killed.outputs);
      const transcript = await client.view<{
        entries: Array<{ kind: string; body?: string }>;
      }>("transcript", {
        workspaceId: project.rootWorkspaceId,
        conversationOnly: true,
        limit: 20,
      });
      expect(
        transcript.entries.filter((entry) => entry.body === answer),
      ).toHaveLength(1);
      expect(targetProviderCalls).toBe(1);
      expect(fixture.daemonErrors).toEqual([]);
    },
    120_000,
  );
});
