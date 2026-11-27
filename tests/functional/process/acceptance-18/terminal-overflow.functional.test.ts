import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startProductionFixture } from "../../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
  waitForPublic,
} from "../../support/public-client.js";
import {
  type Ah4Probe,
  ah18AfterEach,
  ahCrashChild,
  expireLeaseAfterOldDaemonExit,
  fixtures,
  providerServers,
  readSnapshot,
  startAh18MeasuredWork,
  startOverflowProvider,
} from "./support.js";

afterEach(ah18AfterEach);

describe("linked overflow compaction recovery", () => {
  it.each([
    "AH4BeforeSettlementProposal",
    "AH4AfterSettlementProposal",
  ] as const)(
    "terminalizes a second ContextLimit without another ordinal at %s",
    async (boundary) => {
      const marker = `AH18-terminal-${randomUUID().slice(0, 8)}`;
      const provider = await startOverflowProvider(marker, "context-limit");
      providerServers.push(provider.server);
      const probes: Ah4Probe[] = [];
      const fixture = await startProductionFixture({
        reply: () => ({ _tag: "HttpError", status: 500 }),
        daemonEnvironment: {
          ARBOR_MODEL_BASE_URL: provider.baseUrl,
        },
        onDaemonStdout: (line) => {
          try {
            const probe = JSON.parse(line) as Ah4Probe;
            if (probe.tag === "AH_PROBE") probes.push(probe);
          } catch {
            // Preserve the real daemon diagnostics on the fixture.
          }
        },
      });
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `AH18 terminal replacement ${marker}`,
      );
      const measured = await startAh18MeasuredWork({
        client,
        fixture,
        project,
        provider,
        marker,
        restartOptions: {
          entry: ahCrashChild,
          daemonEnvironment: {
            ARBOR_AH_BOUNDARY: boundary,
            ARBOR_MODEL_BASE_URL: provider.baseUrl,
          },
        },
      });
      const { workId, executionId } = measured;

      const terminalProbe = await waitForPublic(
        async () => probes.find((probe) => probe.boundary === boundary),
        (probe) => probe !== undefined,
        60_000,
      ).catch((error: unknown) => {
        throw new Error(
          `AH18 terminal proposal probe absent: ${error instanceof Error ? error.message : String(error)}; requests=${JSON.stringify(provider.requests.map((request) => request.kind))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });
      if (terminalProbe?.providerTurnId === undefined) {
        throw new Error("AH18 terminal overflow probe omitted ProviderTurnId");
      }
      const initialInferenceId = `ptn_${executionId}_0`;
      const compactionId = `ptn_${executionId}_0_compact_0`;
      const replacementId = `ptn_${executionId}_0_overflow_0`;
      expect(terminalProbe.providerTurnId).toBe(replacementId);
      expect(provider.requests.map((request) => request.kind)).toEqual([
        "initial-inference",
        "summary",
        "replacement-inference",
      ]);

      const ids = {
        sessionId: project.rootSessionId,
        executionId,
        workId,
      };
      const beforeKill = readSnapshot(fixture.databaseFile, ids);
      expect(beforeKill.session?.context_epoch).toBe(1);
      expect(beforeKill.checkpoints).toHaveLength(1);
      expect(beforeKill.checkpoints[0]).toMatchObject({
        context_epoch: 1,
        source_kind: "CompactionTurn",
        source_ref: compactionId,
      });
      expect(beforeKill.links).toEqual([
        expect.objectContaining({
          logical_step_no: 0,
          repair_attempt: 0,
          overflow_ordinal: 0,
          role: "Inference",
          provider_turn_id: initialInferenceId,
        }),
        expect.objectContaining({
          logical_step_no: 0,
          repair_attempt: 0,
          overflow_ordinal: 0,
          role: "OverflowCompaction",
          provider_turn_id: compactionId,
        }),
        expect.objectContaining({
          logical_step_no: 0,
          repair_attempt: 0,
          overflow_ordinal: 0,
          role: "OverflowReplacement",
          provider_turn_id: replacementId,
        }),
      ]);
      expect(beforeKill.providerAttempts).toHaveLength(3);
      expect(beforeKill.providerAttempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider_turn_id: initialInferenceId,
            outcome: "TerminalFailure",
            provider_error_kind: "ContextLimitExceeded",
          }),
          expect.objectContaining({
            provider_turn_id: compactionId,
            outcome: "Success",
          }),
          expect.objectContaining({
            provider_turn_id: replacementId,
            outcome: "TerminalFailure",
            provider_error_kind: "ContextLimitExceeded",
          }),
        ]),
      );
      expect(beforeKill.steps).toEqual([
        expect.objectContaining({
          logical_step_no: 0,
          repair_attempt: 0,
          state:
            boundary === "AH4BeforeSettlementProposal"
              ? "Prepared"
              : "SettlementProposed",
          ...(boundary === "AH4AfterSettlementProposal"
            ? {
                settlement_json: expect.stringContaining(
                  "ContextLimitExceeded",
                ),
              }
            : { settlement_json: null }),
        }),
      ]);
      expect(beforeKill.execution?.settled_at).toBeNull();
      expect(beforeKill.actions).toEqual([]);
      expect(
        beforeKill.durableOutputs.filter(
          (item) =>
            item.source_ref?.startsWith(`ptn_${executionId}_`) === true ||
            item.source_ref?.startsWith(`observation_${executionId}_`) === true,
        ),
      ).toEqual([]);

      await fixture.crash();
      const afterOldKill = readSnapshot(fixture.databaseFile, ids);
      expect(afterOldKill.session).toEqual(beforeKill.session);
      expect(afterOldKill.checkpoints).toEqual(beforeKill.checkpoints);
      expect(afterOldKill.links).toEqual(beforeKill.links);
      await expireLeaseAfterOldDaemonExit(
        fixture,
        project,
        executionId,
        workId,
      );
      await fixture.restart();

      const terminal = await waitForPublic(
        async () => readSnapshot(fixture.databaseFile, ids),
        (snapshot) =>
          snapshot.execution?.settled_at !== null &&
          snapshot.execution?.settlement_kind === "Failed" &&
          snapshot.steps[0]?.state === "SettlementProposed",
        60_000,
      ).catch((error: unknown) => {
        throw new Error(
          `AH18 second overflow did not terminalize: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(provider.requests.map((request) => request.kind))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });

      expect(terminal.steps).toEqual([
        expect.objectContaining({
          logical_step_no: 0,
          repair_attempt: 0,
          state: "SettlementProposed",
          settlement_json: expect.stringContaining(
            "ProviderFailure:ContextLimitExceeded",
          ),
        }),
      ]);
      expect(terminal.session?.context_epoch).toBe(1);
      expect(terminal.checkpoints).toHaveLength(1);
      expect(terminal.links).toEqual(beforeKill.links);
      expect(terminal.providerTurns).toHaveLength(3);
      expect(terminal.providerAttempts).toHaveLength(3);
      expect(terminal.actions).toEqual([]);
      expect(
        terminal.durableOutputs.filter(
          (item) =>
            item.source_ref?.startsWith(`ptn_${executionId}_`) === true ||
            item.source_ref?.startsWith(`observation_${executionId}_`) === true,
        ),
      ).toEqual([]);
      expect(provider.requests.map((request) => request.kind)).toEqual([
        "initial-inference",
        "summary",
        "replacement-inference",
      ]);
      expect(fixture.daemonErrors).toEqual([]);
    },
    180_000,
  );
});
