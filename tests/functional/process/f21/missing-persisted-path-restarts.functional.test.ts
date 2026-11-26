// F21 missing persisted path across restarts — moved verbatim from
// f21-open3-activation-recovery.functional.test.ts (B5 split).

import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import {
  makeEnvelope,
  startProbedFixture,
  waitForMarker,
  withDatabase,
} from "./support.js";

test("keeps a missing persisted path Pending across two real restarts, then activates the same restored path", async () => {
  const { fixture, markerDirectory, markerFile } = await startProbedFixture(
    "GatewayCommittedBeforeP11Activation",
  );
  const db = new DatabaseSync(fixture.databaseFile);
  const movedWorkspaceDirectory = join(fixture.directory, "workspace-offline");
  let workspaceMoved = false;
  try {
    const { client, projectId, workspaceId, commandId, envelope } =
      await makeEnvelope(fixture);
    const initialProfile = (await client.projectResources()).profiles.find(
      (profile) => profile.available,
    );
    expect(initialProfile).toBeDefined();
    if (initialProfile === undefined) {
      throw new Error("initial host Profile was not available");
    }

    const waitingRequest = fetch(`${fixture.baseUrl}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer local",
      },
      body: JSON.stringify(envelope),
    }).catch(() => undefined);
    await waitForMarker(markerFile);
    const gatewayCommitted = JSON.parse(readFileSync(markerFile, "utf8")) as {
      boundary: string;
      commandId: string;
      projectId: string;
      workspaceId: string;
    };
    expect(gatewayCommitted).toMatchObject({
      boundary: "GatewayCommittedBeforeP11Activation",
      commandId,
      projectId,
      workspaceId,
    });

    await fixture.crash();
    await waitingRequest;
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

    renameSync(fixture.workspaceDirectory, movedWorkspaceDirectory);
    workspaceMoved = true;

    let previousDedupKey: unknown;
    for (let restart = 1; restart <= 2; restart += 1) {
      await fixture.restart();
      const unavailableCatalog = await client.projectResources();
      const unavailableProfile = unavailableCatalog.profiles.find(
        (profile) =>
          profile.resourceProfileRef === initialProfile.resourceProfileRef,
      );
      expect(unavailableProfile).toMatchObject({
        available: false,
        version: initialProfile.version,
      });
      expect(JSON.stringify(unavailableCatalog)).not.toContain(
        fixture.workspaceDirectory,
      );
      expect(JSON.stringify(unavailableCatalog)).not.toContain(
        movedWorkspaceDirectory,
      );

      const state = withDatabase(fixture, (connection) => ({
        command: connection
          .prepare("SELECT resolution FROM commands WHERE command_id = ?")
          .get(commandId),
        intent: connection
          .prepare(
            "SELECT status, resource_boundary_revision FROM workspace_resource_activation_intents WHERE project_id = ? AND workspace_id = ?",
          )
          .get(projectId, workspaceId),
        projects: connection
          .prepare(
            "SELECT COUNT(*) AS count FROM projects WHERE project_id = ?",
          )
          .get(projectId),
        workspaces: connection
          .prepare(
            "SELECT COUNT(*) AS count FROM workspaces WHERE workspace_id = ?",
          )
          .get(workspaceId),
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
        projectedRows: connection
          .prepare(
            "SELECT COUNT(*) AS count FROM workspace_resource_activation_attention_rows WHERE project_id = ? AND workspace_id = ?",
          )
          .get(projectId, workspaceId),
      }));
      expect(state.command).toEqual({ resolution: "Committed" });
      expect(state.intent).toEqual({
        status: "Pending",
        resource_boundary_revision: 0,
      });
      expect(state.projects).toEqual({ count: 1 });
      expect(state.workspaces).toEqual({ count: 1 });
      expect(state.claims).toEqual({ count: 0 });
      expect(state.events).toEqual([
        { eventType: "ProjectCreated", status: null },
        { eventType: "WorkspaceCreated", status: null },
        {
          eventType: "WorkspaceResourceActivationChanged",
          status: "Pending",
        },
      ]);
      expect(state.projectedRows).toEqual({ count: 1 });

      const attention = await client.view<{
        rows: ReadonlyArray<Record<string, unknown>>;
      }>("attention", { projectId });
      const rows = attention.rows.filter(
        (row) => row.source === "WorkspaceResourceActivationPending",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source: "WorkspaceResourceActivationPending",
        targetWorkspaceId: workspaceId,
        dedupKey: `resource-activation:${projectId}:${workspaceId}:0`,
      });
      if (restart > 1) expect(rows[0]?.dedupKey).toBe(previousDedupKey);
      previousDedupKey = rows[0]?.dedupKey;
      expect(JSON.stringify(attention)).not.toContain(
        fixture.workspaceDirectory,
      );
    }

    renameSync(movedWorkspaceDirectory, fixture.workspaceDirectory);
    workspaceMoved = false;
    await fixture.restart();
    const restoredCatalog = await client.projectResources();
    expect(
      restoredCatalog.profiles.find(
        (profile) =>
          profile.resourceProfileRef === initialProfile.resourceProfileRef,
      ),
    ).toMatchObject({
      available: true,
      version: initialProfile.version,
    });
    const recovered = withDatabase(fixture, (connection) => ({
      intent: connection
        .prepare(
          "SELECT status, resource_boundary_revision FROM workspace_resource_activation_intents WHERE project_id = ? AND workspace_id = ?",
        )
        .get(projectId, workspaceId),
      commandCount: connection
        .prepare("SELECT COUNT(*) AS count FROM commands WHERE command_id = ?")
        .get(commandId),
      projectCount: connection
        .prepare("SELECT COUNT(*) AS count FROM projects WHERE project_id = ?")
        .get(projectId),
      workspaceCount: connection
        .prepare(
          "SELECT COUNT(*) AS count FROM workspaces WHERE workspace_id = ?",
        )
        .get(workspaceId),
      claims: connection
        .prepare(
          "SELECT source_address_snapshot FROM resource_ownership WHERE workspace_id = ? AND released_at IS NULL",
        )
        .all(workspaceId) as unknown as ReadonlyArray<{
        source_address_snapshot: string;
      }>,
      statuses: connection
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
    expect(recovered.commandCount).toEqual({ count: 1 });
    expect(recovered.projectCount).toEqual({ count: 1 });
    expect(recovered.workspaceCount).toEqual({ count: 1 });
    expect(recovered.claims).toHaveLength(1);
    const restoredClaim = recovered.claims[0];
    expect(restoredClaim).toBeDefined();
    if (restoredClaim === undefined) {
      throw new Error("restored activation claim was not committed");
    }
    expect(JSON.parse(restoredClaim.source_address_snapshot)).toEqual({
      _tag: "FileTree",
      path: fixture.workspaceDirectory,
    });
    expect(recovered.statuses).toEqual([
      { eventType: "ProjectCreated", status: null },
      { eventType: "WorkspaceCreated", status: null },
      {
        eventType: "WorkspaceResourceActivationChanged",
        status: "Pending",
      },
      {
        eventType: "WorkspaceResourceActivationChanged",
        status: "Active",
      },
    ]);
    expect(recovered.attentionCount).toEqual({ count: 0 });
    expect(fixture.providerCalls).toHaveLength(0);
    const cleared = await client.view<{
      rows: ReadonlyArray<Record<string, unknown>>;
    }>("attention", { projectId });
    expect(cleared.rows).not.toContainEqual(
      expect.objectContaining({
        source: "WorkspaceResourceActivationPending",
        targetWorkspaceId: workspaceId,
      }),
    );
  } finally {
    if (workspaceMoved && existsSync(movedWorkspaceDirectory)) {
      renameSync(movedWorkspaceDirectory, fixture.workspaceDirectory);
    }
    db.close();
    await fixture.stop();
    rmSync(markerDirectory, { recursive: true, force: true });
  }
});
