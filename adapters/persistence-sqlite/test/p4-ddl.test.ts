import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer, P36_MIGRATIONS, runMigrations } from "../src/index.js";

const withClient = <A>(program: Effect.Effect<A, unknown, SqlClient>) =>
  Effect.runPromise(Effect.provide(program, layer({ filename: ":memory:" })));

const seedExecution = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        `INSERT INTO projects (
          project_id, name, root_workspace_id, project_policy,
          project_policy_revision, default_configuration, environment_ref,
          lifecycle, revision, created_at, updated_at
        ) VALUES ('prj_ddl', 'DDL fixture', 'ws_ddl', '{}', 0, '{}', 'local',
          'Open', 0, 't0', 't0')`,
      );
      yield* sql.unsafe(
        `INSERT INTO sessions (
          session_id, binding_kind, workspace_id, execution_id,
          context_epoch, created_at
        ) VALUES ('ses_ddl', 'WorkspacePrimary', 'ws_ddl', NULL, 0, 't0')`,
      );
      yield* sql.unsafe(
        `INSERT INTO workspaces (
          workspace_id, project_id, parent_workspace_id, name,
          responsibility_definition, responsibility_revision,
          resource_boundary, resource_boundary_revision, agent_binding,
          primary_session_id, current_work_id, workspace_policy,
          workspace_policy_revision, revision, lifecycle, created_at, updated_at
        ) VALUES ('ws_ddl', 'prj_ddl', NULL, 'root', '{}', 0, '{}', 0, '{}',
          'ses_ddl', NULL, '{}', 0, 0, 'Active', 't0', 't0')`,
      );
      yield* sql.unsafe(
        `INSERT INTO executions (
          execution_id, project_id, binding_kind, workspace_id,
          episode_kind, episode_ref, episode_revision, parent_execution_id,
          mission, session_id, admitted_at, stop_requested_at,
          settlement_kind, settlement_json, settled_at
        ) VALUES ('exe_ddl', 'prj_ddl', 'execution_bound', 'ws_ddl',
          NULL, NULL, NULL, NULL, 'fixture', 'ses_ddl', 't0', NULL,
          NULL, NULL, NULL)`,
      );
    }),
  );
});

describe("P4 DDL", () => {
  it("migrates to user_version 36 with the AH7 tool-invocation state", async () => {
    const result = await withClient(
      Effect.gen(function* () {
        yield* runMigrations(P36_MIGRATIONS);
        yield* seedExecution;
        const sql = yield* SqlClient;
        const version = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        const tables = yield* sql.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tool_invocations','artifacts','action_approvals')",
        );
        const invocationColumns = yield* sql.unsafe<{ name: string }>(
          'PRAGMA table_info("tool_invocations")',
        );
        return {
          version: Number(version[0]?.user_version),
          tables: tables.map((t) => t.name).sort(),
          invocationColumns: invocationColumns.map((column) => column.name),
        };
      }),
    );
    expect(result.version).toBe(36);
    expect(result.tables).toEqual([
      "action_approvals",
      "artifacts",
      "tool_invocations",
    ]);
    expect(result.invocationColumns).toContain("effect_admission_state");
  });

  it("rejects an invalid SideEffectSemantics or inconsistent settlement", async () => {
    const result = await withClient(
      Effect.gen(function* () {
        yield* runMigrations(P36_MIGRATIONS);
        yield* seedExecution;
        const sql = yield* SqlClient;
        const badSemantics = yield* sql
          .unsafe(
            "INSERT INTO tool_invocations (invocation_id, execution_id, workspace_id, tool_name, tool_version, side_effect_semantics, arguments_json, resolved_regions_json, approval_id, intent_at, settled_at, settlement_kind, settlement_json, result_ref) VALUES (?,?,?,?,?,?,?,?,NULL,?,NULL,NULL,NULL,NULL)",
            [
              "tiv_1",
              "exe_ddl",
              "ws_ddl",
              "read",
              "1",
              "Bogus",
              "{}",
              "[]",
              "t",
            ],
          )
          .pipe(Effect.exit);
        const badSettlement = yield* sql
          .unsafe(
            "INSERT INTO tool_invocations (invocation_id, execution_id, workspace_id, tool_name, tool_version, side_effect_semantics, arguments_json, resolved_regions_json, approval_id, intent_at, settled_at, settlement_kind, settlement_json, result_ref) VALUES (?,?,?,?,?,?,?,?,NULL,?,NULL,?,?,NULL)",
            [
              "tiv_2",
              "exe_ddl",
              "ws_ddl",
              "read",
              "1",
              "ReadOnly",
              "{}",
              "[]",
              "t",
              "Success",
              "{}",
            ],
          )
          .pipe(Effect.exit);
        return { badSemantics, badSettlement };
      }),
    );
    expect(result.badSemantics._tag).toBe("Failure");
    expect(result.badSettlement._tag).toBe("Failure");
  });
});
