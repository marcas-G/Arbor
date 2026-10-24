import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { createSchema51TestDatabase } from "../../../tests/support/schema44-database.js";
import {
  layer,
  P52_WORK_CONTRACT_REVISION_MIGRATION,
  runMigrations,
} from "../src/index.js";

const seedLegacyCurrentWork = (filename: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe(
                `INSERT INTO projects (
                   project_id, name, root_workspace_id, project_policy,
                   project_policy_revision, default_configuration,
                   environment_ref, lifecycle, revision, created_at, updated_at
                 ) VALUES (?, 'S2 history fixture', ?, '{}', 0, '{}',
                           'local', 'Open', 0, 't0', 't0')`,
                ["prj_s2_history", "ws_s2_history"],
              );
              yield* sql.unsafe(
                `INSERT INTO sessions (
                   session_id, binding_kind, workspace_id, execution_id,
                   context_epoch, created_at
                 ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
                ["ses_s2_history", "ws_s2_history"],
              );
              yield* sql.unsafe(
                `INSERT INTO workspaces (
                   workspace_id, project_id, parent_workspace_id, name,
                   responsibility_definition, responsibility_revision,
                   resource_boundary, resource_boundary_revision,
                   agent_binding, primary_session_id, current_work_id,
                   workspace_policy, workspace_policy_revision, revision,
                   lifecycle, created_at, updated_at
                 ) VALUES (?, ?, NULL, 'root', '{}', 0, '{}', 0, '{}', ?,
                           ?, '{}', 0, 0, 'Active', 't0', 't0')`,
                [
                  "ws_s2_history",
                  "prj_s2_history",
                  "ses_s2_history",
                  "wrk_s2_history",
                ],
              );
              yield* sql.unsafe(
                `INSERT INTO works (
                   work_id, project_id, workspace_id, objective, why,
                   constraints, completion_expectation, verification_mission,
                   provenance, lifecycle, revision, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open', 4, 't0', 't4')`,
                [
                  "wrk_s2_history",
                  "prj_s2_history",
                  "ws_s2_history",
                  "legacy objective",
                  "legacy why",
                  JSON.stringify(["legacy constraint"]),
                  "legacy completion",
                  JSON.stringify({
                    goal: "legacy verification",
                    criteria: [
                      {
                        criterionId: "legacy",
                        requirement: "the old mission remains exact",
                        required: true,
                      },
                    ],
                    riskRequirements: [],
                  }),
                  JSON.stringify({ predecessorWorkId: null, reason: "legacy" }),
                ],
              );
            }),
          );
        }),
        layer({ filename }),
      ),
    ),
  );

const applyP52 = (filename: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        runMigrations([P52_WORK_CONTRACT_REVISION_MIGRATION]),
        layer({ filename }),
      ),
    ),
  );

describe("P52 Work contract revision history migration", () => {
  it("backfills only each exact current Work row as history-unavailable", async () => {
    const fixture = await createSchema51TestDatabase();
    try {
      await seedLegacyCurrentWork(fixture.databaseFilename);
      expect(await applyP52(fixture.databaseFilename)).toBe(1);
      expect(await applyP52(fixture.databaseFilename)).toBe(0);
      const db = new DatabaseSync(fixture.databaseFilename);
      try {
        expect(
          (db.prepare("PRAGMA user_version").get() as { user_version: number })
            .user_version,
        ).toBe(52);
        const rows = db
          .prepare(
            `SELECT work_id, work_revision, contract_json, contract_sha256,
                    record_kind, source_command_id, actor, provenance_json,
                    recorded_at
               FROM work_contract_revisions ORDER BY work_revision`,
          )
          .all() as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          work_id: "wrk_s2_history",
          work_revision: 4,
          record_kind: "LegacyCurrentSnapshot",
          source_command_id: null,
          actor: null,
          recorded_at: "t4",
        });
        const snapshot = JSON.parse(String(rows[0]?.contract_json));
        expect(snapshot).toEqual({
          objective: "legacy objective",
          why: "legacy why",
          constraints: ["legacy constraint"],
          completionExpectation: "legacy completion",
          verificationMission: {
            goal: "legacy verification",
            criteria: [
              {
                criterionId: "legacy",
                requirement: "the old mission remains exact",
                required: true,
              },
            ],
            riskRequirements: [],
          },
        });
        expect(String(rows[0]?.contract_sha256)).toMatch(/^[0-9a-f]{64}$/);
        expect(() =>
          db
            .prepare(
              "UPDATE work_contract_revisions SET record_kind = 'Initial' WHERE work_id = ? AND work_revision = 4",
            )
            .run("wrk_s2_history"),
        ).toThrow(/immutable/);
        expect(() =>
          db
            .prepare(
              "DELETE FROM work_contract_revisions WHERE work_id = ? AND work_revision = 4",
            )
            .run("wrk_s2_history"),
        ).toThrow(/retained/);
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  }, 180_000);

  it("rolls back schema and version if the disposable migration fails", async () => {
    const fixture = await createSchema51TestDatabase();
    try {
      const failingMigration = {
        ...P52_WORK_CONTRACT_REVISION_MIGRATION,
        sql: `${P52_WORK_CONTRACT_REVISION_MIGRATION.sql}\nINSERT INTO missing_s2_table VALUES (1);`,
      };
      await expect(
        Effect.runPromise(
          Effect.scoped(
            Effect.provide(
              runMigrations([failingMigration]),
              layer({ filename: fixture.databaseFilename }),
            ),
          ),
        ),
      ).rejects.toThrow();
      const db = new DatabaseSync(fixture.databaseFilename, { readOnly: true });
      try {
        expect(
          (db.prepare("PRAGMA user_version").get() as { user_version: number })
            .user_version,
        ).toBe(51);
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='work_contract_revisions'",
            )
            .all(),
        ).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  }, 180_000);
});
