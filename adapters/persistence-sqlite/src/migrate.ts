import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type SqliteAdapterError, sqliteAdapterError } from "./errors.js";

export interface MigrationFile {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
  readonly foreignKeysOff?: boolean;
}

export const splitStatements = (sql: string): ReadonlyArray<string> => {
  const statements: string[] = [];
  let current = "";
  for (const character of sql) {
    if (character !== ";") {
      current += character;
      continue;
    }
    const trimmed = current.trim();
    const isTrigger = /^CREATE\s+TRIGGER\b/i.test(trimmed);
    if (isTrigger && !/\bEND$/i.test(trimmed)) {
      current += character;
      continue;
    }
    if (trimmed.length > 0) {
      statements.push(trimmed);
    }
    current = "";
  }
  const trailing = current.trim();
  if (trailing.length > 0) {
    statements.push(trailing);
  }
  return statements;
};

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
      const apply = Effect.gen(function* () {
        for (const statement of splitStatements(migration.sql)) {
          yield* sql.unsafe(statement);
        }
        yield* sql.unsafe(`PRAGMA user_version = ${migration.id}`);
      });
      if (migration.foreignKeysOff === true) {
        yield* sql.unsafe("PRAGMA foreign_keys = OFF");
        yield* sql.unsafe("PRAGMA legacy_alter_table = ON");
        yield* sql.withTransaction(apply).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* sql.unsafe("PRAGMA legacy_alter_table = OFF");
              yield* sql.unsafe("PRAGMA foreign_keys = ON");
            }).pipe(Effect.orDie),
          ),
        );
        const violations = yield* sql.unsafe("PRAGMA foreign_key_check");
        if (violations.length > 0) {
          return yield* Effect.fail(
            sqliteAdapterError(
              `migration ${migration.id} produced foreign-key violations`,
              violations,
            ),
          );
        }
      } else {
        yield* sql.withTransaction(apply);
      }
    }
    return pending.length;
  });
