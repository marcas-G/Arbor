// F21 exact replay online activation — moved verbatim from
// f21-open3-activation-recovery.functional.test.ts (B5 split).

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../../support/production-fixture.js";
import {
  activationDaemonChild,
  makeEnvelope,
  waitForMarker,
} from "./support.js";

test("exact replay activates restored path online in the same daemon", async () => {
  const markerDirectory = mkdtempSync(
    join(tmpdir(), "arbor-f21-online-replay-"),
  );
  const markerFile = join(markerDirectory, "activation.marker");
  const releaseFile = join(markerDirectory, "activation.release");
  let fixture: ProductionFixture | undefined;
  let db: DatabaseSync | undefined;
  let movedWorkspaceDirectory: string | undefined;
  let workspaceMoved = false;
  let bodyFailed = false;
  let bodyError: unknown;
  try {
    fixture = await startProductionFixture({
      admitWorkspaceDirectory: true,
      firstDaemonEntry: activationDaemonChild,
      daemonEnvironment: {
        F21_ACTIVATION_PROBE_BOUNDARY:
          "GatewayCommittedBeforeP11ActivationReleasable",
        F21_ACTIVATION_MARKER: markerFile,
        F21_ACTIVATION_RELEASE: releaseFile,
      },
      reply: () => ({ _tag: "Text", text: "No model call expected" }),
    });
    movedWorkspaceDirectory = join(fixture.directory, "workspace-offline");
    db = new DatabaseSync(fixture.databaseFile);
    const { client, projectId, workspaceId, commandId, envelope } =
      await makeEnvelope(fixture);
    const initialProcess = fixture.daemonProcessSnapshot();
    expect(initialProcess?.pid).toBeDefined();
    expect(initialProcess?.alive).toBe(true);

    const request = fetch(`${fixture.baseUrl}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer local",
      },
      body: JSON.stringify(envelope),
    });
    await waitForMarker(markerFile);
    const marker = JSON.parse(readFileSync(markerFile, "utf8")) as {
      boundary: string;
      commandId: string;
      projectId: string;
      workspaceId: string;
    };
    expect(marker).toEqual({
      boundary: "GatewayCommittedBeforeP11ActivationReleasable",
      commandId,
      projectId,
      workspaceId,
    });

    // The post-commit test gate keeps this daemon alive before P11 activation.
    // Make the persisted path unavailable only for the first activation attempt.
    renameSync(fixture.workspaceDirectory, movedWorkspaceDirectory);
    workspaceMoved = true;
    writeFileSync(releaseFile, "continue", "utf8");
    const failedResponse = await request;
    expect(failedResponse.status).not.toBe(200);
    const pidAfterFailedActivation = fixture.daemonProcessSnapshot();
    expect(pidAfterFailedActivation?.pid).toBe(initialProcess?.pid);
    expect(pidAfterFailedActivation?.alive).toBe(true);

    const pending = db
      .prepare(
        `SELECT c.command_id, c.resolution, c.result_json,
                i.status AS intent_status,
                (SELECT COUNT(*) FROM resource_ownership
                 WHERE workspace_id = ? AND released_at IS NULL) AS claim_count,
                (SELECT COUNT(*) FROM workspace_resource_activation_attention_rows
                 WHERE project_id = ? AND workspace_id = ?) AS attention_count
         FROM commands c
         JOIN workspace_resource_activation_intents i
           ON i.project_id = ? AND i.workspace_id = ?
         WHERE c.command_id = ?`,
      )
      .get(
        workspaceId,
        projectId,
        workspaceId,
        projectId,
        workspaceId,
        commandId,
      ) as
      | {
          command_id: string;
          resolution: string;
          result_json: string;
          intent_status: string;
          claim_count: number;
          attention_count: number;
        }
      | undefined;
    expect(pending).toMatchObject({
      command_id: commandId,
      resolution: "Committed",
      intent_status: "Pending",
      claim_count: 0,
      attention_count: 1,
    });
    expect(pending).toBeDefined();
    if (pending === undefined) throw new Error("committed receipt missing");
    const originalReceipt = {
      commandId: pending.command_id,
      resolution: pending.resolution,
      result: JSON.parse(pending.result_json),
    };
    const pendingAttention = await client.view<{
      rows: ReadonlyArray<Record<string, unknown>>;
    }>("attention", { projectId });
    expect(pendingAttention.rows).toContainEqual(
      expect.objectContaining({
        source: "WorkspaceResourceActivationPending",
        targetWorkspaceId: workspaceId,
        dedupKey: `resource-activation:${projectId}:${workspaceId}:0`,
      }),
    );

    renameSync(movedWorkspaceDirectory, fixture.workspaceDirectory);
    workspaceMoved = false;
    const replay = await fetch(`${fixture.baseUrl}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer local",
      },
      body: JSON.stringify(envelope),
    });
    const replayEnvelope = (await replay.json()) as Record<string, unknown>;
    expect(replay.status).toBe(200);
    expect(replayEnvelope.ok).toBe(true);
    expect(replayEnvelope.body).toEqual(originalReceipt);

    const completed = db
      .prepare(
        `SELECT c.command_id, c.resolution, c.result_json,
                i.status AS intent_status,
                (SELECT COUNT(*) FROM resource_ownership
                 WHERE workspace_id = ? AND released_at IS NULL) AS claim_count,
                (SELECT COUNT(*) FROM workspace_resource_activation_attention_rows
                 WHERE project_id = ? AND workspace_id = ?) AS attention_count,
                (SELECT COUNT(*) FROM commands WHERE command_id = ?) AS command_count
         FROM commands c
         JOIN workspace_resource_activation_intents i
           ON i.project_id = ? AND i.workspace_id = ?
         WHERE c.command_id = ?`,
      )
      .get(
        workspaceId,
        projectId,
        workspaceId,
        commandId,
        projectId,
        workspaceId,
        commandId,
      ) as {
      command_id: string;
      resolution: string;
      result_json: string;
      intent_status: string;
      claim_count: number;
      attention_count: number;
      command_count: number;
    };
    expect(completed).toMatchObject({
      command_id: commandId,
      resolution: "Committed",
      intent_status: "Active",
      claim_count: 1,
      attention_count: 0,
      command_count: 1,
      result_json: pending.result_json,
    });
    expect(JSON.parse(completed.result_json)).toEqual(originalReceipt.result);
    const activationStatuses = db
      .prepare(
        `SELECT json_extract(payload_json, '$.status') AS status
         FROM domain_events
         WHERE project_id = ? AND event_type = 'WorkspaceResourceActivationChanged'
         ORDER BY sequence`,
      )
      .all(projectId)
      .map((row) => (row as { status: string }).status);
    expect(activationStatuses).toEqual(["Pending", "Active"]);
    const finalProcess = fixture.daemonProcessSnapshot();
    expect(finalProcess?.pid).toBe(initialProcess?.pid);
    expect(finalProcess?.alive).toBe(true);
    const clearedAttention = await client.view<{
      rows: ReadonlyArray<Record<string, unknown>>;
    }>("attention", { projectId });
    expect(clearedAttention.rows).not.toContainEqual(
      expect.objectContaining({
        source: "WorkspaceResourceActivationPending",
        targetWorkspaceId: workspaceId,
      }),
    );
    expect(fixture.providerCalls).toHaveLength(0);
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (workspaceMoved) {
    try {
      if (
        movedWorkspaceDirectory === undefined ||
        !existsSync(movedWorkspaceDirectory)
      ) {
        throw new Error("moved Workspace directory disappeared before cleanup");
      }
      if (fixture === undefined) {
        throw new Error(
          "fixture unavailable while restoring Workspace directory",
        );
      }
      if (existsSync(fixture.workspaceDirectory)) {
        throw new Error(
          "Workspace restore skipped because the original target path already exists",
        );
      }
      renameSync(movedWorkspaceDirectory, fixture.workspaceDirectory);
      workspaceMoved = false;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  let unsafeToStopFixture = false;
  if (workspaceMoved && movedWorkspaceDirectory !== undefined) {
    try {
      if (!existsSync(movedWorkspaceDirectory)) {
        throw new Error(
          "moved Workspace directory unavailable for preservation",
        );
      }
      const preservationDirectory = mkdtempSync(
        join(
          dirname(fixture?.directory ?? markerDirectory),
          "arbor-f21-preserved-",
        ),
      );
      const preservedWorkspaceDirectory = join(
        preservationDirectory,
        "workspace-offline",
      );
      renameSync(movedWorkspaceDirectory, preservedWorkspaceDirectory);
      workspaceMoved = false;
      cleanupErrors.push(
        new Error(
          `Workspace directory was preserved at ${preservedWorkspaceDirectory} because its original target could not be safely restored`,
        ),
      );
    } catch (error) {
      cleanupErrors.push(error);
      unsafeToStopFixture = true;
    }
  }

  if (db !== undefined) {
    try {
      db.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (fixture !== undefined) {
    if (unsafeToStopFixture) {
      try {
        await fixture.crash();
      } catch (error) {
        cleanupErrors.push(error);
      }
      cleanupErrors.push(
        new Error(
          "fixture.stop skipped because it could recursively delete an unrestored Workspace directory",
        ),
      );
    } else {
      try {
        await fixture.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  try {
    rmSync(markerDirectory, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (bodyFailed && cleanupErrors.length > 0) {
    throw new AggregateError(
      [bodyError, ...cleanupErrors],
      "F21 online replay body and cleanup both failed",
      { cause: bodyError },
    );
  }
  if (bodyFailed) throw bodyError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "F21 online replay cleanup failed",
      {
        cause: cleanupErrors[0],
      },
    );
  }
});
