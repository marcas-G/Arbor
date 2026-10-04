import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
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

const durableSnapshot = (databaseFile: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      executions: db
        .prepare(
          "SELECT execution_id, stop_requested_at, settled_at FROM executions",
        )
        .all(),
      leases: db
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases",
        )
        .all(),
      steps: db
        .prepare("SELECT execution_id, state, revision FROM agent_loop_steps")
        .all(),
      providerTurns: db
        .prepare(
          "SELECT provider_turn_id, settled_at, finish_reason FROM provider_turns",
        )
        .all(),
      attempts: db
        .prepare(
          "SELECT provider_turn_id, attempt_no, outcome, settled_at, success_evidence_version FROM provider_attempts",
        )
        .all(),
      outputs: db
        .prepare(
          "SELECT source_ref FROM session_entries WHERE entry_kind = 'ModelOutput'",
        )
        .all(),
      events: db
        .prepare("SELECT event_type, aggregate_ref FROM domain_events")
        .all(),
      timers: db.prepare("SELECT * FROM scheduler_timers").all(),
    };
  } finally {
    db.close();
  }
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("AH1–AH3 Provider success handoff process crash", () => {
  it("AH1/2 before atomic Success commit leaves no half-settled Turn or accepted output", async () => {
    const marker = `AH12-PRE-${crypto.randomUUID().slice(0, 8)}`;
    const response = `RECOVERED ${marker}`;
    const hits: Array<{ boundary: string; providerTurnId: string }> = [];
    const fixture = await startProductionFixture({
      reply: (call) => ({
        _tag: "Text",
        text: JSON.stringify(call.messages).includes(marker)
          ? response
          : "unrelated",
      }),
      firstDaemonEntry: crashChild,
      daemonEnvironment: {
        ARBOR_AH_BOUNDARY: "AH12BeforeSuccessCommit",
      },
      onDaemonStdout: (line) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "tag" in parsed &&
          parsed.tag === "AH_PROBE" &&
          "boundary" in parsed &&
          parsed.boundary === "AH12BeforeSuccessCommit" &&
          "providerTurnId" in parsed &&
          typeof parsed.providerTurnId === "string"
        ) {
          hits.push({
            boundary: parsed.boundary,
            providerTurnId: parsed.providerTurnId,
          });
        }
      },
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "AH1/2 pre-commit",
    );
    await submitHumanMessage(client, project, `请回复 ${marker}`);
    await waitForPublic(
      async () => hits.length,
      (count) => count === 1,
    );
    await fixture.crash();
    const crashed = durableSnapshot(fixture.databaseFile);
    expect(crashed.providerTurns).toEqual([
      expect.objectContaining({
        provider_turn_id: hits[0]?.providerTurnId,
        settled_at: null,
      }),
    ]);
    expect(crashed.attempts).toEqual([
      expect.objectContaining({
        outcome: "InProgress",
        settled_at: null,
        success_evidence_version: null,
      }),
    ]);
    expect(crashed.steps).toEqual([
      expect.objectContaining({ state: "Prepared" }),
    ]);
    expect(crashed.outputs).toEqual([]);

    await fixture.restart();
    const recovered = await waitForPublic(
      async () => durableSnapshot(fixture.databaseFile),
      (value) =>
        value.providerTurns.length > 0 &&
        value.providerTurns[0]?.settled_at !== null,
      45_000,
    );
    expect(
      recovered.attempts.some(
        (attempt) => (attempt as { outcome: string }).outcome === "Success",
      ),
    ).toBe(false);
    expect(recovered.providerTurns).toEqual([
      expect.objectContaining({ finish_reason: "Failed" }),
    ]);
    expect(recovered.attempts).toEqual([
      expect.objectContaining({ outcome: "TerminalFailure" }),
    ]);
    expect(
      recovered.outputs.some(
        (output) =>
          (output as { source_ref: string }).source_ref ===
          hits[0]?.providerTurnId,
      ),
    ).toBe(false);
    expect(fixture.providerCalls.length).toBeLessThanOrEqual(2);
    expect(fixture.daemonErrors).toEqual([]);
  }, 90_000);

  for (const boundary of [
    "AH12AfterSuccessCommit",
    "AH3BeforeStepAvailable",
    "AH3AfterStepAvailable",
  ] as const) {
    it(`recovers after process kill at ${boundary} without another Provider request`, async () => {
      const marker = `AH3-${crypto.randomUUID().slice(0, 8)}`;
      const response = `RECOVERED ${marker}`;
      const hits: Array<{ boundary: string; providerTurnId: string }> = [];
      const fixture = await startProductionFixture({
        reply: (call) => ({
          _tag: "Text",
          text: JSON.stringify(call.messages).includes(marker)
            ? response
            : "unrelated",
        }),
        firstDaemonEntry: crashChild,
        daemonEnvironment: { ARBOR_AH_BOUNDARY: boundary },
        onDaemonStdout: (line) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            return;
          }
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            "tag" in parsed &&
            parsed.tag === "AH_PROBE" &&
            "boundary" in parsed &&
            typeof parsed.boundary === "string" &&
            "providerTurnId" in parsed &&
            typeof parsed.providerTurnId === "string"
          ) {
            hits.push({
              boundary: parsed.boundary,
              providerTurnId: parsed.providerTurnId,
            });
          }
        },
      });
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `AH3 ${boundary}`,
      );

      await submitHumanMessage(client, project, `请回复 ${marker}`);
      let observed: typeof hits;
      try {
        observed = await waitForPublic(
          async () => hits,
          (value) => value.some((hit) => hit.boundary === boundary),
          25_000,
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; providerCalls=${fixture.providerCalls.length}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      }
      expect(observed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            boundary,
            providerTurnId: expect.stringMatching(/^ptn_/u),
          }),
        ]),
      );

      await fixture.crash();
      const crashed = durableSnapshot(fixture.databaseFile);
      expect(crashed.providerTurns).toEqual([
        expect.objectContaining({
          provider_turn_id: observed[0]?.providerTurnId,
          settled_at: expect.any(String),
        }),
      ]);
      expect(
        Date.parse((crashed.leases[0] as { expires_at: string }).expires_at),
      ).toBeGreaterThan(Date.now());
      expect(crashed.steps).toEqual([
        expect.objectContaining({
          state:
            boundary === "AH3AfterStepAvailable"
              ? "ProviderResultAvailable"
              : "Prepared",
        }),
      ]);
      try {
        await fixture.restart();
      } catch (error) {
        throw new Error(
          `AH3 restart failed: ${error instanceof Error ? error.message : String(error)}; hits=${JSON.stringify(hits)}; providerCalls=${fixture.providerCalls.length}; crashed=${JSON.stringify(crashed)}; after=${JSON.stringify(durableSnapshot(fixture.databaseFile))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      }
      let transcript: {
        entries: Array<{ kind: string; body?: string }>;
      };
      try {
        transcript = await waitForPublic(
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
      } catch (error) {
        throw new Error(
          `AH3 recovery failed: ${error instanceof Error ? error.message : String(error)}; hits=${JSON.stringify(hits)}; providerCalls=${fixture.providerCalls.length}; crashed=${JSON.stringify(crashed)}; after=${JSON.stringify(durableSnapshot(fixture.databaseFile))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      }
      expect(
        transcript.entries.filter(
          (entry) =>
            entry.kind === "AssistantConversationTurn" &&
            entry.body === response,
        ),
      ).toHaveLength(1);
      expect(
        fixture.providerCalls.filter((call) =>
          JSON.stringify(call.messages).includes(marker),
        ),
      ).toHaveLength(1);
      expect(durableSnapshot(fixture.databaseFile).executions).toEqual([
        expect.objectContaining({ settled_at: expect.any(String) }),
      ]);
      expect(fixture.daemonErrors).toEqual([]);
    }, 90_000);
  }
});
