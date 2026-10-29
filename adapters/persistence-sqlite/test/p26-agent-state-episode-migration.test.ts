import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { P25_MIGRATIONS, P26_MIGRATIONS } from "../src/migrations.js";

describe("DID v1.28 migration 0026 agent-state episode identity", () => {
  it("converts focus state to the execution's exact episode and removes focus_json", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runMigrations(P25_MIGRATIONS);
        const sql = yield* SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe(
              "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES ('prj','p','ws','{}',0,'{}','local','Open',0,'t','t')",
            );
            yield* sql.unsafe(
              "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES ('ses','WorkspacePrimary','ws',NULL,0,'t')",
            );
            yield* sql.unsafe(
              "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES ('ws','prj',NULL,'w','{}',0,'{}',0,'{}','ses',NULL,'{}',0,0,'Active','t','t')",
            );
            yield* sql.unsafe(
              "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, episode_kind, episode_ref, episode_revision, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES ('exe','prj','workspace','ws','ConversationResponseEpisode','msg',4,NULL,NULL,'ses','t',NULL,NULL,NULL,NULL)",
            );
            yield* sql.unsafe(
              "INSERT INTO agent_execution_state (execution_id, focus_json, wake_reason, current_mode, active_skill_refs_json, turn_no, recent_directive_refs_json, recent_action_fingerprints_json, updated_at) VALUES ('exe','{\"_tag\":\"Coordination\"}','Recovery','execute','[]',2,'[]','[]','t')",
            );
          }),
        );

        const applied = yield* runMigrations(P26_MIGRATIONS);
        const second = yield* runMigrations(P26_MIGRATIONS);
        const columns = yield* sql.unsafe<{ name: string }>(
          "PRAGMA table_info(agent_execution_state)",
        );
        const rows = yield* sql.unsafe<{ episode_json: string }>(
          "SELECT episode_json FROM agent_execution_state WHERE execution_id = 'exe'",
        );
        const version = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        const violations = yield* sql.unsafe("PRAGMA foreign_key_check");

        expect(applied).toBe(1);
        expect(second).toBe(0);
        expect(version[0]?.user_version).toBe(26);
        expect(columns.map((column) => column.name)).toContain("episode_json");
        expect(columns.map((column) => column.name)).not.toContain(
          "focus_json",
        );
        expect(JSON.parse(rows[0]?.episode_json ?? "null")).toEqual({
          _tag: "ConversationResponseEpisode",
          messageId: "msg",
          responseJobRevision: 4,
        });
        expect(violations).toEqual([]);
      }).pipe(Effect.provide(layer({ filename: ":memory:" }))),
    );
  });
});
