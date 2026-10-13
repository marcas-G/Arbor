import { Effect, Exit } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  type MigrationFile,
  runMigrations,
  splitStatements,
} from "../src/index.js";

const init: MigrationFile = {
  id: 1,
  name: "init",
  sql: "CREATE TABLE t (id TEXT PRIMARY KEY); INSERT INTO t (id) VALUES ('a')",
};

const withClient = <A, E>(
  program: Effect.Effect<A, E, SqlClient>,
): Promise<A> =>
  Effect.runPromise(Effect.provide(program, layer({ filename: ":memory:" })));

describe("sqlite adapter migration runner", () => {
  it("keeps semicolons inside SQL string literals in the same statement", () => {
    expect(
      splitStatements(
        "CREATE TABLE t (summary TEXT DEFAULT 'first; second'); INSERT INTO t VALUES ('a;b')",
      ),
    ).toEqual([
      "CREATE TABLE t (summary TEXT DEFAULT 'first; second')",
      "INSERT INTO t VALUES ('a;b')",
    ]);
  });

  it("applies pending migrations and sets user_version", async () => {
    const result = await withClient(
      Effect.gen(function* () {
        const applied = yield* runMigrations([init]);
        const sql = yield* SqlClient;
        const version = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        const foreignKeys = yield* sql.unsafe<{ foreign_keys: number }>(
          "PRAGMA foreign_keys",
        );
        const rows = yield* sql.unsafe<{ id: string }>("SELECT id FROM t");
        return {
          applied,
          version: version[0]?.user_version,
          foreignKeys: foreignKeys[0]?.foreign_keys,
          rows: rows.length,
        };
      }),
    );
    expect(result.applied).toBe(1);
    expect(result.version).toBe(1);
    expect(result.foreignKeys).toBe(1);
    expect(result.rows).toBe(1);
  });

  it("is idempotent for already-applied migrations", async () => {
    const applied = await withClient(
      Effect.gen(function* () {
        yield* runMigrations([init]);
        return yield* runMigrations([init]);
      }),
    );
    expect(applied).toBe(0);
  });

  it("refuses a database newer than the latest known migration", async () => {
    const exit = await withClient(
      Effect.gen(function* () {
        yield* runMigrations([init]);
        return yield* Effect.exit(runMigrations([]));
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause;
      expect(JSON.stringify(error)).toContain("newer than latest");
    }
  });

  it("refuses migration 39 before executing any caller-supplied SQL", async () => {
    const migration39: MigrationFile = {
      id: 39,
      name: "forbidden-generic-p39",
      sql: "CREATE TABLE must_not_exist (id INTEGER)",
    };
    const result = await withClient(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const exit = yield* Effect.exit(runMigrations([migration39]));
        const version = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        const table = yield* sql.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_schema WHERE name = 'must_not_exist'",
        );
        return {
          exit,
          version: version[0]?.user_version,
          tableCount: table.length,
        };
      }),
    );
    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(JSON.stringify(result.exit)).toContain(
      "trusted P39 maintenance coordinator",
    );
    expect(result.version).toBe(0);
    expect(result.tableCount).toBe(0);
  });

  it("checks each gated descriptor against the version immediately before its transaction", async () => {
    const after39: MigrationFile = {
      id: 40,
      name: "after-p39",
      requiresUserVersion: 39,
      sql: "CREATE TABLE applied_after_39 (id INTEGER)",
    };
    const after41: MigrationFile = {
      id: 42,
      name: "after-p41",
      requiresUserVersion: 41,
      sql: "CREATE TABLE must_not_apply_after_40 (id INTEGER)",
    };
    const result = await withClient(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql.unsafe("PRAGMA user_version = 39");
        const exit = yield* Effect.exit(runMigrations([after39, after41]));
        const version = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        const appliedTable = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'applied_after_39'",
        );
        const skippedTable = yield* sql.unsafe<{ count: number }>(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'must_not_apply_after_40'",
        );
        return {
          exit,
          version: version[0]?.user_version,
          appliedTableCount: Number(appliedTable[0]?.count ?? 0),
          skippedTableCount: Number(skippedTable[0]?.count ?? 0),
        };
      }),
    );
    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(JSON.stringify(result.exit)).toContain(
      "migration 42 requires database user_version 41, found 40",
    );
    expect(result.version).toBe(40);
    expect(result.appliedTableCount).toBe(1);
    expect(result.skippedTableCount).toBe(0);
  });

  it("rejects an omitted predecessor even when a descriptor has no explicit gate", async () => {
    const afterMissingStep: MigrationFile = {
      id: 2,
      name: "after-missing-migration-1",
      sql: "CREATE TABLE must_not_apply_after_missing_predecessor (id INTEGER)",
    };
    const result = await withClient(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const exit = yield* Effect.exit(runMigrations([afterMissingStep]));
        const version = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        const table = yield* sql.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_schema WHERE name = 'must_not_apply_after_missing_predecessor'",
        );
        return {
          exit,
          version: version[0]?.user_version,
          tableCount: table.length,
        };
      }),
    );
    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(JSON.stringify(result.exit)).toContain(
      "migration 2 requires database user_version 1, found 0",
    );
    expect(result.version).toBe(0);
    expect(result.tableCount).toBe(0);
  });
});
