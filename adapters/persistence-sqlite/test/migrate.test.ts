import { Effect, Exit } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer, type MigrationFile, runMigrations } from "../src/index.js";

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
});
