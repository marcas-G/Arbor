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

describe("AH5/AH6 sourced ModelOutput and OutputAccepted atomic commit", () => {
  it("restarts after the shared commit without appending output or calling Provider twice", async () => {
    const marker = `AH56-${crypto.randomUUID().slice(0, 8)}`;
    const response = `RECOVERED ${marker}`;
    const hits: AhProbeHit[] = [];
    const fixture = await startProductionFixture({
      reply: (call) => ({
        _tag: "Text",
        text: JSON.stringify(call.messages).includes(marker)
          ? response
          : "unrelated",
      }),
      firstDaemonEntry: crashChild,
      daemonEnvironment: {
        ARBOR_AH_BOUNDARY: "AH56AfterOutputAcceptedCommit",
      },
      onDaemonStdout: (line) => recordAhProbeLine(hits, line),
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "AH5/AH6 atomic output",
    );
    await submitHumanMessage(client, project, `请回复 ${marker}`);

    try {
      await waitForPublic(
        async () => hits,
        (value) =>
          value.some((hit) => hit.boundary === "AH56AfterOutputAcceptedCommit"),
        25_000,
      );
    } catch (error) {
      throw new Error(
        `AH5/AH6 probe absent: ${error instanceof Error ? error.message : String(error)}; providerCalls=${fixture.providerCalls.length}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    }
    await fixture.crash();
    const crashed = durableSnapshot(fixture.databaseFile);
    expect(crashed.steps).toEqual([
      expect.objectContaining({
        provider_turn_id: hits[0]?.providerTurnId,
        state: "OutputAccepted",
        decoder_version: "decode-turn-v1",
        decoded_output_hash: expect.any(String),
        model_output_session_sequence: expect.any(Number),
      }),
    ]);
    expect(crashed.outputs).toEqual([
      expect.objectContaining({
        source_ref: `${hits[0]?.providerTurnId}:assistant`,
      }),
    ]);
    expect(crashed.executions).toEqual([
      expect.objectContaining({ settled_at: null }),
    ]);

    await fixture.restart();
    const transcript = await waitForPublic(
      () =>
        client.view<{
          entries: Array<{ kind: string; body?: string }>;
        }>("transcript", {
          workspaceId: project.rootWorkspaceId,
          conversationOnly: true,
          limit: 20,
        }),
      (value) =>
        value.entries.some(
          (entry) =>
            entry.kind === "AssistantConversationTurn" &&
            entry.body === response,
        ),
      45_000,
    );
    expect(
      transcript.entries.filter(
        (entry) =>
          entry.kind === "AssistantConversationTurn" && entry.body === response,
      ),
    ).toHaveLength(1);
    const recovered = durableSnapshot(fixture.databaseFile);
    expect(recovered.steps).toEqual([
      expect.objectContaining({
        decoded_output_hash: (
          crashed.steps[0] as { decoded_output_hash: string }
        ).decoded_output_hash,
        model_output_session_sequence: (
          crashed.steps[0] as { model_output_session_sequence: number }
        ).model_output_session_sequence,
      }),
    ]);
    expect(
      recovered.outputs.filter(
        (row) =>
          (row as { source_ref: string }).source_ref ===
          `${hits[0]?.providerTurnId}:assistant`,
      ),
    ).toHaveLength(1);
    expect(
      fixture.providerCalls.filter((call) =>
        JSON.stringify(call.messages).includes(marker),
      ),
    ).toHaveLength(1);
    expect(fixture.daemonErrors).toEqual([]);
  }, 90_000);
});
