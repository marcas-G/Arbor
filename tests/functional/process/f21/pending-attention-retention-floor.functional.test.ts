// F21 Pending Attention below retention floor — moved verbatim from
// f21-open3-activation-recovery.functional.test.ts (B5 split).

import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { startProductionFixture } from "../../support/production-fixture.js";
import { makeEnvelope } from "./support.js";

test("startup restores Pending Attention below retention floor and clears it after exact replay", async () => {
  const fixture = await startProductionFixture({
    admitWorkspaceDirectory: true,
    reply: () => ({ _tag: "Text", text: "No model call expected" }),
  });
  const db = new DatabaseSync(fixture.databaseFile);
  let bodyFailed = false;
  let bodyError: unknown;
  try {
    const { client, projectId, workspaceId, commandId, envelope } =
      await makeEnvelope(fixture);
    db.exec(
      "CREATE TRIGGER fail_resource_activation BEFORE INSERT ON resource_ownership BEGIN SELECT RAISE(ABORT, 'test-injected claim failure'); END",
    );

    const failedResponse = await fetch(`${fixture.baseUrl}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer local",
      },
      body: JSON.stringify(envelope),
    });
    const failedBody = await failedResponse.text();
    expect(failedResponse.status).not.toBe(200);
    expect(failedBody).not.toContain(fixture.workspaceDirectory);

    expect(
      db
        .prepare(
          "SELECT status FROM workspace_resource_activation_intents WHERE project_id = ? AND workspace_id = ?",
        )
        .get(projectId, workspaceId),
    ).toEqual({ status: "Pending" });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM resource_ownership WHERE workspace_id = ? AND released_at IS NULL",
        )
        .get(workspaceId),
    ).toEqual({ count: 0 });

    const pendingEvent = db
      .prepare(
        "SELECT sequence FROM domain_events WHERE project_id = ? AND event_type = 'WorkspaceResourceActivationChanged' AND json_extract(payload_json, '$.status') = 'Pending'",
      )
      .get(projectId) as { sequence: number } | undefined;
    expect(pendingEvent).toBeDefined();
    if (pendingEvent === undefined) throw new Error("Pending event missing");

    // Simulate P1 journal retention of the source event and a lagging P10
    // watermark. The source-only activation reconcile must use current intent
    // truth and must not consult/reset/advance this shared offset.
    db.prepare(
      "DELETE FROM domain_events WHERE project_id = ? AND sequence = ?",
    ).run(projectId, pendingEvent.sequence);
    db.prepare(
      `INSERT INTO consumer_offsets (consumer_id, project_id, last_sequence, updated_at)
       VALUES ('p10-rebuild:attention', ?, 0, 'test-before-retention-reconcile')
       ON CONFLICT(consumer_id, project_id) DO UPDATE SET
         last_sequence = 0, updated_at = excluded.updated_at`,
    ).run(projectId);
    db.prepare(
      "DELETE FROM workspace_resource_activation_attention_rows WHERE project_id = ? AND workspace_id = ?",
    ).run(projectId, workspaceId);
    const floor = db
      .prepare(
        "SELECT MIN(sequence) AS floor FROM domain_events WHERE project_id = ?",
      )
      .get(projectId) as { floor: number };
    expect(floor.floor).toBeGreaterThan(0);
    expect(
      db
        .prepare(
          "SELECT last_sequence FROM consumer_offsets WHERE consumer_id = 'p10-rebuild:attention' AND project_id = ?",
        )
        .get(projectId),
    ).toEqual({ last_sequence: 0 });
    expect(0).toBeLessThan(floor.floor);

    await fixture.restart();
    const publicAttention = await client.view<{
      rows: ReadonlyArray<Record<string, unknown>>;
    }>("attention", { projectId });
    expect(publicAttention.rows).toContainEqual(
      expect.objectContaining({
        targetWorkspaceId: workspaceId,
        source: "WorkspaceResourceActivationPending",
      }),
    );
    expect(JSON.stringify(publicAttention)).not.toContain(
      fixture.workspaceDirectory,
    );
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM workspace_resource_activation_attention_rows WHERE project_id = ? AND workspace_id = ?",
        )
        .get(projectId, workspaceId),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT status FROM workspace_resource_activation_intents WHERE project_id = ? AND workspace_id = ?",
        )
        .get(projectId, workspaceId),
    ).toEqual({ status: "Pending" });

    // Stop the live daemon before changing the fault trigger. Startup then
    // retries the same Pending intent; the exact command replay below proves
    // the committed receipt remains idempotent after recovery.
    await fixture.restart({
      beforeStart: () =>
        db.exec("DROP TRIGGER IF EXISTS fail_resource_activation"),
    });
    expect(
      db
        .prepare(
          "SELECT status FROM workspace_resource_activation_intents WHERE project_id = ? AND workspace_id = ?",
        )
        .get(projectId, workspaceId),
    ).toEqual({ status: "Active" });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM workspace_resource_activation_attention_rows WHERE project_id = ? AND workspace_id = ?",
        )
        .get(projectId, workspaceId),
    ).toEqual({ count: 0 });
    const replay = await fetch(`${fixture.baseUrl}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer local",
      },
      body: JSON.stringify(envelope),
    });
    expect(replay.status).toBe(200);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM commands WHERE command_id = ?")
        .get(commandId),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM resource_ownership WHERE workspace_id = ? AND released_at IS NULL",
        )
        .get(workspaceId),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT status FROM workspace_resource_activation_intents WHERE project_id = ? AND workspace_id = ?",
        )
        .get(projectId, workspaceId),
    ).toEqual({ status: "Active" });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM workspace_resource_activation_attention_rows WHERE project_id = ? AND workspace_id = ?",
        )
        .get(projectId, workspaceId),
    ).toEqual({ count: 0 });
    const clearedAttention = await client.view<{
      rows: ReadonlyArray<Record<string, unknown>>;
    }>("attention", { projectId });
    expect(clearedAttention.rows).not.toContainEqual(
      expect.objectContaining({
        targetWorkspaceId: workspaceId,
        source: "WorkspaceResourceActivationPending",
      }),
    );
    expect(fixture.providerCalls).toHaveLength(0);
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  }
  const cleanupErrors: unknown[] = [];
  try {
    db.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await fixture.stop();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (bodyFailed) {
    throw bodyError;
  }
  if (cleanupErrors.length > 0) {
    throw cleanupErrors.length === 1
      ? cleanupErrors[0]
      : new AggregateError(cleanupErrors, "F21 fixture cleanup failed");
  }
});
