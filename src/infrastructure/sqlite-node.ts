import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect, Layer } from "effect";
import { DbError, type DbHandle, SqlitePort } from "../application/ports.js";

const tryE = <T>(f: () => T): Effect.Effect<T, DbError> =>
  Effect.try({ try: f, catch: (e) => new DbError({ message: String(e) }) });

export interface MigrationFile {
  readonly version: number;
  readonly file: string;
  readonly sql: string;
}

export function listMigrations(cwd: string): MigrationFile[] {
  const dir = resolve(cwd, "migrations");
  return readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .map((f) => ({
      version: Number.parseInt(f.split("_")[0] ?? "", 10),
      file: f,
      sql: readFileSync(join(dir, f), "utf8"),
    }))
    .sort((a, b) => a.version - b.version);
}

export const SqliteNodeLive = Layer.succeed(
  SqlitePort,
  SqlitePort.of({
    open: (dbFile: string): Effect.Effect<DbHandle, DbError> =>
      Effect.gen(function* () {
        const db = yield* tryE(() => {
          const d = new Database(dbFile);
          d.pragma("journal_mode = WAL");
          d.pragma("foreign_keys = ON");
          return d;
        });
        const handle: DbHandle = {
          queryOne: (sql, ...params) =>
            tryE(() => db.prepare(sql).get(...params) as Record<string, unknown> | undefined),
          execute: (sql, ...params) => tryE(() => void db.prepare(sql).run(...params)),
          close: () => tryE(() => void db.close()),
        };
        for (const m of listMigrations(process.cwd())) {
          // fresh DB has no schema_migrations yet — the first migration creates it,
          // so treat "no such table" as "not applied" rather than a hard failure
          const applied = yield* handle
            .queryOne("SELECT version FROM schema_migrations WHERE version = ?", m.version)
            .pipe(Effect.catchCause(() => Effect.succeed(undefined)));
          if (applied !== undefined) {
            continue;
          }
          yield* tryE(() => {
            db.transaction(() => {
              db.exec(m.sql);
              db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
                m.version,
                new Date().toISOString(),
              );
            })();
          });
        }
        return handle;
      }),
  }),
);
