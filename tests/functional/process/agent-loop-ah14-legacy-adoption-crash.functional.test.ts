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
  makePublicClient,
  submitHumanMessage,
  waitForPublic,
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];
const crashChild = resolve("tests/functional/support/ah-crash-child.mjs");
const boundaries = [
  "AH14BeforeLegacyAdoptionCommit",
  "AH14AfterLegacyAdoptionCommit",
] as const;

const adoptionSnapshot = (databaseFile: string, providerTurnId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      steps: db
        .prepare(
          "SELECT provider_turn_id, state, migration_provenance_json FROM agent_loop_steps WHERE provider_turn_id = ?",
        )
        .all(providerTurnId),
      attempts: db
        .prepare(
          "SELECT provider_turn_id, outcome, success_evidence_version FROM provider_attempts WHERE provider_turn_id = ?",
        )
        .all(providerTurnId),
      outputs: db
        .prepare(
          "SELECT source_ref FROM session_entries WHERE source_kind = 'ProviderTurn' AND ((entry_kind = 'ModelOutput' AND source_ref = ?) OR (item_type = 'AssistantMessage' AND source_ref = ?))",
        )
        .all(providerTurnId, `${providerTurnId}:assistant`),
    };
  } finally {
    db.close();
  }
};

const markEquivalentLegacyEvidence = (
  databaseFile: string,
  providerTurnId: string,
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    const result = db
      .prepare(
        "UPDATE provider_attempts SET success_evidence_version = NULL WHERE provider_turn_id = ? AND outcome = 'Success' AND success_evidence_version = 'provider-success-v1'",
      )
      .run(providerTurnId);
    expect(result.changes).toBe(1);
  } finally {
    db.close();
  }
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("AH14 evidence-gated legacy success adoption", () => {
  it.each(boundaries)(
    "%s converges identically across two further restarts",
    async (boundary) => {
      const marker = `AH14-${crypto.randomUUID().slice(0, 8)}`;
      const answer = `LEGACY ANSWER ${marker}`;
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
        daemonEnvironment: { ARBOR_AH_BOUNDARY: "AH3BeforeStepAvailable" },
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
        `AH14 legacy ${marker}`,
      );
      await submitHumanMessage(client, project, `请回复 ${marker}`);
      const initial = await waitForPublic(
        async () => hits,
        (value) =>
          value.some((hit) => hit.boundary === "AH3BeforeStepAvailable"),
        25_000,
      );
      const providerTurnId = initial.find(
        (hit) => hit.boundary === "AH3BeforeStepAvailable",
      )?.providerTurnId;
      if (providerTurnId === undefined) {
        throw new Error("AH14 fixture lacks a settled ProviderTurn identity");
      }
      await fixture.crash();
      const prepared = adoptionSnapshot(fixture.databaseFile, providerTurnId);
      expect(prepared.steps).toEqual([
        expect.objectContaining({ state: "Prepared" }),
      ]);
      expect(prepared.attempts).toEqual([
        expect.objectContaining({
          outcome: "Success",
          success_evidence_version: "provider-success-v1",
        }),
      ]);
      expect(prepared.outputs).toEqual([]);
      markEquivalentLegacyEvidence(fixture.databaseFile, providerTurnId);

      await fixture.restart({
        entry: crashChild,
        daemonEnvironment: { ARBOR_AH_BOUNDARY: boundary },
      });
      const adoptionHit = await waitForPublic(
        async () => ({ hits, calls: fixture.providerCalls.length }),
        (value) =>
          value.hits.some((hit) => hit.boundary === boundary) ||
          value.calls > 1,
        45_000,
      );
      if (!adoptionHit.hits.some((hit) => hit.boundary === boundary)) {
        await fixture.crash();
        throw new Error(
          `AH14 adoption probe absent; calls=${targetProviderCalls}; daemon=${fixture.daemonErrors.join(" | ")}; output=${daemonOutput.slice(-8).join(" | ")}`,
        );
      }
      await fixture.crash();
      const killed = adoptionSnapshot(fixture.databaseFile, providerTurnId);
      expect(killed.steps).toEqual([
        expect.objectContaining({
          state:
            boundary === "AH14BeforeLegacyAdoptionCommit"
              ? "Prepared"
              : "ProviderResultAvailable",
        }),
      ]);
      expect(killed.attempts).toEqual([
        expect.objectContaining({
          success_evidence_version:
            boundary === "AH14BeforeLegacyAdoptionCommit"
              ? null
              : "provider-success-v1",
        }),
      ]);
      expect(killed.outputs).toEqual([]);

      await fixture.restart();
      const converged = await waitForPublic(
        async () => adoptionSnapshot(fixture.databaseFile, providerTurnId),
        (value) =>
          value.steps.some((step) => step.state === "SettlementProposed") &&
          value.outputs.length === 1,
        45_000,
      );
      expect(converged.steps).toEqual([
        expect.objectContaining({
          state: "SettlementProposed",
          migration_provenance_json: expect.stringContaining(
            "LegacySettledProviderSuccess",
          ),
        }),
      ]);
      expect(converged.attempts).toEqual([
        expect.objectContaining({
          outcome: "Success",
          success_evidence_version: "provider-success-v1",
        }),
      ]);
      const transcript = await waitForPublic(
        () =>
          client.view<{
            entries: Array<{ kind: string; body?: string }>;
          }>("transcript", {
            workspaceId: project.rootWorkspaceId,
            conversationOnly: true,
            limit: 20,
          }),
        (value) => value.entries.some((entry) => entry.body === answer),
        45_000,
      );
      expect(
        transcript.entries.filter((entry) => entry.body === answer),
      ).toHaveLength(1);
      const beforeSecondRestart = durableSnapshot(fixture.databaseFile);
      await fixture.restart();
      const afterSecondRestart = adoptionSnapshot(
        fixture.databaseFile,
        providerTurnId,
      );
      expect(afterSecondRestart).toEqual(converged);
      expect(durableSnapshot(fixture.databaseFile).providerTurns).toEqual(
        beforeSecondRestart.providerTurns,
      );
      expect(targetProviderCalls).toBe(1);
      expect(fixture.daemonErrors).toEqual([]);
    },
    180_000,
  );
});
