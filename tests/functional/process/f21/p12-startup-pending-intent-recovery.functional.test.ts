// F21 P12 Pending intent startup recovery — moved verbatim from
// f21-open3-activation-recovery.functional.test.ts (B5 split).

import { readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import {
  makeEnvelope,
  startProbedFixture,
  waitForMarker,
  withDatabase,
} from "./support.js";

test("P12 startup auto-recovers a Gateway-committed Pending intent without client resend", async () => {
  const { fixture, markerDirectory, markerFile } = await startProbedFixture(
    "GatewayCommittedBeforeP11Activation",
  );
  const db = new DatabaseSync(fixture.databaseFile);
  try {
    const { client, projectId, workspaceId, commandId, sessionId, envelope } =
      await makeEnvelope(fixture);
    const waitingRequest = fetch(`${fixture.baseUrl}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer local",
      },
      body: JSON.stringify(envelope),
    }).catch(() => undefined);
    await waitForMarker(markerFile);
    const marker = JSON.parse(readFileSync(markerFile, "utf8")) as {
      boundary: string;
      commandId: string;
      projectId: string;
      workspaceId: string;
    };
    expect(marker).toEqual({
      boundary: "GatewayCommittedBeforeP11Activation",
      commandId,
      projectId,
      workspaceId,
    });

    const committedBeforeKill = withDatabase(fixture, (connection) => ({
      command: connection
        .prepare("SELECT resolution FROM commands WHERE command_id = ?")
        .get(commandId),
      intent: connection
        .prepare(
          "SELECT status FROM workspace_resource_activation_intents WHERE project_id = ? AND workspace_id = ?",
        )
        .get(projectId, workspaceId),
      entities: [
        connection
          .prepare(
            "SELECT COUNT(*) AS count FROM projects WHERE project_id = ?",
          )
          .get(projectId),
        connection
          .prepare(
            "SELECT COUNT(*) AS count FROM workspaces WHERE workspace_id = ?",
          )
          .get(workspaceId),
        connection
          .prepare(
            "SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?",
          )
          .get(sessionId),
      ],
      claims: connection
        .prepare(
          "SELECT COUNT(*) AS count FROM resource_ownership WHERE workspace_id = ? AND released_at IS NULL",
        )
        .get(workspaceId),
      events: connection
        .prepare(
          "SELECT event_type, payload_json FROM domain_events WHERE project_id = ? ORDER BY sequence",
        )
        .all(projectId)
        .map((row) => {
          const event = row as { event_type: string; payload_json: string };
          return {
            eventType: event.event_type,
            status: JSON.parse(event.payload_json).status ?? null,
          };
        }),
    }));
    expect(committedBeforeKill.command).toEqual({ resolution: "Committed" });
    expect(committedBeforeKill.intent).toEqual({ status: "Pending" });
    expect(committedBeforeKill.entities).toEqual([
      { count: 1 },
      { count: 1 },
      { count: 1 },
    ]);
    expect(committedBeforeKill.claims).toEqual({ count: 0 });
    expect(committedBeforeKill.events).toEqual([
      { eventType: "ProjectCreated", status: null },
      { eventType: "WorkspaceCreated", status: null },
      {
        eventType: "WorkspaceResourceActivationChanged",
        status: "Pending",
      },
    ]);

    await fixture.crash();
    await waitingRequest;
    const afterKill = withDatabase(fixture, (connection) => ({
      intent: connection
        .prepare(
          "SELECT status FROM workspace_resource_activation_intents WHERE project_id = ? AND workspace_id = ?",
        )
        .get(projectId, workspaceId),
      claims: connection
        .prepare(
          "SELECT COUNT(*) AS count FROM resource_ownership WHERE workspace_id = ? AND released_at IS NULL",
        )
        .get(workspaceId),
      commandCount: connection
        .prepare("SELECT COUNT(*) AS count FROM commands WHERE command_id = ?")
        .get(commandId),
    }));
    expect(afterKill).toEqual({
      intent: { status: "Pending" },
      claims: { count: 0 },
      commandCount: { count: 1 },
    });

    // Startup recovery, not an HTTP resend, activates the exact persisted
    // Workspace boundary and clears the source-only Attention.
    await fixture.restart();
    const recovered = withDatabase(fixture, (connection) => ({
      intent: connection
        .prepare(
          "SELECT status, resource_boundary_revision FROM workspace_resource_activation_intents WHERE project_id = ? AND workspace_id = ?",
        )
        .get(projectId, workspaceId),
      claims: connection
        .prepare(
          "SELECT source_address_snapshot FROM resource_ownership WHERE workspace_id = ? AND released_at IS NULL",
        )
        .all(workspaceId) as unknown as ReadonlyArray<{
        source_address_snapshot: string;
      }>,
      commandCount: connection
        .prepare("SELECT COUNT(*) AS count FROM commands WHERE command_id = ?")
        .get(commandId),
      events: connection
        .prepare(
          "SELECT event_type, payload_json FROM domain_events WHERE project_id = ? ORDER BY sequence",
        )
        .all(projectId)
        .map((row) => {
          const event = row as { event_type: string; payload_json: string };
          return {
            eventType: event.event_type,
            status: JSON.parse(event.payload_json).status ?? null,
          };
        }),
      attentionCount: connection
        .prepare(
          "SELECT COUNT(*) AS count FROM workspace_resource_activation_attention_rows WHERE project_id = ? AND workspace_id = ?",
        )
        .get(projectId, workspaceId),
    }));
    expect(recovered.intent).toEqual({
      status: "Active",
      resource_boundary_revision: 0,
    });
    expect(recovered.claims).toHaveLength(1);
    const recoveredClaim = recovered.claims[0];
    expect(recoveredClaim).toBeDefined();
    if (recoveredClaim === undefined) {
      throw new Error("restored activation claim was not committed");
    }
    expect(JSON.parse(recoveredClaim.source_address_snapshot)).toEqual({
      _tag: "FileTree",
      path: fixture.workspaceDirectory,
    });
    expect(recovered.commandCount).toEqual({ count: 1 });
    expect(recovered.events.map((event) => event.status)).toEqual([
      null,
      null,
      "Pending",
      "Active",
    ]);
    expect(recovered.attentionCount).toEqual({ count: 0 });
    const attention = await client.view<{
      rows: ReadonlyArray<Record<string, unknown>>;
    }>("attention", { projectId });
    expect(attention.rows).not.toContainEqual(
      expect.objectContaining({
        source: "WorkspaceResourceActivationPending",
        targetWorkspaceId: workspaceId,
      }),
    );
    expect(JSON.stringify(attention)).not.toContain(fixture.workspaceDirectory);
    expect(fixture.providerCalls).toHaveLength(0);
  } finally {
    db.close();
    await fixture.stop();
    rmSync(markerDirectory, { recursive: true, force: true });
  }
});
