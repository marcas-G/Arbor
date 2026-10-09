import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { P33_MIGRATIONS, P34_MIGRATIONS } from "../src/migrations.js";

const runDb = <A>(program: Effect.Effect<A, unknown, SqlClient>) =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(program, layer({ filename: ":memory:" }))),
  );

describe("P34 P10 Attention projection migration", () => {
  it("upgrades a P33 database without changing P9 source rows or rerunning DDL", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P33_MIGRATIONS);
      const sql = yield* SqlClient;
      const beforeVersion = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      const beforeObjects = yield* sql.unsafe<{ name: string }>(
        `SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name IN ('assign_work_binding_attention_facts', 'attention_projection_rows')
          ORDER BY name`,
      );

      const migrated = yield* runMigrations(P34_MIGRATIONS);
      const afterVersion = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      const p34Columns = yield* sql.unsafe<{ name: string }>(
        'PRAGMA table_info("attention_projection_rows")',
      );
      const foreignKeys = yield* sql.unsafe<{ table: string }>(
        'PRAGMA foreign_key_list("attention_projection_rows")',
      );
      const reapplied = yield* runMigrations(P34_MIGRATIONS);
      return {
        beforeVersion: Number(beforeVersion[0]?.user_version ?? 0),
        beforeObjects: beforeObjects.map((row) => row.name),
        migrated,
        afterVersion: Number(afterVersion[0]?.user_version ?? 0),
        columns: p34Columns.map((row) => row.name),
        foreignKeys: foreignKeys.map((row) => row.table),
        reapplied,
      };
    });

    const result = await runDb(program);
    expect(result.beforeVersion).toBe(33);
    expect(result.beforeObjects).toEqual([
      "assign_work_binding_attention_facts",
    ]);
    expect(result.migrated).toBe(1);
    expect(result.afterVersion).toBe(34);
    expect(result.columns).toEqual(
      expect.arrayContaining([
        "project_id",
        "dedup_key",
        "source",
        "severity",
        "target_workspace_id",
        "summary",
        "failure_code",
        "occurred_at",
        "source_event_id",
        "source_fact_id",
      ]),
    );
    expect(result.foreignKeys).toEqual(
      expect.arrayContaining([
        "domain_events",
        "assign_work_binding_attention_facts",
        "workspaces",
      ]),
    );
    expect(result.reapplied).toBe(0);
  });

  it("creates the same P34 schema from a fresh database", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P34_MIGRATIONS);
      const sql = yield* SqlClient;
      const version = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      const table = yield* sql.unsafe<{ name: string }>(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'attention_projection_rows'`,
      );
      return {
        version: Number(version[0]?.user_version ?? 0),
        table: table[0]?.name,
      };
    });

    await expect(runDb(program)).resolves.toEqual({
      version: 34,
      table: "attention_projection_rows",
    });
  });
});
