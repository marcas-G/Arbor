import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqliteAdapterError } from "./errors.js";
import { sqliteAdapterError } from "./errors.js";

export const P39_WRITER_LOCK_DDL = `
CREATE TABLE IF NOT EXISTS p39_writer_lock (
  lock_id INTEGER PRIMARY KEY CHECK (lock_id = 1)
);
INSERT OR IGNORE INTO p39_writer_lock (lock_id) VALUES (1);
`;

export interface P39DatabaseWriterPermit {
  readonly token: string;
  readonly mode: "RuntimeShared" | "MaintenanceExclusive";
}

export interface P39WriterLockFailure {
  readonly _tag: "P39WriterLockFailure";
  readonly code:
    | "P39_WRITER_LOCK_PATH_INVALID"
    | "P39_WRITER_LOCK_SCHEMA_INVALID"
    | "P39_WRITER_LOCK_ACQUIRE_FAILED"
    | "P39_WRITER_LOCK_RELEASE_FAILED";
  readonly cause?: unknown;
}

export interface P39WriterLockClientService {
  readonly acquire: (
    mode: P39DatabaseWriterPermit["mode"],
  ) => Effect.Effect<P39DatabaseWriterPermit, P39WriterLockFailure>;
  readonly release: (
    permit: P39DatabaseWriterPermit,
  ) => Effect.Effect<void, P39WriterLockFailure>;
}

export class P39WriterLockClient extends Context.Service<
  P39WriterLockClient,
  P39WriterLockClientService
>()("arbor/P39WriterLockClient") {}

/** A stable local lock-database path for all processes using one primary DB.
 * The caller must reject network/unknown filesystems before opening it. */
export const p39WriterLockFilename = (
  primaryDatabaseFilename: string,
): string | P39WriterLockFailure => {
  if (
    primaryDatabaseFilename === ":memory:" ||
    primaryDatabaseFilename.trim().length === 0 ||
    primaryDatabaseFilename.startsWith("file:")
  ) {
    return {
      _tag: "P39WriterLockFailure",
      code: "P39_WRITER_LOCK_PATH_INVALID",
    };
  }
  try {
    const resolved = resolve(primaryDatabaseFilename);
    const canonical = existsSync(resolved)
      ? realpathSync.native(resolved)
      : resolved;
    if (
      canonical.startsWith("\\\\") ||
      (process.platform === "win32" &&
        !/^(?:\\\\\?\\)?[a-z]:\\/iu.test(canonical))
    ) {
      return {
        _tag: "P39WriterLockFailure",
        code: "P39_WRITER_LOCK_PATH_INVALID",
      };
    }
    return `${canonical}.p39-maintenance-lock.sqlite`;
  } catch {
    return {
      _tag: "P39WriterLockFailure",
      code: "P39_WRITER_LOCK_PATH_INVALID",
    };
  }
};

/** The lock database uses rollback-journal mode, whose cross-process SHARED
 * and EXCLUSIVE VFS locks provide daemon-reader / maintenance-writer exclusion.
 * It contains no application data and is separate from both primary and audit
 * sidecar databases. Process death closes SQLite handles and releases the lock. */
export const p39WriterLockLayer = (
  filename: string,
  busyTimeoutMs = 30_000,
): Layer.Layer<P39WriterLockClient, SqliteAdapterError> => {
  const lockClient = Layer.effect(
    P39WriterLockClient,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const currentMode = yield* sql.unsafe<{ journal_mode: string }>(
        "PRAGMA journal_mode",
      );
      if (currentMode[0]?.journal_mode?.toLowerCase() !== "delete") {
        const tables = yield* sql.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        );
        if (tables.length > 0) {
          return yield* Effect.fail(
            sqliteAdapterError(
              "P39 writer lock database must use DELETE journal mode",
            ),
          );
        }
        const mode = yield* sql.unsafe<{ journal_mode: string }>(
          "PRAGMA journal_mode = DELETE",
        );
        if (mode[0]?.journal_mode?.toLowerCase() !== "delete") {
          return yield* Effect.fail(
            sqliteAdapterError(
              "P39 writer lock database requires DELETE journal mode",
            ),
          );
        }
      }
      if (currentMode.length === 0) {
        return yield* Effect.fail(
          sqliteAdapterError(
            "P39 writer lock database journal mode could not be read",
          ),
        );
      }
      yield* sql.unsafe(
        `PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`,
      );
      yield* sql.unsafe("PRAGMA synchronous = FULL");
      yield* sql.unsafe("PRAGMA foreign_keys = ON");
      const existing = yield* sql.unsafe<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'p39_writer_lock'",
      );
      if (existing.length === 0) {
        const userObjects = yield* sql.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
        );
        if (userObjects.length > 0) {
          return yield* Effect.fail(
            sqliteAdapterError(
              "P39 writer lock database contains an unsupported schema",
            ),
          );
        }
        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (const statement of P39_WRITER_LOCK_DDL.split(";")
              .map((part) => part.trim())
              .filter(Boolean)) {
              yield* sql.unsafe(statement);
            }
          }),
        );
      }
      const identity = yield* sql.unsafe<{ lock_id: number }>(
        "SELECT lock_id FROM p39_writer_lock",
      );
      if (identity.length !== 1 || Number(identity[0]?.lock_id) !== 1) {
        return yield* Effect.fail(
          sqliteAdapterError(
            "P39 writer lock database has an invalid identity row",
          ),
        );
      }
      const activePermitTokens = new Set<string>();
      const acquire = (mode: P39DatabaseWriterPermit["mode"]) =>
        Effect.gen(function* () {
          const begin = mode === "RuntimeShared" ? "BEGIN" : "BEGIN EXCLUSIVE";
          yield* sql.unsafe(begin);
          const identity = yield* Effect.exit(
            sql.unsafe<{ lock_id: number }>(
              "SELECT lock_id FROM p39_writer_lock WHERE lock_id = 1",
            ),
          );
          if (identity._tag === "Failure") {
            yield* sql.unsafe("ROLLBACK").pipe(Effect.ignore);
            return yield* Effect.failCause(identity.cause);
          }
          const row = identity.value;
          if (row.length !== 1) {
            yield* sql.unsafe("ROLLBACK").pipe(Effect.ignore);
            return yield* Effect.fail({
              _tag: "P39WriterLockFailure" as const,
              code: "P39_WRITER_LOCK_SCHEMA_INVALID" as const,
            });
          }
          const permit = { token: randomUUID(), mode };
          activePermitTokens.add(permit.token);
          return permit;
        }).pipe(
          Effect.mapError((cause) => ({
            _tag: "P39WriterLockFailure" as const,
            code: "P39_WRITER_LOCK_ACQUIRE_FAILED" as const,
            cause,
          })),
        );
      const release = (permit: P39DatabaseWriterPermit) => {
        if (!activePermitTokens.delete(permit.token)) {
          return Effect.fail({
            _tag: "P39WriterLockFailure" as const,
            code: "P39_WRITER_LOCK_RELEASE_FAILED" as const,
          });
        }
        return sql.unsafe("ROLLBACK").pipe(
          Effect.asVoid,
          Effect.mapError((cause) => ({
            _tag: "P39WriterLockFailure" as const,
            code: "P39_WRITER_LOCK_RELEASE_FAILED" as const,
            cause,
          })),
        );
      };
      return P39WriterLockClient.of({
        acquire: (mode) => acquire(mode),
        release,
      });
    }).pipe(
      Effect.mapError((cause) =>
        typeof cause === "object" &&
        cause !== null &&
        "_tag" in cause &&
        cause._tag === "SqliteAdapterError"
          ? (cause as SqliteAdapterError)
          : sqliteAdapterError(
              "failed to initialize P39 writer lock database",
              cause,
            ),
      ),
    ),
  );
  return Layer.provide(
    lockClient,
    SqliteClient.layer({ filename, disableWAL: true }),
  );
};

export const acquireP39RuntimeWriterPermit = (): Effect.Effect<
  P39DatabaseWriterPermit,
  P39WriterLockFailure,
  P39WriterLockClient
> =>
  Effect.flatMap(P39WriterLockClient, (client) =>
    client.acquire("RuntimeShared"),
  );

export const acquireP39MaintenanceWriterExclusion = (): Effect.Effect<
  P39DatabaseWriterPermit,
  P39WriterLockFailure,
  P39WriterLockClient
> =>
  Effect.flatMap(P39WriterLockClient, (client) =>
    client.acquire("MaintenanceExclusive"),
  );

export const releaseP39WriterPermit = (
  _permit: P39DatabaseWriterPermit,
): Effect.Effect<void, P39WriterLockFailure, P39WriterLockClient> =>
  Effect.flatMap(P39WriterLockClient, (client) => client.release(_permit));
