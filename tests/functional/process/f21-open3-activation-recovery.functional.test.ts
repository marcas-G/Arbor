import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
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
  boundary:
    | "P11BeforeActivationCommit"
    | "P11AfterActivationCommit"
    | "GatewayCommittedBeforeP11Activation",
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

test("P12 keeps a missing persisted path Pending across two real restarts, then activates the same restored path", async () => {
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

test("P12 keeps one Pending Attention across repeated failed restarts then exact replay activates once", async () => {
  const fixture = await startProductionFixture({
    admitWorkspaceDirectory: true,
    reply: () => ({ _tag: "Text", text: "No model call expected" }),
  });
  const db = new DatabaseSync(fixture.databaseFile);
  try {
    const { client, projectId, workspaceId, commandId, envelope } =
      await makeEnvelope(fixture);
    const originalCatalog = await client.projectResources();
    const originalProfile = originalCatalog.profiles.find(
      (profile) => profile.available,
    );
    expect(originalProfile).toBeDefined();
    if (originalProfile === undefined) {
      throw new Error("initial host Profile was not available");
    }
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

    const readFacts = () => {
      const intent = db
        .prepare(
          "SELECT status, resource_boundary_revision, created_at, updated_at, activated_at FROM workspace_resource_activation_intents WHERE project_id = ? AND workspace_id = ?",
        )
        .get(projectId, workspaceId) as
        | {
            status: string;
            resource_boundary_revision: number;
            created_at: string;
            updated_at: string;
            activated_at: string | null;
          }
        | undefined;
      const eventRows = db
        .prepare(
          "SELECT event_type, payload_json FROM domain_events WHERE project_id = ? ORDER BY sequence",
        )
        .all(projectId) as unknown as ReadonlyArray<{
        event_type: string;
        payload_json: string;
      }>;
      const statuses = eventRows.map((event) => ({
        eventType: event.event_type,
        status: JSON.parse(event.payload_json).status ?? null,
      }));
      return {
        intent,
        statuses,
        command: db
          .prepare("SELECT resolution FROM commands WHERE command_id = ?")
          .get(commandId) as { resolution: string } | undefined,
        projectCount: db
          .prepare(
            "SELECT COUNT(*) AS count FROM projects WHERE project_id = ?",
          )
          .get(projectId) as { count: number },
        workspaceCount: db
          .prepare(
            "SELECT COUNT(*) AS count FROM workspaces WHERE workspace_id = ?",
          )
          .get(workspaceId) as { count: number },
        sessionCount: db
          .prepare(
            "SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?",
          )
          .get(envelope.payload.primarySession.sessionId) as { count: number },
        receiptCount: db
          .prepare(
            "SELECT COUNT(*) AS count FROM commands WHERE command_id = ?",
          )
          .get(commandId) as { count: number },
        claims: db
          .prepare(
            "SELECT COUNT(*) AS count FROM resource_ownership WHERE workspace_id = ? AND released_at IS NULL",
          )
          .get(workspaceId) as { count: number },
        attentionProjectionCount: db
          .prepare(
            "SELECT COUNT(*) AS count FROM workspace_resource_activation_attention_rows WHERE project_id = ? AND workspace_id = ?",
          )
          .get(projectId, workspaceId) as { count: number },
      };
    };

    const assertVisiblePending = async () => {
      const facts = readFacts();
      expect(facts.intent).toMatchObject({
        status: "Pending",
        resource_boundary_revision: 0,
        activated_at: null,
      });
      expect(facts.command).toEqual({ resolution: "Committed" });
      expect(facts.projectCount).toEqual({ count: 1 });
      expect(facts.workspaceCount).toEqual({ count: 1 });
      expect(facts.sessionCount).toEqual({ count: 1 });
      expect(facts.receiptCount).toEqual({ count: 1 });
      expect(facts.claims).toEqual({ count: 0 });
      expect(facts.attentionProjectionCount).toEqual({ count: 1 });
      expect(facts.statuses).toEqual([
        { eventType: "ProjectCreated", status: null },
        { eventType: "WorkspaceCreated", status: null },
        {
          eventType: "WorkspaceResourceActivationChanged",
          status: "Pending",
        },
      ]);

      const publicAttention = await client.view<{
        rows: ReadonlyArray<Record<string, unknown>>;
      }>("attention", { projectId });
      const activationRows = publicAttention.rows.filter(
        (row) => row.source === "WorkspaceResourceActivationPending",
      );
      expect(activationRows).toHaveLength(1);
      expect(activationRows[0]).toMatchObject({
        source: "WorkspaceResourceActivationPending",
        targetWorkspaceId: workspaceId,
        dedupKey: `resource-activation:${projectId}:${workspaceId}:0`,
      });
      expect(JSON.stringify(publicAttention)).not.toContain(
        fixture.workspaceDirectory,
      );
      return { facts, dedupKey: activationRows[0]?.dedupKey };
    };

    const beforeRestart = await assertVisiblePending();
    // Two separate production-daemon incarnations retry while the path fault
    // remains. Each must preserve the same single Pending source and all P1
    // facts; this is deliberately not two calls in one process.
    let changedCatalogProfileVersion: string | undefined;
    for (let restart = 1; restart <= 2; restart += 1) {
      await fixture.restart({
        daemonEnvironment: { ARBOR_PROJECT_PROFILE_VERSION: "review-v2" },
      });
      const changedCatalog = await client.projectResources();
      const replacementProfile = changedCatalog.profiles.find(
        (profile) => profile.available,
      );
      expect(replacementProfile).toBeDefined();
      if (replacementProfile === undefined) {
        throw new Error("replacement host Profile was not available");
      }
      expect(replacementProfile.resourceProfileRef).toBe(
        originalProfile.resourceProfileRef,
      );
      expect(replacementProfile.version).toBe("review-v2");
      expect(replacementProfile.version).not.toBe(originalProfile.version);
      expect(JSON.stringify(changedCatalog)).not.toContain(
        fixture.workspaceDirectory,
      );
      changedCatalogProfileVersion = replacementProfile.version;
      const afterRestart = await assertVisiblePending();
      expect(afterRestart.facts.intent).toEqual(beforeRestart.facts.intent);
      expect(afterRestart.facts.statuses).toEqual(beforeRestart.facts.statuses);
      expect(afterRestart.dedupKey).toBe(beforeRestart.dedupKey);
    }

    db.exec("DROP TRIGGER IF EXISTS fail_resource_activation");
    const replay = await fetch(`${fixture.baseUrl}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer local",
      },
      body: JSON.stringify(envelope),
    });
    const replayBody = await replay.json();
    expect(replay.status).toBe(200);
    expect(JSON.stringify(replayBody)).not.toContain(
      fixture.workspaceDirectory,
    );
    expect(fixture.providerCalls).toHaveLength(0);

    const completed = readFacts();
    expect(completed.command).toEqual({ resolution: "Committed" });
    expect(completed.projectCount).toEqual({ count: 1 });
    expect(completed.workspaceCount).toEqual({ count: 1 });
    expect(completed.sessionCount).toEqual({ count: 1 });
    expect(completed.receiptCount).toEqual({ count: 1 });
    expect(completed.intent).toMatchObject({
      status: "Active",
      resource_boundary_revision: 0,
      activated_at: expect.any(String),
    });
    expect(completed.claims).toEqual({ count: 1 });
    expect(changedCatalogProfileVersion).toBeDefined();
    const activatedClaim = db
      .prepare(
        "SELECT source_address_snapshot FROM resource_ownership WHERE workspace_id = ? AND released_at IS NULL",
      )
      .get(workspaceId) as { source_address_snapshot: string } | undefined;
    expect(activatedClaim).toBeDefined();
    if (activatedClaim === undefined) {
      throw new Error("restored activation claim was not committed");
    }
    expect(JSON.parse(activatedClaim.source_address_snapshot)).toEqual({
      _tag: "FileTree",
      path: fixture.workspaceDirectory,
    });
    expect(completed.attentionProjectionCount).toEqual({ count: 0 });
    expect(completed.statuses).toEqual([
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
    const clearedAttention = await client.view<{
      rows: ReadonlyArray<Record<string, unknown>>;
    }>("attention", { projectId });
    expect(clearedAttention.rows).not.toContainEqual(
      expect.objectContaining({
        source: "WorkspaceResourceActivationPending",
        targetWorkspaceId: workspaceId,
      }),
    );
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_resource_activation");
    db.close();
    await fixture.stop();
  }
});
