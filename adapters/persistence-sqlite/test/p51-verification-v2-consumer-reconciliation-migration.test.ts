import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createSchema50TestDatabase } from "../../../tests/support/schema44-database.js";
import {
  layer,
  P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_MIGRATION,
  runMigrations,
} from "../src/index.js";

const runP51 = (filename: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        runMigrations([P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_MIGRATION], {
          allowOfflineOnly: true,
        }),
        layer({ filename }),
      ),
    ),
  );

describe("F18 schema 0051 verification signal reconciliation", () => {
  it("rolls back all schema and activation facts on migration failure and re-enters exactly once", async () => {
    const fixture = await createSchema50TestDatabase();
    try {
      const failing = {
        ...P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_MIGRATION,
        onApply: (sql: unknown, context?: { readonly capturedAt?: string }) =>
          Effect.gen(function* () {
            const apply =
              P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_MIGRATION.onApply;
            if (apply === undefined) throw new Error("P51 onApply missing");
            yield* apply(sql, context);
            return yield* Effect.die(new Error("inject P51 rollback"));
          }),
      };
      await expect(
        Effect.runPromise(
          Effect.scoped(
            Effect.provide(
              runMigrations([failing], { allowOfflineOnly: true }),
              layer({ filename: fixture.databaseFilename }),
            ),
          ),
        ),
      ).rejects.toThrow("inject P51 rollback");

      const afterRollback = new DatabaseSync(fixture.databaseFilename, {
        readOnly: true,
      });
      try {
        expect(
          (
            afterRollback.prepare("PRAGMA user_version").get() as {
              user_version: number;
            }
          ).user_version,
        ).toBe(50);
        expect(
          afterRollback
            .prepare(
              `SELECT name FROM sqlite_master WHERE type='table'
               AND name LIKE 'verification_signal_reconciliation_%'`,
            )
            .all(),
        ).toEqual([]);
        expect(
          afterRollback
            .prepare(
              `SELECT name FROM sqlite_master WHERE type='table'
               AND name = 'verification_conclusion_v2_activation_highwaters'`,
            )
            .all(),
        ).toEqual([]);
      } finally {
        afterRollback.close();
      }

      expect(await runP51(fixture.databaseFilename)).toBe(1);
      expect(await runP51(fixture.databaseFilename)).toBe(0);
    } finally {
      fixture.cleanup();
    }
  }, 180_000);

  it("captures immutable per-Project high-waters atomically and creates the five stores", async () => {
    const fixture = await createSchema50TestDatabase();
    try {
      const seed = new DatabaseSync(fixture.databaseFilename);
      let projectId = "";
      try {
        projectId = "prj_f18_highwater";
        seed.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
        seed
          .prepare(
            `INSERT INTO projects (
               project_id, name, root_workspace_id, project_policy,
               project_policy_revision, default_configuration, environment_ref,
               resource_source_json, lifecycle, revision, created_at, updated_at
             ) VALUES (?, 'F18', 'ws_f18_highwater', '{}', 0, '{}', 'local',
                       '{"_tag":"LegacyUnknown"}', 'Open', 0, 't', 't')`,
          )
          .run(projectId);
        seed
          .prepare(
            `INSERT INTO workspaces (
               workspace_id, project_id, parent_workspace_id, name,
               responsibility_definition, responsibility_revision,
               resource_boundary, resource_boundary_revision, agent_binding,
               primary_session_id, current_work_id, workspace_policy,
               workspace_policy_revision, revision, lifecycle, created_at, updated_at
             ) VALUES ('ws_f18_highwater', ?, NULL, 'F18', '{}', 0, '{}', 0,
                       '{}', 'ses_f18_highwater', NULL, '{}', 0, 0, 'Active', 't', 't')`,
          )
          .run(projectId);
        seed
          .prepare(
            `INSERT INTO sessions (
               session_id, binding_kind, workspace_id, execution_id,
               context_epoch, created_at
             ) VALUES ('ses_f18_highwater', 'WorkspacePrimary',
                       'ws_f18_highwater', NULL, 0, 't')`,
          )
          .run();
        seed
          .prepare(
            `INSERT INTO project_event_sequences (project_id, last_sequence)
             VALUES (?, 17)
             ON CONFLICT(project_id) DO UPDATE SET last_sequence = 17`,
          )
          .run(projectId);
        seed.exec("COMMIT");
      } finally {
        seed.close();
      }

      await runP51(fixture.databaseFilename);
      const db = new DatabaseSync(fixture.databaseFilename, { readOnly: true });
      try {
        expect(
          (db.prepare("PRAGMA user_version").get() as { user_version: number })
            .user_version,
        ).toBe(51);
        const tableNames = (
          db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type='table'
               AND name LIKE 'verification_%' ORDER BY name`,
            )
            .all() as Array<{ name: string }>
        ).map(({ name }) => name);
        expect(tableNames).toEqual(
          expect.arrayContaining([
            "verification_conclusion_v2_activation_highwaters",
            "verification_signal_reconciliations",
            "verification_signal_reconciliation_attention_facts",
            "verification_signal_reconciliation_attention_queue",
            "verification_signal_reconciliation_attention_rows",
          ]),
        );
        const highwaters = db
          .prepare(
            `SELECT project_id, max_event_sequence, captured_at, fact_digest
             FROM verification_conclusion_v2_activation_highwaters
             ORDER BY project_id`,
          )
          .all() as Array<{
          project_id: string;
          max_event_sequence: number;
          captured_at: string;
          fact_digest: string;
        }>;
        const projects = (
          db
            .prepare("SELECT project_id FROM projects ORDER BY project_id")
            .all() as Array<{
            project_id: string;
          }>
        ).map(({ project_id: id }) => id);
        expect(highwaters.map(({ project_id: id }) => id)).toEqual(projects);
        const selected = highwaters.find((row) => row.project_id === projectId);
        expect(selected?.max_event_sequence).toBe(17);
        expect(selected?.fact_digest).toBe(
          createHash("sha256")
            .update(
              `f18-v2-activation-highwater-v1\0${projectId}\0${17}\0${selected?.captured_at}`,
              "utf8",
            )
            .digest("hex"),
        );
        expect(() =>
          db
            .prepare(
              `UPDATE verification_conclusion_v2_activation_highwaters
               SET max_event_sequence = 18 WHERE project_id = ?`,
            )
            .run(projectId),
        ).toThrow();
        expect(() =>
          db
            .prepare(
              `DELETE FROM verification_conclusion_v2_activation_highwaters
               WHERE project_id = ?`,
            )
            .run(projectId),
        ).toThrow();
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });
});
