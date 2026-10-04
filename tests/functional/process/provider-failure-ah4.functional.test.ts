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
  waitForPublic,
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];
const crashChild = resolve("tests/functional/support/ah-crash-child.mjs");

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("AH4 terminal Provider failure to SettlementProposed", () => {
  for (const boundary of [
    "AH4BeforeSettlementProposal",
    "AH4AfterSettlementProposal",
  ] as const) {
    it(`recovers without a fake reply after process kill at ${boundary}`, async () => {
      const marker = `AH4-${crypto.randomUUID().slice(0, 8)}`;
      const hits: AhProbeHit[] = [];
      const fixture = await startProductionFixture({
        reply: (call) =>
          JSON.stringify(call.messages).includes(marker)
            ? { _tag: "HttpError", status: 401 }
            : { _tag: "Text", text: "unrelated" },
        firstDaemonEntry: crashChild,
        daemonEnvironment: { ARBOR_AH_BOUNDARY: boundary },
        onDaemonStdout: (line) => recordAhProbeLine(hits, line),
      });
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `AH4 ${boundary}`,
      );
      await submitHumanMessage(client, project, `请回复 ${marker}`);

      try {
        await waitForPublic(
          async () => hits,
          (value) => value.some((hit) => hit.boundary === boundary),
          25_000,
        );
      } catch (error) {
        throw new Error(
          `AH4 probe absent: ${error instanceof Error ? error.message : String(error)}; providerCalls=${fixture.providerCalls.length}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      }
      await fixture.crash();
      const crashed = durableSnapshot(fixture.databaseFile);
      const executionId = (
        crashed.steps[0] as { execution_id?: string } | undefined
      )?.execution_id;
      if (executionId === undefined) throw new Error("AH4 Step absent");
      expect(crashed.providerTurns).toEqual([
        expect.objectContaining({
          provider_turn_id: hits[0]?.providerTurnId,
          settled_at:
            boundary === "AH4BeforeSettlementProposal"
              ? null
              : expect.any(String),
          finish_reason:
            boundary === "AH4BeforeSettlementProposal" ? null : "Failed",
        }),
      ]);
      expect(crashed.attempts).toEqual([
        expect.objectContaining({ outcome: "TerminalFailure" }),
      ]);
      expect(crashed.steps).toEqual([
        expect.objectContaining({
          state:
            boundary === "AH4BeforeSettlementProposal"
              ? "Prepared"
              : "SettlementProposed",
        }),
      ]);
      expect(crashed.outputs).toEqual([]);

      await fixture.restart();
      const recovered = await waitForPublic(
        async () => durableSnapshot(fixture.databaseFile),
        (value) =>
          value.executions.some(
            (row) =>
              (row as { execution_id: string; settlement_kind: string | null })
                .execution_id === executionId &&
              (row as { settlement_kind: string | null }).settlement_kind ===
                "Failed",
          ),
        45_000,
      );
      expect(recovered.providerTurns).toEqual([
        expect.objectContaining({
          provider_turn_id: hits[0]?.providerTurnId,
          finish_reason: "Failed",
        }),
      ]);
      expect(
        recovered.events.filter(
          (event) =>
            (event as { event_type: string; aggregate_ref: string })
              .event_type === "ExecutionSettled" &&
            (event as { aggregate_ref: string }).aggregate_ref === executionId,
        ),
      ).toHaveLength(1);
      expect(
        recovered.outputs.some(
          (output) =>
            (output as { source_ref: string }).source_ref ===
            hits[0]?.providerTurnId,
        ),
      ).toBe(false);
      const transcript = await client.view<{
        entries: Array<{ kind: string; body?: string }>;
      }>("transcript", {
        workspaceId: project.rootWorkspaceId,
        conversationOnly: true,
        limit: 20,
      });
      expect(
        transcript.entries.some(
          (entry) =>
            entry.kind === "AssistantConversationTurn" &&
            entry.body?.includes(marker) === true,
        ),
      ).toBe(false);
      expect(fixture.daemonErrors).toEqual([]);
    }, 90_000);
  }

  for (const boundary of [
    "AH4RepairBeforeSettlementProposal",
    "AH4RepairAfterSettlementProposal",
  ] as const) {
    it(`recovers exhausted output repair at ${boundary} without re-inference`, async () => {
      const marker = `AH4-REPAIR-${crypto.randomUUID().slice(0, 8)}`;
      const hits: AhProbeHit[] = [];
      const fixture = await startProductionFixture({
        reply: () => ({ _tag: "Text", text: "" }),
        firstDaemonEntry: crashChild,
        daemonEnvironment: { ARBOR_AH_BOUNDARY: boundary },
        onDaemonStdout: (line) => recordAhProbeLine(hits, line),
      });
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `AH4 repair ${boundary}`,
      );
      await submitHumanMessage(client, project, `请回复 ${marker}`);

      try {
        await waitForPublic(
          async () => hits,
          (value) => value.some((hit) => hit.boundary === boundary),
          30_000,
        );
      } catch (error) {
        throw new Error(
          `AH4 repair probe absent: ${error instanceof Error ? error.message : String(error)}; providerCalls=${fixture.providerCalls.length}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      }
      await fixture.crash();
      const crashed = durableSnapshot(fixture.databaseFile);
      const finalStep = crashed.steps.find(
        (row) =>
          (row as { provider_turn_id: string }).provider_turn_id ===
          hits[0]?.providerTurnId,
      ) as { execution_id: string; state: string; repair_attempt: number };
      expect(finalStep).toMatchObject({
        repair_attempt: 2,
        state:
          boundary === "AH4RepairBeforeSettlementProposal"
            ? "OutputRejected"
            : "SettlementProposed",
      });
      expect(crashed.outputs).toEqual([]);
      const providerCallsBeforeRestart = fixture.providerCalls.length;

      await fixture.restart();
      let recovered: ReturnType<typeof durableSnapshot>;
      try {
        recovered = await waitForPublic(
          async () => durableSnapshot(fixture.databaseFile),
          (value) =>
            value.executions.some(
              (row) =>
                (
                  row as {
                    execution_id: string;
                    settlement_kind: string | null;
                  }
                ).execution_id === finalStep.execution_id &&
                (row as { settlement_kind: string | null }).settlement_kind ===
                  "Failed",
            ),
          45_000,
        );
      } catch (error) {
        throw new Error(
          `AH4 repair recovery failed: ${error instanceof Error ? error.message : String(error)}; crashed=${JSON.stringify(crashed)}; after=${JSON.stringify(durableSnapshot(fixture.databaseFile))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      }
      expect(fixture.providerCalls).toHaveLength(providerCallsBeforeRestart);
      expect(
        recovered.events.filter(
          (event) =>
            (event as { event_type: string; aggregate_ref: string })
              .event_type === "ExecutionSettled" &&
            (event as { aggregate_ref: string }).aggregate_ref ===
              finalStep.execution_id,
        ),
      ).toHaveLength(1);
      expect(recovered.outputs).toEqual([]);
      expect(fixture.daemonErrors).toEqual([]);
    }, 90_000);
  }
});
