// F21 P11 activation kill/restart convergence — moved verbatim from
// f21-open3-activation-recovery.functional.test.ts (B5 split).

import { readFileSync, rmSync } from "node:fs";
import { expect, test } from "vitest";
import {
  makeEnvelope,
  startProbedFixture,
  waitForMarker,
  withDatabase,
} from "./support.js";

test.each(["P11BeforeActivationCommit", "P11AfterActivationCommit"] as const)(
  "P11 %s kill/restart converges exact activation facts",
  async (boundary) => {
    const { fixture, markerDirectory, markerFile } =
      await startProbedFixture(boundary);
    try {
      const { client, projectId, workspaceId, commandId, envelope } =
        await makeEnvelope(fixture);
      const responseBeforeKill = fetch(`${fixture.baseUrl}/commands`, {
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
        projectId: string;
        workspaceId: string;
        resourceBoundaryRevision: number;
      };
      expect(marker).toMatchObject({ boundary, projectId, workspaceId });

      await fixture.crash();
      // The first daemon is intentionally held inside afterCommitted, so this
      // public request cannot receive its response until the process is killed.
      await responseBeforeKill;
      const killed = withDatabase(fixture, (db) => ({
        intent: db
          .prepare(
            "SELECT status FROM workspace_resource_activation_intents WHERE project_id = ? AND workspace_id = ?",
          )
          .get(projectId, workspaceId) as { status: string } | undefined,
        claims: db
          .prepare(
            "SELECT COUNT(*) AS count FROM resource_ownership WHERE workspace_id = ? AND released_at IS NULL",
          )
          .get(workspaceId) as { count: number },
        activationStatuses: db
          .prepare(
            "SELECT payload_json FROM domain_events WHERE aggregate_ref = ? AND event_type = 'WorkspaceResourceActivationChanged' ORDER BY sequence",
          )
          .all(workspaceId)
          .map(
            (row) =>
              JSON.parse((row as { payload_json: string }).payload_json).status,
          ),
        command: db
          .prepare("SELECT resolution FROM commands WHERE command_id = ?")
          .get(commandId) as { resolution: string } | undefined,
      }));
      expect(killed.command?.resolution).toBe("Committed");
      if (boundary === "P11BeforeActivationCommit") {
        expect(killed.intent?.status).toBe("Pending");
        expect(killed.claims.count).toBe(0);
        expect(killed.activationStatuses).toEqual(["Pending"]);
      } else {
        expect(killed.intent?.status).toBe("Active");
        expect(killed.claims.count).toBe(1);
        expect(killed.activationStatuses).toEqual(["Pending", "Active"]);
        // Model the durable-but-not-yet-reconciled row at the exact after-commit
        // boundary. Startup must delete it from current Active intent truth.
        withDatabase(fixture, (db) => {
          db.prepare(
            `INSERT INTO workspace_resource_activation_attention_rows
            (project_id, workspace_id, resource_boundary_revision, occurred_at)
           VALUES (?, ?, ?, 'test-stale-pending-row')`,
          ).run(projectId, workspaceId, marker.resourceBoundaryRevision);
        });
      }

      await fixture.restart();
      const recovered = withDatabase(fixture, (db) => ({
        intent: db
          .prepare(
            "SELECT status FROM workspace_resource_activation_intents WHERE project_id = ? AND workspace_id = ?",
          )
          .get(projectId, workspaceId) as { status: string } | undefined,
        claims: db
          .prepare(
            "SELECT COUNT(*) AS count FROM resource_ownership WHERE workspace_id = ? AND released_at IS NULL",
          )
          .get(workspaceId) as { count: number },
        activationStatuses: db
          .prepare(
            "SELECT payload_json FROM domain_events WHERE aggregate_ref = ? AND event_type = 'WorkspaceResourceActivationChanged' ORDER BY sequence",
          )
          .all(workspaceId)
          .map(
            (row) =>
              JSON.parse((row as { payload_json: string }).payload_json).status,
          ),
        staleAttention: db
          .prepare(
            "SELECT COUNT(*) AS count FROM workspace_resource_activation_attention_rows WHERE project_id = ? AND workspace_id = ?",
          )
          .get(projectId, workspaceId) as { count: number },
        commandCount: db
          .prepare(
            "SELECT COUNT(*) AS count FROM commands WHERE command_id = ?",
          )
          .get(commandId) as { count: number },
        eventCount: db
          .prepare(
            "SELECT COUNT(*) AS count FROM domain_events WHERE aggregate_ref IN (?, ?) AND event_type IN ('ProjectCreated', 'WorkspaceCreated', 'WorkspaceResourceActivationChanged')",
          )
          .get(projectId, workspaceId) as { count: number },
      }));
      expect(recovered.intent?.status).toBe("Active");
      expect(recovered.claims.count).toBe(1);
      expect(recovered.activationStatuses).toEqual(["Pending", "Active"]);
      expect(recovered.staleAttention.count).toBe(0);
      expect(recovered.commandCount.count).toBe(1);
      expect(recovered.eventCount.count).toBe(4);
      expect(fixture.providerCalls).toHaveLength(0);

      const attention = await client.view<{ rows: ReadonlyArray<unknown> }>(
        "attention",
        { projectId },
      );
      expect(JSON.stringify(attention)).not.toContain(
        fixture.workspaceDirectory,
      );
    } finally {
      await fixture.stop();
      rmSync(markerDirectory, { recursive: true, force: true });
    }
  },
);
