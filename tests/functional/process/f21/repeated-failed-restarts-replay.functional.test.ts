// F21 Pending Attention across repeated failed restarts — moved verbatim from
// f21-open3-activation-recovery.functional.test.ts (B5 split).

import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { startProductionFixture } from "../../support/production-fixture.js";
import { makeEnvelope } from "./support.js";

test("P12 keeps one Pending Attention across repeated failed restarts then exact replay activates once", async () => {
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

    // Keep Attention Pending through both failed restarts, then remove the
    // fault only after the current daemon is stopped. Startup recovery clears
    // Attention; exact replay below confirms the original receipt still wins.
    await fixture.restart({
      beforeStart: () =>
        db.exec("DROP TRIGGER IF EXISTS fail_resource_activation"),
    });
    const recoveredBeforeReplay = readFacts();
    expect(recoveredBeforeReplay.intent).toMatchObject({
      status: "Active",
      resource_boundary_revision: 0,
      activated_at: expect.any(String),
    });
    expect(recoveredBeforeReplay.claims).toEqual({ count: 1 });
    expect(recoveredBeforeReplay.attentionProjectionCount).toEqual({
      count: 0,
    });
    const attentionAfterRecovery = await client.view<{
      rows: ReadonlyArray<Record<string, unknown>>;
    }>("attention", { projectId });
    expect(attentionAfterRecovery.rows).not.toContainEqual(
      expect.objectContaining({
        source: "WorkspaceResourceActivationPending",
        targetWorkspaceId: workspaceId,
      }),
    );
    const replay = await fetch(`${fixture.baseUrl}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer local",
      },
      body: JSON.stringify(envelope),
    });
    const replayBody = await replay.json();
    const replayReceipt =
      typeof replayBody === "object" &&
      replayBody !== null &&
      "body" in replayBody
        ? replayBody.body
        : undefined;
    expect(replay.status).toBe(200);
    expect(replayReceipt).toEqual({
      commandId,
      resolution: "Committed",
      result: {
        projectId,
        rootWorkspaceId: workspaceId,
        primarySessionId: envelope.payload.primarySession.sessionId,
      },
    });
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
