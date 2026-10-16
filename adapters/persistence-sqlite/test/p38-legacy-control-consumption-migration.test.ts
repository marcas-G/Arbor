import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { P37_MIGRATIONS, P38_MIGRATIONS } from "../src/migrations.js";

describe("P38 legacy Control approval migration boundary", () => {
  it("preserves an unbound historical consumption and blocks 0038 without inventing a CommandId", async () => {
    const db = layer({ filename: ":memory:" });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P37_MIGRATIONS);
          const sql = yield* SqlClient;
          yield* sql.unsafe(
            `INSERT INTO action_approvals (
               approval_id, route_kind, project_id, workspace_id,
               execution_id, subject_ref, stable_action_id, action_version,
               side_effect_semantics, action_digest, arguments_json, target_ref,
               target_resource_space_ids_json, control_basis_digest, state,
               revision, requested_at, expires_at, decided_at, decided_by,
               decision_reason, consumed_at, consumed_by, binding_proven,
               source_state
             ) VALUES (
               'cap_legacy_consumed', 'Control', 'prj_legacy', 'ws_legacy',
               'exe_legacy', 'legacy:unbound', 'core.control.assign-work',
               'legacy', 'InternalControl', 'legacy-digest', '{}',
               'ws_legacy', '[]', 'legacy-basis', 'Consumed', 2,
               '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z',
               '2026-10-01T00:10:00.000Z', 'user:legacy', NULL,
               '2026-10-01T00:11:00.000Z', NULL, 0, 'Consumed'
             )`,
          );

          const migrationFailure = yield* Effect.match(
            runMigrations(P38_MIGRATIONS),
            {
              onFailure: (cause) => {
                const error = cause as {
                  readonly _tag?: unknown;
                  readonly message?: unknown;
                  readonly reason?: {
                    readonly cause?: {
                      readonly errcode?: unknown;
                      readonly errstr?: unknown;
                    };
                  };
                };
                return {
                  tag: String(error._tag ?? "unknown"),
                  message: String(error.message ?? cause),
                  sqliteErrorCode: Number(error.reason?.cause?.errcode),
                  sqliteErrorMessage: String(error.reason?.cause?.errstr),
                };
              },
              onSuccess: () => null,
            },
          );
          const version = yield* sql.unsafe<{ user_version: number }>(
            "PRAGMA user_version",
          );
          const rows = yield* sql.unsafe<{
            readonly approval_id: string;
            readonly state: string;
            readonly revision: number;
            readonly consumed_at: string | null;
            readonly consumed_by: string | null;
            readonly binding_proven: number;
          }>(
            `SELECT approval_id, state, revision, consumed_at, consumed_by,
                    binding_proven
               FROM action_approvals WHERE approval_id = 'cap_legacy_consumed'`,
          );
          const p38Table = yield* sql.unsafe<{ count: number }>(
            `SELECT COUNT(*) AS count FROM sqlite_master
              WHERE type = 'table' AND name = 'action_approvals_p38'`,
          );
          return {
            migrationFailure,
            userVersion: Number(version[0]?.user_version),
            rows,
            p38TableCount: Number(p38Table[0]?.count),
          };
        }),
        db,
      ),
    );

    expect(result.migrationFailure).not.toBeNull();
    expect(result.migrationFailure).toMatchObject({
      tag: "SqlError",
      message: "Failed to execute statement",
      sqliteErrorCode: 275,
      sqliteErrorMessage: "constraint failed",
    });
    expect(result.userVersion).toBe(37);
    expect(result.rows).toEqual([
      {
        approval_id: "cap_legacy_consumed",
        state: "Consumed",
        revision: 2,
        consumed_at: "2026-10-01T00:11:00.000Z",
        consumed_by: null,
        binding_proven: 0,
      },
    ]);
    expect(result.p38TableCount).toBe(0);
  });
});
