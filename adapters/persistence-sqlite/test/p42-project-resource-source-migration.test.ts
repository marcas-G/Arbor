import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA45_SUFFIX_IDS,
  expectedCurrentSchemaSuffixIds,
  HISTORICAL_SCHEMA42_SUFFIX_IDS,
} from "../../../tests/support/schema-prefix-contract.js";
import { createSchema42TestDatabase } from "../../../tests/support/schema42-database.js";
import {
  CURRENT_MIGRATIONS,
  CURRENT_SCHEMA_VERSION,
  layer,
  P42_PROJECT_RESOURCE_SOURCE_MIGRATION,
  runMigrations,
} from "../src/index.js";

const projectId = "prj_p42_migration";
const workspaceId = "ws_p42_migration";
const sessionId = "ses_p42_migration";
const executionId = "exe_p42_migration";

const seedP38Project = (filename: string) =>
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
                 ) VALUES (?, 'P42 migration fixture', ?, '{}', 0, '{}',
                           'local', 'Open', 0, 't0', 't0')`,
                [projectId, workspaceId],
              );
              yield* sql.unsafe(
                `INSERT INTO sessions (
                   session_id, binding_kind, workspace_id, execution_id,
                   context_epoch, created_at
                 ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
                [sessionId, workspaceId],
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
                           NULL, '{}', 0, 0, 'Active', 't0', 't0')`,
                [workspaceId, projectId, sessionId],
              );
              yield* sql.unsafe(
                `INSERT INTO executions (
                   execution_id, project_id, binding_kind, workspace_id,
                   episode_kind, episode_ref, episode_revision,
                   parent_execution_id, mission, session_id, admitted_at,
                   stop_requested_at, settlement_kind, settlement_json,
                   settled_at
                 ) VALUES (?, ?, 'execution_bound', ?, NULL, NULL, NULL,
                           NULL, 'P42 migration fixture', ?, 't0', NULL,
                           NULL, NULL, NULL)`,
                [executionId, projectId, workspaceId, sessionId],
              );
            }),
          );
        }),
        layer({ filename }),
      ),
    ),
  );

describe("FT-DG-01 ProjectResourceSource migration descriptor", () => {
  it("pins migration 0042 in the historical schema-42 prefix and current catalog", () => {
    expect(P42_PROJECT_RESOURCE_SOURCE_MIGRATION).toMatchObject({
      id: 42,
      name: "project_resource_source_attribution",
      requiresUserVersion: 41,
    });
    const currentSuffixIds = CURRENT_MIGRATIONS.map(({ id }) => id).filter(
      (id) => id >= 40,
    );
    expect(currentSuffixIds).toEqual(
      expectedCurrentSchemaSuffixIds(CURRENT_SCHEMA_VERSION),
    );
    expect(CURRENT_MIGRATIONS.at(-1)?.id).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      CURRENT_SCHEMA45_SUFFIX_IDS.slice(
        0,
        HISTORICAL_SCHEMA42_SUFFIX_IDS.length,
      ),
    ).toEqual(HISTORICAL_SCHEMA42_SUFFIX_IDS);
    expect(CURRENT_MIGRATIONS.find(({ id }) => id === 42)).toMatchObject({
      id: 42,
      requiresUserVersion: 41,
    });
    expect(CURRENT_MIGRATIONS.some(({ id }) => id === 39)).toBe(false);
  });

  it("backfills only LegacyUnknown and preserves all prior Project columns", async () => {
    const database = await createSchema42TestDatabase({
      seedP38: seedP38Project,
    });
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              const sql = yield* SqlClient;
              const replayed = yield* runMigrations([
                P42_PROJECT_RESOURCE_SOURCE_MIGRATION,
              ]);
              const rows = yield* sql.unsafe<{
                project_id: string;
                name: string;
                project_policy: string;
                resource_source_json: string;
              }>(
                `SELECT p.project_id, p.name, p.project_policy,
                        p.resource_source_json
                   FROM projects p
                  WHERE p.project_id = ?
                  ORDER BY p.project_id`,
                [projectId],
              );
              const version = yield* sql.unsafe<{ user_version: number }>(
                "PRAGMA user_version",
              );
              return {
                rows,
                version: Number(version[0]?.user_version ?? 0),
                replayed,
              };
            }),
            layer({ filename: database.databaseFilename }),
          ),
        ),
      );
      expect(result.version).toBe(42);
      expect(result.replayed).toBe(0);
      expect(
        result.rows.map((row) => ({
          projectId: row.project_id,
          name: row.name,
          projectPolicy: row.project_policy,
          source: JSON.parse(row.resource_source_json),
        })),
      ).toEqual([
        {
          projectId,
          name: "P42 migration fixture",
          projectPolicy: "{}",
          source: { _tag: "LegacyUnknown" },
        },
      ]);
    } finally {
      database.cleanup();
    }
  }, 120_000);
});
