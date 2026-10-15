import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  functionalId,
  makePublicClient,
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];

const postRetry = (
  baseUrl: string,
  input: {
    readonly commandId: string;
    readonly projectId: string;
    readonly workId: string;
    readonly verificationId: string;
    readonly verifierExecutionId: string;
    readonly successorVerificationId: string;
    readonly successorExecutionId: string;
    readonly summaryContent: string;
  },
) =>
  fetch(`${baseUrl}/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer local",
    },
    body: JSON.stringify({
      commandType: "RetryVerification",
      commandId: input.commandId,
      projectId: input.projectId,
      actor: "user:local",
      issuedAt: "2026-10-16T00:00:00.000Z",
      payload: {
        workId: input.workId,
        verificationId: input.verificationId,
        expectedWorkRevision: 0,
        summaryContent: input.summaryContent,
        successorVerificationId: input.successorVerificationId,
        verifierExecutionId: input.successorExecutionId,
      },
    }),
  }).then(async (response) => ({
    status: response.status,
    body: JSON.parse(await response.text()) as Record<string, unknown>,
  }));

const handoffSnapshot = (
  db: DatabaseSync,
  input: { readonly commandId: string; readonly workId: string },
) => ({
  receipt: db
    .prepare(
      `SELECT command_id, resolution, result_json, terminal_error_json
         FROM commands WHERE command_id = ?`,
    )
    .get(input.commandId),
  verifications: db
    .prepare(
      `SELECT verification_id, work_id, target_work_revision, state, verdict,
              conclusion_reason, verification_execution_ids
         FROM verifications WHERE work_id = ? ORDER BY verification_id`,
    )
    .all(input.workId),
  verificationExecutions: db
    .prepare(
      `SELECT verification_id, execution_id FROM verification_executions
        WHERE verification_id IN (SELECT verification_id FROM verifications WHERE work_id = ?)
        ORDER BY verification_id, execution_id`,
    )
    .all(input.workId),
  events: db
    .prepare(
      `SELECT event_type, aggregate_ref, actor, caused_by_command_id, payload_json
         FROM domain_events WHERE caused_by_command_id = ? ORDER BY event_id`,
    )
    .all(input.commandId),
});

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
});

describe("pending F23 P8 RetryVerification permanent exact replay", () => {
  it("returns the original receipt for the same CommandId and exact payload after commit", async () => {
    const fixture = await startProductionFixture({
      isolatedPortHandshake: true,
      reply: () => ({ _tag: "HttpError", status: 500 }),
    });
    fixtures.push(fixture);
    const client = makePublicClient(fixture.baseUrl);
    const project = await createFunctionalProject(
      client,
      fixture.workspaceDirectory,
      "P8 permanent exact replay RED",
    );
    const workId = functionalId("wrk");
    const verificationId = functionalId("ver");
    const oldVerifierExecutionId = functionalId("exe");
    const successorVerificationId = functionalId("ver");
    const successorExecutionId = functionalId("exe");
    const commandId = functionalId("cmd");
    const now = "2026-10-16T00:00:00.000Z";
    const mission = {
      goal: "confirm one bounded Work outcome",
      criteria: [
        {
          criterionId: "criterion-1",
          requirement: "the Work outcome is inspectable",
          required: true,
        },
      ],
      riskRequirements: [],
    };
    const db = new DatabaseSync(fixture.databaseFile);
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        `INSERT INTO works (
           work_id, project_id, workspace_id, objective, why, constraints,
           completion_expectation, verification_mission, provenance,
           lifecycle, revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open', 0, ?, ?)`,
      ).run(
        workId,
        project.projectId,
        project.rootWorkspaceId,
        "one bounded Work",
        "P8 replay qualification",
        JSON.stringify([]),
        "the outcome can be inspected",
        JSON.stringify(mission),
        JSON.stringify({ _tag: "TestFixture" }),
        now,
        now,
      );
      db.prepare(
        `INSERT INTO executions (
           execution_id, project_id, binding_kind, workspace_id,
           episode_kind, episode_ref, episode_revision, parent_execution_id,
           mission, session_id, admitted_at, stop_requested_at,
           settlement_kind, settlement_json, settled_at
         ) VALUES (?, ?, 'execution_bound', ?, NULL, NULL, NULL, NULL,
                   'P8 replay fixture verifier', ?, ?, NULL, 'Completed', ?, ?)`,
      ).run(
        oldVerifierExecutionId,
        project.projectId,
        project.rootWorkspaceId,
        project.rootSessionId,
        now,
        JSON.stringify({ _tag: "Completed", result: { _tag: "NoResult" } }),
        now,
      );
      db.prepare(
        `INSERT INTO verifications (
           verification_id, project_id, work_id, target_work_revision,
           owner_workspace_id, mission_snapshot, target_deliverables,
           target_artifact_versions, target_environment_revision,
           environment_snapshot_ref, verification_execution_ids, state,
           verdict, conclusion_reason, created_at, updated_at, summary_ref
         ) VALUES (?, ?, ?, 0, ?, ?, '[]', '[]', NULL, NULL, ?, 'Open',
                   NULL, NULL, ?, ?, NULL)`,
      ).run(
        verificationId,
        project.projectId,
        workId,
        project.rootWorkspaceId,
        JSON.stringify(mission),
        JSON.stringify([oldVerifierExecutionId]),
        now,
        now,
      );
      db.prepare(
        `INSERT INTO verification_executions (verification_id, execution_id, bound_at)
         VALUES (?, ?, ?)`,
      ).run(verificationId, oldVerifierExecutionId, now);
      db.exec("COMMIT");

      const input = {
        commandId,
        projectId: project.projectId,
        workId,
        verificationId,
        verifierExecutionId: oldVerifierExecutionId,
        successorVerificationId,
        successorExecutionId,
        summaryContent: "The exact verifier source is orphaned.",
      };
      const first = await postRetry(fixture.baseUrl, input);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        ok: true,
        body: {
          commandId,
          resolution: "Committed",
          result: {
            workId,
            orphanedVerificationId: verificationId,
            successorVerificationId,
            verifierExecutionId: successorExecutionId,
            state: "OrphanedAndRetried",
          },
        },
      });
      const afterCommit = handoffSnapshot(db, { commandId, workId });

      const exactReplay = await postRetry(fixture.baseUrl, input);
      expect(exactReplay.body).toEqual(first.body);
      expect(handoffSnapshot(db, { commandId, workId })).toEqual(afterCommit);
      expect(fixture.daemonErrors).toEqual([]);
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  }, 90_000);
});
