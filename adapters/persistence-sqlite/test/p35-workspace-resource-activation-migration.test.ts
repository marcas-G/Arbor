import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { P34_MIGRATIONS, P35_MIGRATIONS } from "../src/migrations.js";

const runDb = <A>(program: Effect.Effect<A, unknown, SqlClient>) =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(program, layer({ filename: ":memory:" }))),
  );

describe("P35 F21 activation intent migration", () => {
  it("adds the intent table without inferring pre-intent v2 receipts or changing canonical rows", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P34_MIGRATIONS);
      const sql = yield* SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe(
            `INSERT INTO projects (
              project_id, name, root_workspace_id, project_policy,
              project_policy_revision, default_configuration, environment_ref,
              lifecycle, revision, created_at, updated_at
            ) VALUES ('prj_preintent','legacy','ws_preintent','{}',0,'{}',
              'local','Open',0,'t0','t0')`,
          );
          yield* sql.unsafe(
            `INSERT INTO workspaces (
              workspace_id, project_id, parent_workspace_id, name,
              responsibility_definition, responsibility_revision,
              resource_boundary, resource_boundary_revision, agent_binding,
              primary_session_id, current_work_id, workspace_policy,
              workspace_policy_revision, revision, lifecycle, created_at, updated_at
            ) VALUES ('ws_preintent','prj_preintent',NULL,'root','{}',0,
              '{"basisResponsibilityRevision":0,"addresses":[{"_tag":"FileTree","path":"C:/historical"}]}',
              0,'{}','ses_preintent',NULL,'{}',0,0,'Active','t0','t0')`,
          );
          yield* sql.unsafe(
            `INSERT INTO sessions (
              session_id, binding_kind, workspace_id, execution_id,
              context_epoch, created_at
            ) VALUES ('ses_preintent','WorkspacePrimary','ws_preintent',NULL,0,'t0')`,
          );
          yield* sql.unsafe(
            `INSERT INTO commands (
              command_id, project_id, semantic_request_fingerprint,
              schema_version, fingerprint_algorithm_version, resolution,
              result_json, terminal_error_json, created_at, settled_at
            ) VALUES ('cmd_preintent','prj_preintent','fingerprint','2',1,
              'Committed','{"projectId":"prj_preintent"}',NULL,'t0','t0')`,
          );
          yield* sql.unsafe(
            `INSERT INTO domain_events (
              event_id, project_id, sequence, event_type, event_version,
              occurred_at, aggregate_ref, actor, caused_by_command_id,
              caused_by_event_id, correlation_ref, payload_json
            ) VALUES
              ('evt_preintent_project','prj_preintent',1,'ProjectCreated',1,
                't0','prj_preintent','user:test','cmd_preintent',NULL,NULL,'{}'),
              ('evt_preintent_workspace','prj_preintent',2,'WorkspaceCreated',1,
                't0','ws_preintent','user:test','cmd_preintent',NULL,NULL,'{}')`,
          );
        }),
      );
      const before = yield* sql.unsafe<{
        workspaces: number;
        commands: number;
        events: number;
      }>(`SELECT
        (SELECT COUNT(*) FROM workspaces) AS workspaces,
        (SELECT COUNT(*) FROM commands) AS commands,
        (SELECT COUNT(*) FROM domain_events) AS events`);
      const migrated = yield* runMigrations(P35_MIGRATIONS);
      const version = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      const after = yield* sql.unsafe<{
        workspaces: number;
        commands: number;
        events: number;
        intents: number;
        activationAttention: number;
      }>(`SELECT
        (SELECT COUNT(*) FROM workspaces) AS workspaces,
        (SELECT COUNT(*) FROM commands) AS commands,
        (SELECT COUNT(*) FROM domain_events) AS events,
        (SELECT COUNT(*) FROM workspace_resource_activation_intents) AS intents,
        (SELECT COUNT(*) FROM workspace_resource_activation_attention_rows) AS activationAttention`);
      const activationAttentionForeignKeys = yield* sql.unsafe<{
        table: string;
      }>(
        'PRAGMA foreign_key_list("workspace_resource_activation_attention_rows")',
      );
      const boundary = yield* sql.unsafe<{ resource_boundary: string }>(
        "SELECT resource_boundary FROM workspaces WHERE workspace_id = 'ws_preintent'",
      );
      return {
        before: before[0],
        migrated,
        version: Number(version[0]?.user_version ?? 0),
        after: after[0],
        boundary: boundary[0]?.resource_boundary,
        activationAttentionForeignKeys: activationAttentionForeignKeys.map(
          (row) => row.table,
        ),
      };
    });

    const result = await runDb(program);
    expect(result.before).toEqual({ workspaces: 1, commands: 1, events: 2 });
    expect(result.migrated).toBe(1);
    expect(result.version).toBe(35);
    expect(result.after).toEqual({
      workspaces: 1,
      commands: 1,
      events: 2,
      intents: 0,
      activationAttention: 0,
    });
    expect(result.boundary).toContain("C:/historical");
    expect(result.activationAttentionForeignKeys).toEqual([
      "workspace_resource_activation_intents",
      "workspace_resource_activation_intents",
      "workspace_resource_activation_intents",
    ]);
  });
});
