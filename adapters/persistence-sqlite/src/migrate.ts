import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type SqliteAdapterError, sqliteAdapterError } from "./errors.js";

export interface MigrationFile {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

export const splitStatements = (sql: string): ReadonlyArray<string> =>
  sql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

/**
 * Forward-only migration runner keyed on `PRAGMA user_version`.
 *
 * - refuses to start when the stored version is newer than the latest known
 *   migration;
 * - applies pending migrations in ascending id order;
 * - each migration runs in one transaction (statements + version bump).
 */
export const runMigrations = (
  migrations: ReadonlyArray<MigrationFile>,
): Effect.Effect<number, SqlError | SqliteAdapterError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const versionRows = yield* sql.unsafe<{ user_version: number }>(
      "PRAGMA user_version",
    );
    const current = Number(versionRows[0]?.user_version ?? 0);
    const latest = migrations.reduce(
      (max, migration) => Math.max(max, migration.id),
      0,
    );
    if (current > latest) {
      return yield* Effect.fail(
        sqliteAdapterError(
          `database user_version ${current} is newer than latest migration ${latest}`,
        ),
      );
    }
    const pending = [...migrations]
      .filter((migration) => migration.id > current)
      .sort((a, b) => a.id - b.id);
    for (const migration of pending) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const statement of splitStatements(migration.sql)) {
            yield* sql.unsafe(statement);
          }
          yield* sql.unsafe(`PRAGMA user_version = ${migration.id}`);
        }),
      );
    }
    return pending.length;
  });
