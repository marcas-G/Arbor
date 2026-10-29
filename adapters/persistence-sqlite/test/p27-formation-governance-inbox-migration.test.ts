import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { P26_MIGRATIONS, P27_MIGRATIONS } from "../src/migrations.js";

describe("DID v1.29 migration 0027 formation governance recovery", () => {
  it("backfills exactly one actionable Inbox entry for every pending proposal", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runMigrations(P26_MIGRATIONS);
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
              "INSERT INTO formation_proposals (proposal_id, parent_workspace_id, proposal_json, revision, state, created_at, updated_at) VALUES ('fpr_test','ws','{\"name\":\"child\"}',1,'Pending','t','t')",
            );
          }),
        );

        const applied = yield* runMigrations(P27_MIGRATIONS);
        const second = yield* runMigrations(P27_MIGRATIONS);
        const entries = yield* sql.unsafe<{
          workspace_id: string;
          entry_key: string;
          kind: string;
          summary: string;
        }>("SELECT workspace_id, entry_key, kind, summary FROM inbox_entries");
        const version = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );

        expect(applied).toBe(1);
        expect(second).toBe(0);
        expect(version[0]?.user_version).toBe(27);
        expect(entries).toEqual([
          {
            workspace_id: "ws",
            entry_key: "gov:fpr_test:1",
            kind: "Governance",
            summary:
              'formation proposal "child" revision 1 awaiting human decision',
          },
        ]);
      }).pipe(Effect.provide(layer({ filename: ":memory:" }))),
    );
  });
});
