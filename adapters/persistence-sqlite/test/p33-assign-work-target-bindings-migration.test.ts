import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { P32_MIGRATIONS, P33_MIGRATIONS } from "../src/migrations.js";

describe("DID v1.33 migration 0033 AssignWork target bindings", () => {
  it("is forward-only and re-entrant, preserves old Committed receipts without backfill, and installs composite constraints", async () => {
    const base = layer({ filename: ":memory:" });
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P32_MIGRATIONS);
          const sql = yield* SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe(
                "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES ('prj_p33','p','ws_p33','{}',0,'{}','local','Open',0,'t','t')",
              );
              yield* sql.unsafe(
                "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES ('ses_p33','WorkspacePrimary','ws_p33',NULL,0,'t')",
              );
              yield* sql.unsafe(
                "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES ('ws_p33','prj_p33',NULL,'root','{}',0,'{}',0,'{}','ses_p33',NULL,'{}',0,0,'Active','t','t')",
              );
              yield* sql.unsafe(
                "INSERT INTO commands (command_id, project_id, semantic_request_fingerprint, schema_version, fingerprint_algorithm_version, resolution, result_json, terminal_error_json, created_at, settled_at) VALUES ('cmd_p33_legacy','prj_p33','fingerprint','1',1,'Committed','{\"workId\":\"wrk_legacy\",\"workspaceId\":\"ws_p33\",\"lifecycle\":\"Open\",\"revision\":0}',NULL,'t','t')",
              );
            }),
          );

          yield* runMigrations(P33_MIGRATIONS);
          yield* runMigrations(P33_MIGRATIONS);
          const oldBinary = yield* Effect.exit(runMigrations(P32_MIGRATIONS));
          expect(oldBinary._tag).toBe("Failure");
          const version = yield* sql.unsafe<{ user_version: number }>(
            "PRAGMA user_version",
          );
          expect(Number(version[0]?.user_version)).toBe(33);
          const oldReceipt = yield* sql.unsafe<{
            resolution: string;
            result_json: string;
          }>(
            "SELECT resolution, result_json FROM commands WHERE command_id = 'cmd_p33_legacy'",
          );
          expect(oldReceipt).toEqual([
            expect.objectContaining({ resolution: "Committed" }),
          ]);
          const bindings = yield* sql.unsafe<{ n: number }>(
            "SELECT COUNT(*) AS n FROM assign_work_target_bindings",
          );
          expect(Number(bindings[0]?.n)).toBe(0);
          const indexes = yield* sql.unsafe<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%_id_project%' ORDER BY name",
          );
          expect(indexes.map((row) => row.name)).toEqual(
            expect.arrayContaining([
              "commands_id_project",
              "executions_id_project_workspace",
              "workspaces_id_project_parent",
              "works_id_project",
              "permission_grants_id_project",
              "action_approvals_id_project",
            ]),
          );
          const foreignKeyErrors = yield* sql.unsafe(
            "PRAGMA foreign_key_check",
          );
          expect(foreignKeyErrors).toEqual([]);
        }),
        base,
      ),
    );
  });
});
