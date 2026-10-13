import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  createSchema42PrivateTestDirectory,
  createSchema42TestDatabase,
  createSchema42TestDatabaseFactory,
  type Schema42TestDatabase,
} from "../../../tests/support/schema42-database.js";
import {
  layer,
  P42_PROJECT_RESOURCE_SOURCE_MIGRATION,
  runMigrations,
} from "../src/index.js";

const projectId = "prj_schema42_fixture";
const workspaceId = "ws_schema42_fixture";
const sessionId = "ses_schema42_fixture";
const executionId = "exe_schema42_fixture";
const attentionFactId = `att_${"a".repeat(64)}`;

const seedP38 = (filename: string) =>
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
                 ) VALUES (?, 'legacy schema-42 fixture project', ?, '{}', 0,
                           '{}', 'local', 'Open', 0, 't', 't')`,
                [projectId, workspaceId],
              );
              yield* sql.unsafe(
                `INSERT INTO sessions (
                   session_id, binding_kind, workspace_id, execution_id,
                   context_epoch, created_at
                 ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't')`,
                [sessionId, workspaceId],
              );
              yield* sql.unsafe(
                `INSERT INTO workspaces (
                   workspace_id, project_id, parent_workspace_id, name,
                   responsibility_definition, responsibility_revision,
                   resource_boundary, resource_boundary_revision, agent_binding,
                   primary_session_id, current_work_id, workspace_policy,
                   workspace_policy_revision, revision, lifecycle, created_at,
                   updated_at
                 ) VALUES (?, ?, NULL, 'root', '{}', 0,
                           '{"basisResponsibilityRevision":0,"addresses":[]}', 0,
                           '{}', ?, NULL, '{}', 0, 0, 'Active', 't', 't')`,
                [workspaceId, projectId, sessionId],
              );
              yield* sql.unsafe(
                `INSERT INTO executions (
                   execution_id, project_id, binding_kind, workspace_id,
                   episode_kind, episode_ref, episode_revision,
                   parent_execution_id, mission, session_id, admitted_at,
                   stop_requested_at, settlement_kind, settlement_json,
                   settled_at
                 ) VALUES (?, ?, 'execution_bound', ?, NULL, NULL, NULL, NULL,
                           'schema42 fixture qualification', ?, 't', NULL, NULL,
                           NULL, NULL)`,
                [executionId, projectId, workspaceId, sessionId],
              );
            }),
          );
        }),
        layer({ filename }),
      ),
    ),
  );

const runDatabase = <A>(
  filename: string,
  program: Effect.Effect<A, unknown, SqlClient>,
) =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(program, layer({ filename }))),
  );

describe("central schema-42 test database fixture", () => {
  it("removes the exact directory if private ACL setup fails", () => {
    let createdDirectory: string | undefined;
    expect(() =>
      createSchema42PrivateTestDirectory(
        tmpdir(),
        "arbor-schema42-acl-failure-",
        (directory) => {
          createdDirectory = directory;
          throw new Error("injected private ACL setup failure");
        },
        (directory) => rmSync(directory, { recursive: true, force: true }),
      ),
    ).toThrow("injected private ACL setup failure");
    expect(createdDirectory).toBeDefined();
    if (createdDirectory !== undefined) {
      expect(existsSync(createdDirectory)).toBe(false);
      expect(createdDirectory).toContain(
        join(tmpdir(), "arbor-schema42-acl-failure-"),
      );
    }
  });

  it("uses P38, privileged P39, standalone P40–P42 and reopens as a no-op", async () => {
    const database = await createSchema42TestDatabase({ seedP38 });
    try {
      expect(database.databaseFilename).not.toBe(database.p39ReportFilename);
      expect(existsSync(database.p39ReportFilename)).toBe(true);
      const first = await runDatabase(
        database.databaseFilename,
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const version = yield* sql.unsafe<{ user_version: number }>(
            "PRAGMA user_version",
          );
          const project = yield* sql.unsafe<{
            resource_source_json: string;
          }>("SELECT resource_source_json FROM projects WHERE project_id = ?", [
            projectId,
          ]);
          const sourceColumn = yield* sql.unsafe<{
            name: string;
            notnull: number;
          }>("PRAGMA table_info(projects)");
          const nullFact = yield* Effect.exit(
            sql.unsafe(
              `INSERT INTO submitted_decision_binding_attention_facts (
                 attention_fact_id, event_id, project_id, execution_id,
                 workspace_id, logical_step_no, repair_attempt,
                 provider_turn_id, logical_action_id, failure_code,
                 first_detected_at
               ) VALUES (NULL, 'evt_schema42_null', ?, ?, ?, 0, 0,
                         'ptn_schema42', 'lac_schema42_null',
                         'StepManifestMismatch', 't')`,
              [projectId, executionId, workspaceId],
            ),
          );
          yield* sql.unsafe(
            `INSERT INTO submitted_decision_binding_attention_facts (
               attention_fact_id, event_id, project_id, execution_id,
               workspace_id, logical_step_no, repair_attempt,
               provider_turn_id, logical_action_id, failure_code,
               first_detected_at
             ) VALUES (?, 'evt_schema42_valid', ?, ?, ?, 0, 0,
                       'ptn_schema42', 'lac_schema42_valid',
                       'StepManifestMismatch', 't')`,
            [attentionFactId, projectId, executionId, workspaceId],
          );
          yield* sql.unsafe(
            `INSERT INTO submitted_decision_binding_attention_rows (
               project_id, attention_fact_id, workspace_id
             ) VALUES (?, ?, ?)`,
            [projectId, attentionFactId, workspaceId],
          );
          const marker = yield* sql.unsafe<{ count: number }>(
            `SELECT COUNT(*) AS count
               FROM submitted_decision_binding_attention_rows
              WHERE project_id = ? AND attention_fact_id = ?`,
            [projectId, attentionFactId],
          );
          const foreignKeys = yield* sql.unsafe("PRAGMA foreign_key_check");
          return {
            version: Number(version[0]?.user_version ?? 0),
            foreignKeyViolations: foreignKeys.length,
            resourceSource: project[0]?.resource_source_json,
            resourceSourceNotNull: sourceColumn.find(
              ({ name }) => name === "resource_source_json",
            )?.notnull,
            nullFact,
            markerCount: Number(marker[0]?.count ?? 0),
          };
        }),
      );

      expect(first.version).toBe(42);
      expect(first.foreignKeyViolations).toBe(0);
      expect(first.resourceSource).toBe('{"_tag":"LegacyUnknown"}');
      expect(first.resourceSourceNotNull).toBe(1);
      expect(first.nullFact._tag).toBe("Failure");
      expect(first.markerCount).toBe(1);

      const reopened = await runDatabase(
        database.databaseFilename,
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const applied = yield* runMigrations([
            P42_PROJECT_RESOURCE_SOURCE_MIGRATION,
          ]);
          const version = yield* sql.unsafe<{ user_version: number }>(
            "PRAGMA user_version",
          );
          const project = yield* sql.unsafe<{
            resource_source_json: string;
          }>("SELECT resource_source_json FROM projects WHERE project_id = ?", [
            projectId,
          ]);
          return {
            applied,
            version: Number(version[0]?.user_version ?? 0),
            resourceSource: project[0]?.resource_source_json,
          };
        }),
      );
      expect(reopened).toEqual({
        applied: 0,
        version: 42,
        resourceSource: '{"_tag":"LegacyUnknown"}',
      });
    } finally {
      database.cleanup();
    }
  }, 120_000);

  it("clones a closed schema-42 template into isolated files and cleans up every clone", async () => {
    const factory = await createSchema42TestDatabaseFactory();
    let first: Schema42TestDatabase | undefined;
    let second: Schema42TestDatabase | undefined;
    try {
      first = factory.create();
      second = factory.create();
      expect(first.databaseFilename).not.toBe(second.databaseFilename);
      expect(first.p39ReportFilename).not.toBe(second.p39ReportFilename);
      expect(existsSync(first.p39ReportFilename)).toBe(true);
      expect(existsSync(second.p39ReportFilename)).toBe(true);

      await runDatabase(
        first.databaseFilename,
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql.unsafe(
            "CREATE TABLE schema42_clone_probe (value TEXT NOT NULL)",
          );
          yield* sql.unsafe(
            "INSERT INTO schema42_clone_probe (value) VALUES ('first')",
          );
        }),
      );

      const secondProbe = await runDatabase(
        second.databaseFilename,
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          return yield* sql.unsafe<{ name: string }>(
            "SELECT name FROM sqlite_schema WHERE name = 'schema42_clone_probe'",
          );
        }),
      );
      const secondVersion = await runDatabase(
        second.databaseFilename,
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const rows = yield* sql.unsafe<{ user_version: number }>(
            "PRAGMA user_version",
          );
          return Number(rows[0]?.user_version ?? 0);
        }),
      );
      expect(secondProbe).toEqual([]);
      expect(secondVersion).toBe(42);
    } finally {
      const directories = [first?.directory, second?.directory].filter(
        (directory): directory is string => directory !== undefined,
      );
      first?.cleanup();
      second?.cleanup();
      factory.cleanup();
      for (const directory of directories) {
        expect(existsSync(directory)).toBe(false);
      }
    }
  }, 120_000);
});
