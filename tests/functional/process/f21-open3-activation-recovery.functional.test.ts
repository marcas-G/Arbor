import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import { functionalId, makePublicClient } from "../support/public-client.js";

const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
const activationDaemonChild = join(
  repositoryRoot,
  "tests",
  "functional",
  "support",
  "f21-activation-daemon-child.mjs",
);

const waitForMarker = async (markerFile: string) => {
  const startedAt = Date.now();
  while (!existsSync(markerFile)) {
    if (Date.now() - startedAt > 60_000) {
      throw new Error(
        `timed out waiting for P11 activation marker ${markerFile}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const makeEnvelope = async (fixture: ProductionFixture) => {
  const client = makePublicClient(fixture.baseUrl);
  const catalog = await client.projectResources();
  const profile = catalog.profiles.find((candidate) => candidate.available);
  expect(profile).toBeDefined();
  if (profile === undefined) throw new Error("host Profile was not listed");
  expect(JSON.stringify(catalog)).not.toContain(fixture.workspaceDirectory);

  const projectId = functionalId("prj");
  const workspaceId = functionalId("ws");
  const sessionId = functionalId("ses");
  const commandId = functionalId("cmd");
  return {
    client,
    projectId,
    workspaceId,
    sessionId,
    commandId,
    envelope: {
      commandType: "CreateProject",
      commandId,
      projectId,
      actor: "user:local",
      issuedAt: "2026-10-10T00:00:00.000Z",
      payload: {
        name: "F21 OPEN-3 activation process recovery",
        revision: 0,
        projectPolicy: { delegationCeiling: 1 },
        projectPolicyRevision: 0,
        defaultConfiguration: {},
        environmentRef: "local",
        rootWorkspaceId: workspaceId,
        primarySession: { sessionId, contextEpoch: 0 },
        rootWorkspace: {
          name: "root",
          responsibilityDefinition: {
            purpose: "F21 OPEN-3 activation process recovery",
            ownedResponsibilities: [],
            obligations: [],
            includes: [],
            excludes: [],
            interfaces: [],
          },
          responsibilityRevision: 0,
          resourceSelection: {
            _tag: "Profile",
            resourceProfileRef: profile.resourceProfileRef,
            version: profile.version,
          },
          agentBinding: {
            _tag: "ResponsibilityBoundAgentBinding",
            workspaceId,
          },
          workspacePolicy: { delegationCeiling: 1 },
          workspacePolicyRevision: 0,
          revision: 0,
        },
      },
    },
  };
};

const withDatabase = <A>(
  fixture: ProductionFixture,
  run: (db: DatabaseSync) => A,
) => {
  const db = new DatabaseSync(fixture.databaseFile);
  try {
    return run(db);
  } finally {
    db.close();
  }
};

const startProbedFixture = async (
  boundary: "P11BeforeActivationCommit" | "P11AfterActivationCommit",
) => {
  const markerDirectory = mkdtempSync(join(tmpdir(), "arbor-f21-activation-"));
  const markerFile = join(markerDirectory, "activation.marker");
  const fixture = await startProductionFixture({
    admitWorkspaceDirectory: true,
    firstDaemonEntry: activationDaemonChild,
    daemonEnvironment: {
      F21_ACTIVATION_PROBE_BOUNDARY: boundary,
      F21_ACTIVATION_MARKER: markerFile,
    },
    reply: () => ({ _tag: "Text", text: "No model call expected" }),
  });
  return { fixture, markerDirectory, markerFile };
};

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

test("P12 startup restores Pending Attention below retention floor and clears it after exact replay", async () => {
  const fixture = await startProductionFixture({
    admitWorkspaceDirectory: true,
    reply: () => ({ _tag: "Text", text: "No model call expected" }),
  });
  const db = new DatabaseSync(fixture.databaseFile);
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

    db.exec("DROP TRIGGER IF EXISTS fail_resource_activation");
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
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_resource_activation");
    db.close();
    await fixture.stop();
  }
});
