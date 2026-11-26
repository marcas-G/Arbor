// F21 exclusive Profile ownership admission — moved verbatim from
// f21-open3-activation-recovery.functional.test.ts (B5 split).
import { expect, test } from "vitest";
import { startProductionFixture } from "../../support/production-fixture.js";
import { makeEnvelope, withDatabase } from "./support.js";

test("CreateProject reports its committed receipt when an identical Profile is already exclusively owned", async () => {
  const fixture = await startProductionFixture({
    admitWorkspaceDirectory: true,
    reply: () => ({ _tag: "Text", text: "No model call expected" }),
  });
  try {
    const first = await makeEnvelope(fixture);
    const second = await makeEnvelope(fixture);
    const submit = async (envelope: (typeof first)["envelope"]) => {
      const response = await fetch(`${fixture.baseUrl}/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer local",
        },
        body: JSON.stringify(envelope),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    };

    const firstResponse = await submit(first.envelope);
    expect(firstResponse).toMatchObject({
      status: 200,
      body: { ok: true, body: { resolution: "Committed" } },
    });

    // Both Projects select the same trusted Profile. The first receives the
    // exclusive ownership claim; the second remains a durable Pending
    // activation and is never presented as an uncommitted/network failure.
    const secondResponse = await submit(second.envelope);
    expect(secondResponse).toMatchObject({
      status: 200,
      body: { ok: true, body: { resolution: "Committed" } },
    });
    expect(secondResponse.body).not.toHaveProperty("problem");

    const persisted = withDatabase(fixture, (db) => ({
      command: db
        .prepare(
          "SELECT resolution, result_json FROM commands WHERE command_id = ?",
        )
        .get(second.commandId) as
        | { resolution: string; result_json: string }
        | undefined,
      projectCount: db
        .prepare("SELECT COUNT(*) AS count FROM projects")
        .get() as { count: number },
      workspaceCount: db
        .prepare("SELECT COUNT(*) AS count FROM workspaces")
        .get() as { count: number },
      secondIntent: db
        .prepare(
          "SELECT status FROM workspace_resource_activation_intents WHERE project_id = ? AND workspace_id = ?",
        )
        .get(second.projectId, second.workspaceId) as
        | { status: string }
        | undefined,
      claims: db
        .prepare(
          "SELECT workspace_id FROM resource_ownership WHERE released_at IS NULL",
        )
        .all()
        .map((row) =>
          typeof row.workspace_id === "string" ? row.workspace_id : null,
        ),
      events: db
        .prepare(
          "SELECT event_type FROM domain_events WHERE project_id = ? ORDER BY sequence",
        )
        .all(second.projectId)
        .map((row) =>
          typeof row.event_type === "string" ? row.event_type : null,
        ),
    }));
    expect(persisted.command?.resolution).toBe("Committed");
    expect(JSON.parse(persisted.command?.result_json ?? "null")).toEqual({
      projectId: second.projectId,
      rootWorkspaceId: second.workspaceId,
      primarySessionId: second.envelope.payload.primarySession.sessionId,
    });
    expect(persisted.projectCount.count).toBe(2);
    expect(persisted.workspaceCount.count).toBe(2);
    expect(persisted.secondIntent).toEqual({ status: "Pending" });
    expect(persisted.claims).toEqual([first.workspaceId]);
    expect(persisted.events).toEqual([
      "ProjectCreated",
      "WorkspaceCreated",
      "WorkspaceResourceActivationChanged",
    ]);

    const attention = await second.client.view<{
      rows: ReadonlyArray<Record<string, unknown>>;
    }>("attention", { projectId: second.projectId });
    expect(attention.rows).toContainEqual(
      expect.objectContaining({
        source: "WorkspaceResourceActivationPending",
        targetWorkspaceId: second.workspaceId,
      }),
    );

    const replay = await submit(second.envelope);
    expect(replay).toEqual(secondResponse);
    const afterReplay = withDatabase(fixture, (db) => ({
      projectCount: db.prepare("SELECT COUNT(*) AS count FROM projects").get(),
      commandCount: db
        .prepare("SELECT COUNT(*) AS count FROM commands WHERE command_id = ?")
        .get(second.commandId),
      eventCount: db
        .prepare(
          "SELECT COUNT(*) AS count FROM domain_events WHERE project_id = ?",
        )
        .get(second.projectId),
    }));
    expect(afterReplay.projectCount).toEqual({ count: 2 });
    expect(afterReplay.commandCount).toEqual({ count: 1 });
    expect(afterReplay.eventCount).toEqual({ count: 3 });
    expect(fixture.providerCalls).toHaveLength(0);
  } finally {
    await fixture.stop();
  }
});
