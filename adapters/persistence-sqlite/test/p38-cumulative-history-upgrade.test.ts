import { createHash } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { P37_MIGRATIONS, P38_MIGRATIONS } from "../src/migrations.js";
import { P38_EXECUTABLE_APPROVAL_MIGRATION } from "../src/p38-executable-approval-migration.js";

describe("P38 cumulative historical database upgrade", () => {
  it("preserves legacy approval identity and the 0033 composite FK through 0038", async () => {
    const db = layer({ filename: ":memory:" });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P37_MIGRATIONS);
          const sql = yield* SqlClient;
          const sourceVersion = yield* sql.unsafe<{ user_version: number }>(
            "PRAGMA user_version",
          );
          const sourceColumns = yield* sql.unsafe<{ name: string }>(
            "PRAGMA table_xinfo(action_approvals)",
          );
          const sourceApprovalStates = yield* sql.unsafe<{
            readonly route_kind: string;
            readonly state: string;
            readonly binding_proven: number;
            readonly row_count: number;
          }>(
            `SELECT route_kind, state, binding_proven,
                    COUNT(*) AS row_count
               FROM action_approvals
              GROUP BY route_kind, state, binding_proven
              ORDER BY route_kind, state, binding_proven`,
          );

          // This is a disposable 0037 fixture. These rows model legacy values
          // which 0038 may retain without inventing an executable binding.
          yield* sql.unsafe(
            `INSERT INTO action_approvals (
               approval_id, route_kind, project_id, workspace_id,
               execution_id, subject_ref, stable_action_id, action_version,
               side_effect_semantics, action_digest, arguments_json, target_ref,
               target_resource_space_ids_json, control_basis_digest, state,
               revision, requested_at, expires_at, decided_at, decided_by,
               decision_reason, consumed_at, consumed_by, binding_proven,
               source_state
             ) VALUES
             (
               'cap_legacy_expired', 'Control', 'prj_history', 'ws_history',
               'exe_history', 'legacy:unbound', 'core.control.assign-work',
               'legacy', 'InternalControl', 'legacy-control-digest', '{}',
               'ws_history', '[]', 'legacy-basis', 'Expired', 0,
               '2026-10-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z',
               NULL, NULL, 'MigrationUnprovableSubject', NULL, NULL, 0,
               'Pending'
             ),
             (
               'apr_legacy_consumed', 'Executable', NULL, NULL, NULL,
               'legacy:unbound', 'shell', '1', 'LegacyUnknown',
               'legacy-executable-digest', '{}', '["filesystem"]',
               '["filesystem"]', 'legacy-basis', 'Consumed', 2,
               '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z',
               '2026-10-01T00:10:00.000Z', 'migration:p4', NULL,
               '2026-10-01T00:11:00.000Z', 'tin_legacy_consumed', 0,
               'Consumed'
             )`,
          );

          const applied = yield* runMigrations(P38_MIGRATIONS);
          const repeated = yield* runMigrations(P38_MIGRATIONS);
          const version = yield* sql.unsafe<{ user_version: number }>(
            "PRAGMA user_version",
          );
          const foreignKeys = yield* sql.unsafe<{
            readonly table: string;
            readonly from: string;
            readonly to: string;
          }>("PRAGMA foreign_key_list(assign_work_target_bindings)");
          const approvals = yield* sql.unsafe<{
            readonly approval_id: string;
            readonly route_kind: string;
            readonly state: string;
            readonly revision: number;
            readonly consumed_at: string | null;
            readonly consumed_by: string | null;
            readonly binding_proven: number;
            readonly source_state: string | null;
          }>(
            `SELECT approval_id, route_kind, state, revision, consumed_at,
                    consumed_by, binding_proven, source_state
               FROM action_approvals ORDER BY approval_id`,
          );
          const targetColumns = yield* sql.unsafe<{ name: string }>(
            "PRAGMA table_xinfo(action_approvals)",
          );
          const violations = yield* sql.unsafe<Record<string, unknown>>(
            "PRAGMA foreign_key_check",
          );
          const foreignKeysEnabled = yield* sql.unsafe<{
            readonly foreign_keys: number;
          }>("PRAGMA foreign_keys");
          const indexes = yield* sql.unsafe<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'index'
               AND name IN (
                 'action_approvals_control_exact_action',
                 'action_approvals_executable_logical_action',
                 'action_approvals_id_project',
                 'action_approvals_pending'
               ) ORDER BY name`,
          );

          console.info(
            "P38_HISTORICAL_UPGRADE_OBSERVATION",
            JSON.stringify({
              sourceVersion: Number(sourceVersion[0]?.user_version),
              sourceMigrationHighWater: Math.max(
                ...P37_MIGRATIONS.map(({ id }) => id),
              ),
              sourceColumns: sourceColumns.map(({ name }) => name),
              p38DescriptorVersion:
                P38_EXECUTABLE_APPROVAL_MIGRATION.migrationVersion,
              p38DescriptorSqlSha256: createHash("sha256")
                .update(P38_EXECUTABLE_APPROVAL_MIGRATION.sql)
                .digest("hex"),
              currentCommit: process.env.ARBOR_HISTORICAL_FIXTURE_HEAD ?? null,
              p38DescriptorSelectsOldTable:
                P38_EXECUTABLE_APPROVAL_MIGRATION.sql.includes(
                  "FROM action_approvals",
                ),
              applied,
              repeated,
              version: Number(version[0]?.user_version),
              targetColumns: targetColumns.map(({ name }) => name),
              sourceApprovalStates,
              targetApprovalStates: approvals.map(
                ({ route_kind, state, binding_proven }) => ({
                  route_kind,
                  state,
                  binding_proven,
                }),
              ),
              foreignKeys: foreignKeys.map(({ table, from, to }) => ({
                table,
                from,
                to,
              })),
              foreignKeyViolationCount: violations.length,
              foreignKeysEnabled: Number(foreignKeysEnabled[0]?.foreign_keys),
              indexes: indexes.map(({ name }) => name),
            }),
          );
          return {
            sourceVersion: Number(sourceVersion[0]?.user_version),
            sourceMigrationHighWater: Math.max(
              ...P37_MIGRATIONS.map(({ id }) => id),
            ),
            sourceColumns: sourceColumns.map(({ name }) => name),
            sourceApprovalStates,
            p38DescriptorVersion:
              P38_EXECUTABLE_APPROVAL_MIGRATION.migrationVersion,
            p38DescriptorSqlSha256: createHash("sha256")
              .update(P38_EXECUTABLE_APPROVAL_MIGRATION.sql)
              .digest("hex"),
            currentCommit: process.env.ARBOR_HISTORICAL_FIXTURE_HEAD ?? null,
            p38DescriptorSelectsOldTable:
              P38_EXECUTABLE_APPROVAL_MIGRATION.sql.includes(
                "FROM action_approvals",
              ),
            applied,
            repeated,
            version: Number(version[0]?.user_version),
            targetColumns: targetColumns.map(({ name }) => name),
            approvals,
            foreignKeys,
            violations,
            foreignKeysEnabled: Number(foreignKeysEnabled[0]?.foreign_keys),
            indexes: indexes.map(({ name }) => name),
          };
        }),
        db,
      ),
    );

    expect(result.sourceVersion).toBe(37);
    expect(result.sourceMigrationHighWater).toBe(37);
    expect(result.sourceColumns).not.toContain("cancelled_at");
    expect(result.sourceColumns).not.toContain("cancelled_by");
    expect(result.sourceColumns).not.toContain("cancellation_reason");
    expect(result.p38DescriptorVersion).toBe(38);
    expect(result.p38DescriptorSelectsOldTable).toBe(true);
    expect(result.applied).toBe(1);
    expect(result.repeated).toBe(0);
    expect(result.version).toBe(38);
    expect(result.targetColumns).toContain("cancelled_at");
    expect(result.targetColumns).toContain("cancelled_by");
    expect(result.targetColumns).toContain("cancellation_reason");
    expect(result.approvals).toEqual([
      {
        approval_id: "apr_legacy_consumed",
        route_kind: "Executable",
        state: "Consumed",
        revision: 2,
        consumed_at: "2026-10-01T00:11:00.000Z",
        consumed_by: "tin_legacy_consumed",
        binding_proven: 0,
        source_state: "Consumed",
      },
      {
        approval_id: "cap_legacy_expired",
        route_kind: "Control",
        state: "Expired",
        revision: 0,
        consumed_at: null,
        consumed_by: null,
        binding_proven: 0,
        source_state: "Pending",
      },
    ]);
    expect(
      result.foreignKeys.map(({ table, from, to }) => ({ table, from, to })),
    ).toContainEqual({
      table: "action_approvals",
      from: "action_approval_id",
      to: "approval_id",
    });
    expect(result.violations).toEqual([]);
    expect(result.foreignKeysEnabled).toBe(1);
    expect(result.indexes).toEqual([
      "action_approvals_control_exact_action",
      "action_approvals_executable_logical_action",
      "action_approvals_id_project",
      "action_approvals_pending",
    ]);
  });
});
