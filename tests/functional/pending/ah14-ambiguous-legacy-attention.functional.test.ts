import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
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

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

it("AH14 ambiguous legacy action evidence yields durable project Attention without replay", async () => {
  const marker = `AH14-AMB-${crypto.randomUUID().slice(0, 8)}`;
  const hits: AhProbeHit[] = [];
  let providerCalls = 0;
  const fixture = await startProductionFixture({
    admitWorkspaceDirectory: true,
    reply: (call) => {
      if (JSON.stringify(call.messages).includes(marker)) {
        providerCalls += 1;
        if (providerCalls > 1) return { _tag: "HttpError", status: 429 };
      }
      return {
        _tag: "ToolCall",
        name: "read",
        arguments: {
          target: { mount: "workspace", path: "proof.txt" },
          limit: 200,
        },
      };
    },
    firstDaemonEntry: crashChild,
    daemonEnvironment: { ARBOR_AH_BOUNDARY: "AH3BeforeStepAvailable" },
    onDaemonStdout: (line) => recordAhProbeLine(hits, line),
  });
  fixtures.push(fixture);
  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    `AH14 ambiguous ${marker}`,
    { resourceSelection: "Profile" },
  );
  await client.command(project.projectId, "AssignWork", {
    workId: functionalId("wrk"),
    workspaceId: project.rootWorkspaceId,
    expectedWorkspaceRevision: 0,
    objective: `Read proof.txt for ${marker}.`,
    why: "qualify ambiguous legacy action evidence",
    constraints: [],
    completionExpectation: "legacy side effects are not guessed",
    verificationMission: {
      goal: `Verify AH14 ambiguous ${marker}`,
      criteria: [
        {
          criterionId: "legacy-action-proof",
          requirement: "the action is not replayed without disposition proof",
          required: true,
        },
      ],
      riskRequirements: [],
    },
    provenance: { predecessorWorkId: null, reason: "AH14 pending test" },
    revision: 0,
  });
  const first = await waitForPublic(
    async () => hits,
    (value) => value.some((hit) => hit.boundary === "AH3BeforeStepAvailable"),
    25_000,
  );
  const providerTurnId = first[0]?.providerTurnId;
  if (providerTurnId === undefined) throw new Error("missing ProviderTurn");
  await fixture.crash();
  const db = new DatabaseSync(fixture.databaseFile);
  try {
    const changed = db
      .prepare(
        "UPDATE provider_attempts SET success_evidence_version = NULL WHERE provider_turn_id = ? AND outcome = 'Success' AND success_evidence_version = 'provider-success-v1'",
      )
      .run(providerTurnId);
    expect(changed.changes).toBe(1);
  } finally {
    db.close();
  }

  await fixture.restart();
  const attention = await waitForPublic(
    () =>
      client.view<{
        rows: Array<{ targetWorkspaceId: string; source: string }>;
      }>("attention", { projectId: project.projectId }),
    (value) =>
      value.rows.some(
        (row) => row.targetWorkspaceId === project.rootWorkspaceId,
      ),
    45_000,
  ).catch((error: unknown) => {
    throw new Error(
      `AH14 ambiguous legacy evidence has no durable public Attention: ${error instanceof Error ? error.message : String(error)}; providerCalls=${providerCalls}; daemon=${fixture.daemonErrors.join(" | ")}`,
    );
  });
  expect(attention.rows.length).toBeGreaterThan(0);
  expect(providerCalls).toBe(1);
  expect(fixture.daemonErrors).toEqual([]);
}, 120_000);
