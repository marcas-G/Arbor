import { Effect, Exit } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer, P1_MIGRATIONS, runMigrations } from "../src/index.js";

const withMigrated = <A, E>(
  program: Effect.Effect<A, E, SqlClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* runMigrations(P1_MIGRATIONS);
        return yield* program;
      }),
      layer({ filename: ":memory:" }),
    ),
  );

const bootstrap = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES ('prj_1','p','ws_1','{}',0,'{}','e','Open',0,'t','t')",
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES ('ws_1','prj_1',NULL,'w','{}',0,'{}',0,'{}','ses_1',NULL,'{}',0,0,'Active','t','t')",
      );
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES ('ses_1','WorkspacePrimary','ws_1',NULL,0,'t')",
      );
    }),
  );
});

describe("P1 DDL migration", () => {
  it("creates every P1 table", async () => {
    const tables = await withMigrated(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        );
        return rows.map((row) => row.name);
      }),
    );
    for (const table of [
      "projects",
      "workspaces",
      "sessions",
      "works",
      "resource_ownership",
      "environment_revisions",
      "commands",
      "command_attempts",
      "domain_events",
      "project_event_sequences",
      "consumer_offsets",
      "consumer_dead_letters",
    ]) {
      expect(tables).toContain(table);
    }
  });

  it("commits the deferred-FK bootstrap atomically", async () => {
    const project = await withMigrated(
      Effect.gen(function* () {
        yield* bootstrap;
        const sql = yield* SqlClient;
        const rows = yield* sql.unsafe<{ project_id: string }>(
          "SELECT project_id FROM projects",
        );
        return rows[0]?.project_id;
      }),
    );
    expect(project).toBe("prj_1");
  });

  it("rejects a root workspace from another project at COMMIT", async () => {
    const exit = await withMigrated(
      Effect.gen(function* () {
        yield* bootstrap;
        const sql = yield* SqlClient;
        return yield* Effect.exit(
          sql.withTransaction(
            sql.unsafe(
              "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES ('prj_2','p2','ws_1','{}',0,'{}','e','Open',0,'t','t')",
            ),
          ),
        );
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("enforces the commands resolution/result CHECK", async () => {
    const exit = await withMigrated(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* Effect.exit(
          sql.unsafe(
            "INSERT INTO commands (command_id, project_id, semantic_request_fingerprint, schema_version, fingerprint_algorithm_version, resolution, result_json, terminal_error_json, created_at, settled_at) VALUES ('cmd_1','prj_1','fp','1',1,'Committed',NULL,NULL,'t','t')",
          ),
        );
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
