import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { P27_MIGRATIONS, P28_MIGRATIONS } from "../src/migrations.js";

describe("DID v1.29 migration 0028 settled governance cleanup", () => {
  it("consumes stale actionable rows for terminal proposals", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runMigrations(P27_MIGRATIONS);
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
              "INSERT INTO formation_proposals (proposal_id, parent_workspace_id, proposal_json, revision, state, created_at, updated_at) VALUES ('fpr_test','ws','{\"name\":\"child\"}',1,'Rejected','t','t')",
            );
            yield* sql.unsafe(
              "INSERT INTO inbox_entries (workspace_id, entry_key, kind, summary, correlation_id, admitted_at, consumed_at) VALUES ('ws','gov:fpr_test:1','Governance','stale pending decision',NULL,'t',NULL)",
            );
          }),
        );

        const applied = yield* runMigrations(P28_MIGRATIONS);
        const rows = yield* sql.unsafe<{ consumed_at: string | null }>(
          "SELECT consumed_at FROM inbox_entries WHERE entry_key = 'gov:fpr_test:1'",
        );
        const version = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );

        expect(applied).toBe(1);
        expect(version[0]?.user_version).toBe(28);
        expect(rows[0]?.consumed_at).not.toBeNull();
      }).pipe(Effect.provide(layer({ filename: ":memory:" }))),
    );
  });
});
