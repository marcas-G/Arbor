import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  realpathSync,
  statfsSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sha256Hex } from "@arbor/ports";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Context, Duration, Effect, Exit, Layer, Scope } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { SqliteAdapterError } from "./errors.js";
import { sqliteAdapterError } from "./errors.js";
import {
  type P39WindowsProtectedPath,
  validateWindowsProtectedPaths,
} from "./p39-windows-security.js";

export const P39_WRITER_LOCK_DDL = `
CREATE TABLE IF NOT EXISTS p39_writer_lock (
  lock_id INTEGER PRIMARY KEY CHECK (lock_id = 1)
);
INSERT OR IGNORE INTO p39_writer_lock (lock_id) VALUES (1);
`;

export const sameOperatingSystemIdentity = (
  ownerIdentity: string,
  processIdentity: string,
): boolean => ownerIdentity.length > 0 && ownerIdentity === processIdentity;

export interface DatabaseWriterPermit {
  readonly token: string;
  readonly mode: "RuntimeShared" | "MaintenanceExclusive";
}

export interface DatabaseWriterLockFailure {
  readonly _tag: "DatabaseWriterLockFailure";
  readonly code:
    | "P39_WRITER_LOCK_PATH_INVALID"
    | "P39_WRITER_LOCK_UNSUPPORTED_DEPLOYMENT"
    | "P39_WRITER_LOCK_SCHEMA_INVALID"
    | "P39_WRITER_LOCK_ACQUIRE_FAILED"
    | "P39_WRITER_LOCK_RELEASE_FAILED";
  readonly cause?: unknown;
}

export interface DatabaseWriterLockClientService {
  readonly acquire: (
    mode: DatabaseWriterPermit["mode"],
  ) => Effect.Effect<
    DatabaseWriterPermit,
    DatabaseWriterLockFailure | SqliteAdapterError
  >;
  readonly release: (
    permit: DatabaseWriterPermit,
  ) => Effect.Effect<void, DatabaseWriterLockFailure>;
}

export class DatabaseWriterLockClient extends Context.Service<
  DatabaseWriterLockClient,
  DatabaseWriterLockClientService
>()("arbor/DatabaseWriterLockClient") {}

/** v1 supports one OS identity owning the daemon, maintenance process, primary,
 * writer lock and audit sidecar. Different owners and any other writers fail
 * closed; deployments needing separate service/operator identities need a
 * separately governed shared-ACL profile. */
const validateProtectedPaths = (
  paths: ReadonlyArray<P39WindowsProtectedPath>,
): boolean => {
  if (paths.length === 0) return false;
  try {
    const entries = paths.map(({ path, kind }) => ({
      path,
      kind,
      stat: statSync(path, { bigint: true }),
    }));
    for (const { kind, stat } of entries) {
      if (
        (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) ||
        stat.dev === 0n ||
        (kind === "file" && (stat.ino === 0n || stat.nlink !== 1n))
      ) {
        return false;
      }
    }
    if (process.platform === "win32") {
      return validateWindowsProtectedPaths(paths);
    }
    const currentUid = process.getuid?.();
    if (currentUid === undefined) return false;
    for (const { path, kind, stat } of entries) {
      if (!isSupportedLocalFilesystem(path)) {
        return false;
      }
      const mode = Number(stat.mode & 0o7777n);
      if (
        !sameOperatingSystemIdentity(
          `uid:${stat.uid}`,
          `uid:${currentUid}`,
        ) ||
        (mode & 0o022) !== 0 ||
        (kind === "directory" ? (mode & 0o100) === 0 : (mode & 0o200) === 0)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
};

export const validateProtectedDirectory = (directory: string): boolean =>
  validateProtectedPaths([{ path: directory, kind: "directory" }]);

export const validateProtectedFile = (filename: string): boolean =>
  validateProtectedPaths([{ path: filename, kind: "file" }]);

/** A primary-adjacent lock path shared by daemon and maintenance under the same
 * validated OS identity. The v1 owner profile deliberately rejects other OS
 * identities before either process can migrate or assemble P4. */
const databaseWriterLockFilenameValidatedParent = (
  primaryDatabaseFilename: string,
  parentAlreadyValidated: boolean,
): string | DatabaseWriterLockFailure => {
  if (
    primaryDatabaseFilename === ":memory:" ||
    primaryDatabaseFilename.trim().length === 0 ||
    primaryDatabaseFilename.startsWith("file:")
  ) {
    return unsupportedWriterDeployment();
  }
  try {
    const resolved = resolve(primaryDatabaseFilename);
    if (!existsSync(resolved)) return invalidLockPath();
    const canonical = realpathSync.native(resolved);
    const normalizePath = normalizeForPlatform;
    if (
      canonical.startsWith("\\\\") ||
      normalizePath(resolved) !== normalizePath(canonical) ||
      (process.platform === "win32" &&
        !/^(?:\\\\\?\\)?[a-z]:\\/iu.test(canonical))
    ) {
      return {
        _tag: "DatabaseWriterLockFailure",
        code: "P39_WRITER_LOCK_PATH_INVALID",
      };
    }
    const stat = statSync(canonical, { bigint: true });
    if (
      !stat.isFile() ||
      stat.dev === 0n ||
      stat.ino === 0n ||
      stat.nlink !== 1n
    ) {
      return invalidLockPath();
    }
    const parent = dirname(canonical);
    const filename = join(
      parent,
      `.arbor-p39-writer-${sha256Hex(`${stat.dev}:${stat.ino}`)}.sqlite`,
    );
    const parentStat = statSync(parent, { bigint: true });
    const sharedGroupDirectory =
      process.platform !== "win32" &&
      (Number(parentStat.mode & 0o7777n) & 0o020) !== 0;
    const lockFileMode = sharedGroupDirectory ? 0o660 : 0o600;
    if (
      !existsSync(filename) &&
      !parentAlreadyValidated &&
      !validateProtectedPaths([
        { path: parent, kind: "directory" },
        { path: canonical, kind: "file" },
      ])
    ) {
      return unsupportedWriterDeployment();
    }
    if (!existsSync(filename)) {
      try {
        const descriptor = openSync(filename, "wx", lockFileMode);
        closeSync(descriptor);
        if (process.platform !== "win32") chmodSync(filename, lockFileMode);
      } catch (cause) {
        if (
          typeof cause !== "object" ||
          cause === null ||
          !("code" in cause) ||
          cause.code !== "EEXIST"
        ) {
          return invalidLockPath();
        }
      }
    }
    if (!existsSync(filename)) return invalidLockPath();
    const canonicalLock = realpathSync.native(filename);
    const lockStat = statSync(canonicalLock, { bigint: true });
    if (
      normalizePath(resolve(filename)) !== normalizePath(canonicalLock) ||
      !lockStat.isFile() ||
      lockStat.dev !== stat.dev ||
      lockStat.ino === 0n ||
      lockStat.nlink !== 1n ||
      (process.platform !== "win32" &&
        (sharedGroupDirectory
          ? lockStat.gid !== parentStat.gid ||
            (Number(lockStat.mode & 0o777n) & 0o660) !== 0o660 ||
            (Number(lockStat.mode & 0o007n) & 0o007) !== 0
          : process.getuid?.() === undefined ||
            lockStat.uid !== BigInt(process.getuid?.() ?? -1) ||
            (Number(lockStat.mode & 0o600n) & 0o600) !== 0o600 ||
            (Number(lockStat.mode & 0o077n) & 0o077) !== 0))
    ) {
      return invalidLockPath();
    }
    if (
      !validateProtectedPaths([
        { path: parent, kind: "directory" },
        { path: canonical, kind: "file" },
        { path: canonicalLock, kind: "file" },
      ])
    ) {
      return unsupportedWriterDeployment();
    }
    return filename;
  } catch {
    return invalidLockPath();
  }
};

/** A primary-adjacent lock path shared by daemon and maintenance under the same
 * validated OS identity. The v1 owner profile deliberately rejects other OS
 * identities before either process can migrate or assemble P4. */
export const databaseWriterLockFilename = (
  primaryDatabaseFilename: string,
): string | DatabaseWriterLockFailure =>
  databaseWriterLockFilenameValidatedParent(primaryDatabaseFilename, false);

export interface PreparedPrimaryDatabasePath {
  readonly databaseFilename: string;
  readonly writerLockFilename: string;
}

/** Prepare a new zero-byte SQLite file only after the parent volume is known
 * local and supported. This gives every daemon/maintenance process the same
 * device+file-id lock key, including their first startup. */
export const preparePrimaryDatabasePath = (
  filename: string,
): PreparedPrimaryDatabasePath | DatabaseWriterLockFailure => {
  if (
    filename === ":memory:" ||
    filename.trim().length === 0 ||
    filename.startsWith("file:")
  ) {
    return unsupportedWriterDeployment();
  }
  try {
    const resolved = resolve(filename);
    const parent = dirname(resolved);
    if (!existsSync(parent)) return invalidLockPath();
    const canonicalParent = realpathSync.native(parent);
    if (
      normalizeForPlatform(parent) !== normalizeForPlatform(canonicalParent) ||
      canonicalParent.startsWith("\\\\") ||
      (process.platform === "win32" &&
        !/^(?:\\\\\?\\)?[a-z]:\\/iu.test(canonicalParent))
    ) {
      return invalidLockPath();
    }
    if (!validateProtectedDirectory(canonicalParent)) {
      return unsupportedWriterDeployment();
    }
    if (!existsSync(resolved)) {
      try {
        const descriptor = openSync(resolved, "wx", 0o600);
        closeSync(descriptor);
      } catch (cause) {
        if (
          typeof cause !== "object" ||
          cause === null ||
          !("code" in cause) ||
          cause.code !== "EEXIST"
        ) {
          return invalidLockPath();
        }
      }
    }
    const canonical = realpathSync.native(resolved);
    if (normalizeForPlatform(resolved) !== normalizeForPlatform(canonical)) {
      return invalidLockPath();
    }
    const stat = statSync(canonical, { bigint: true });
    if (
      !stat.isFile() ||
      stat.dev === 0n ||
      stat.ino === 0n ||
      stat.nlink !== 1n
    ) {
      return invalidLockPath();
    }
    const lockFilename = databaseWriterLockFilenameValidatedParent(canonical, true);
    return typeof lockFilename === "string"
      ? { databaseFilename: canonical, writerLockFilename: lockFilename }
      : lockFilename;
  } catch {
    return invalidLockPath();
  }
};

const invalidLockPath = (): DatabaseWriterLockFailure => ({
  _tag: "DatabaseWriterLockFailure",
  code: "P39_WRITER_LOCK_PATH_INVALID",
});

const unsupportedWriterDeployment = (): DatabaseWriterLockFailure => ({
  _tag: "DatabaseWriterLockFailure",
  code: "P39_WRITER_LOCK_UNSUPPORTED_DEPLOYMENT",
});

const writerLockAcquireFailed = (cause?: unknown): DatabaseWriterLockFailure => ({
  _tag: "DatabaseWriterLockFailure",
  code: "P39_WRITER_LOCK_ACQUIRE_FAILED",
  ...(cause === undefined ? {} : { cause }),
});

const writerLockSchemaInvalid = (cause?: unknown): DatabaseWriterLockFailure => ({
  _tag: "DatabaseWriterLockFailure",
  code: "P39_WRITER_LOCK_SCHEMA_INVALID",
  ...(cause === undefined ? {} : { cause }),
});

const isSqliteLockContention = (cause: unknown): cause is SqlError =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "SqlError" &&
  "reason" in cause &&
  typeof cause.reason === "object" &&
  cause.reason !== null &&
  "_tag" in cause.reason &&
  cause.reason._tag === "LockTimeoutError";

const isDatabaseWriterLockFailure = (
  cause: unknown,
): cause is DatabaseWriterLockFailure =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "DatabaseWriterLockFailure";

const isSqliteAdapterError = (cause: unknown): cause is SqliteAdapterError =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "SqliteAdapterError";

const normalizeForPlatform = (path: string): string => {
  const normalized =
    process.platform === "win32" ? path.replace(/^\\\\\?\\/u, "") : path;
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const isSupportedLocalFilesystem = (path: string): boolean => {
  try {
    const filesystemType = statfsSync(path).type;
    const supportedLocalTypes = new Set([
      0x0000ef53, // ext2/3/4
      0x58465342, // XFS
      0x9123683e, // Btrfs
      0xf2f52010, // F2FS
      0x2011bab0, // exFAT
      0x00004d44, // FAT
    ]);
    return supportedLocalTypes.has(filesystemType);
  } catch {
    return false;
  }
};

/** The lock database uses rollback-journal mode, whose cross-process SHARED
 * and EXCLUSIVE VFS locks provide daemon-reader / maintenance-writer exclusion.
 * It contains no application data and is separate from both primary and audit
 * sidecar databases. Process death closes SQLite handles and releases the lock. */
export const databaseWriterLockLayer = (
  filename: string,
  busyTimeoutMs = 30_000,
): Layer.Layer<
  DatabaseWriterLockClient,
  SqliteAdapterError | DatabaseWriterLockFailure
> => {
  const lockClient = Layer.effect(
    DatabaseWriterLockClient,
    Effect.gen(function* () {
      const parent = dirname(filename);
      if (!validateProtectedPaths([{ path: parent, kind: "directory" }])) {
        return yield* Effect.fail(unsupportedWriterDeployment());
      }
      if (!existsSync(filename)) {
        const parentStat = statSync(parent, { bigint: true });
        const sharedGroupDirectory =
          process.platform !== "win32" &&
          (Number(parentStat.mode & 0o7777n) & 0o020) !== 0;
        try {
          const descriptor = openSync(
            filename,
            "wx",
            sharedGroupDirectory ? 0o660 : 0o600,
          );
          closeSync(descriptor);
          if (process.platform !== "win32") {
            chmodSync(filename, sharedGroupDirectory ? 0o660 : 0o600);
          }
        } catch (cause) {
          if (
            typeof cause !== "object" ||
            cause === null ||
            !("code" in cause) ||
            cause.code !== "EEXIST"
          ) {
            return yield* Effect.fail(invalidLockPath());
          }
        }
      }
      if (
        !validateProtectedPaths([
          { path: parent, kind: "directory" },
          { path: filename, kind: "file" },
        ])
      ) {
        return yield* Effect.fail(unsupportedWriterDeployment());
      }
      const activePermits = new Map<
        string,
        {
          readonly scope: Scope.Scope;
          readonly rollback: Effect.Effect<void, SqlError>;
        }
      >();
      const makeConnectionLayer = () =>
        SqliteClient.layer({
          filename,
          disableWAL: true,
          busyTimeout: Duration.zero,
        });
      const acquireOnce = (
        mode: DatabaseWriterPermit["mode"],
        deadline: number,
        enforceDeadline: boolean,
      ): Effect.Effect<
        DatabaseWriterPermit,
        SqlError | DatabaseWriterLockFailure | SqliteAdapterError
      > =>
        Effect.acquireUseRelease(
          Scope.make(),
          (scope) =>
            Effect.gen(function* () {
              const context = yield* Layer.buildWithScope(
                makeConnectionLayer(),
                scope,
              ).pipe(
                Effect.mapError((cause) =>
                  isSqliteLockContention(cause)
                    ? cause
                    : sqliteAdapterError(
                        "failed to initialize P39 writer lock database",
                        cause,
                      ),
                ),
              );
              if (enforceDeadline && performance.now() >= deadline) {
                return yield* Effect.fail(writerLockAcquireFailed());
              }
              const sql = Context.get(context, SqlClient);
              let transactionOpen = false;
              let initializationComplete = false;
              const run = <A>(operation: Effect.Effect<A, SqlError>) =>
                operation.pipe(
                  Effect.flatMap((value) =>
                    enforceDeadline && performance.now() >= deadline
                      ? Effect.fail(writerLockAcquireFailed())
                      : Effect.succeed(value),
                  ),
                );
              const acquireInScope = Effect.gen(function* () {
                const currentMode = yield* run(
                  sql.unsafe<{ journal_mode: string }>("PRAGMA journal_mode"),
                );
                if (currentMode[0]?.journal_mode?.toLowerCase() !== "delete") {
                  const tables = yield* run(
                    sql.unsafe<{ name: string }>(
                      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
                    ),
                  );
                  if (tables.length > 0) {
                    return yield* Effect.fail(
                      sqliteAdapterError(
                        "P39 writer lock database must use DELETE journal mode",
                      ),
                    );
                  }
                  const mode = yield* run(
                    sql.unsafe<{ journal_mode: string }>(
                      "PRAGMA journal_mode = DELETE",
                    ),
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
                yield* run(sql.unsafe("PRAGMA synchronous = FULL"));
                yield* run(sql.unsafe("PRAGMA foreign_keys = ON"));
                const existing = yield* run(
                  sql.unsafe<{ name: string }>(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'p39_writer_lock'",
                  ),
                );
                if (existing.length === 0) {
                  const userObjects = yield* run(
                    sql.unsafe<{ name: string }>(
                      "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
                    ),
                  );
                  if (userObjects.length > 0) {
                    return yield* Effect.fail(
                      sqliteAdapterError(
                        "P39 writer lock database contains an unsupported schema",
                      ),
                    );
                  }
                  yield* run(
                    sql.withTransaction(
                      Effect.gen(function* () {
                        for (const statement of P39_WRITER_LOCK_DDL.split(";")
                          .map((part) => part.trim())
                          .filter(Boolean)) {
                          yield* sql.unsafe(statement);
                        }
                      }),
                    ),
                  );
                }
                const identity = yield* run(
                  sql.unsafe<{ lock_id: number }>(
                    "SELECT lock_id FROM p39_writer_lock",
                  ),
                );
                if (
                  identity.length !== 1 ||
                  Number(identity[0]?.lock_id) !== 1
                ) {
                  return yield* Effect.fail(
                    sqliteAdapterError(
                      "P39 writer lock database has an invalid identity row",
                    ),
                  );
                }
                initializationComplete = true;
                const begin =
                  mode === "RuntimeShared" ? "BEGIN" : "BEGIN EXCLUSIVE";
                yield* sql.unsafe(begin).pipe(
                  Effect.flatMap(() => {
                    transactionOpen = true;
                    return enforceDeadline && performance.now() >= deadline
                      ? Effect.fail(writerLockAcquireFailed())
                      : Effect.void;
                  }),
                );
                const rows = yield* run(
                  sql.unsafe<{ lock_id: number }>(
                    "SELECT lock_id FROM p39_writer_lock WHERE lock_id = 1",
                  ),
                );
                if (rows.length !== 1) {
                  return yield* Effect.fail(writerLockSchemaInvalid());
                }
                const permit = { token: randomUUID(), mode };
                activePermits.set(permit.token, {
                  scope,
                  rollback: sql.unsafe("ROLLBACK").pipe(Effect.asVoid),
                });
                return permit;
              });
              return yield* acquireInScope.pipe(
                Effect.mapError((cause) => {
                  if (isSqliteLockContention(cause)) return cause;
                  if (isDatabaseWriterLockFailure(cause)) return cause;
                  if (isSqliteAdapterError(cause)) return cause;
                  return initializationComplete
                    ? writerLockAcquireFailed(cause)
                    : sqliteAdapterError(
                        "failed to initialize P39 writer lock database",
                        cause,
                      );
                }),
                Effect.onExit((exit) =>
                  Exit.isFailure(exit) && transactionOpen
                    ? sql.unsafe("ROLLBACK").pipe(Effect.ignore)
                    : Effect.void,
                ),
              );
            }),
          (scope, exit) => {
            if (Exit.isSuccess(exit) && activePermits.has(exit.value.token)) {
              return Effect.void;
            }
            for (const [token, active] of activePermits) {
              if (active.scope === scope) activePermits.delete(token);
            }
            return Scope.close(scope, exit);
          },
        );
      const acquire = (mode: DatabaseWriterPermit["mode"]) => {
        return Effect.suspend(() => {
          const timeout = Number.isFinite(busyTimeoutMs)
            ? Math.max(0, Math.floor(busyTimeoutMs))
            : 0;
          const deadline = performance.now() + timeout;
          const loop = (
            firstAttempt: boolean,
          ): Effect.Effect<
            DatabaseWriterPermit,
            DatabaseWriterLockFailure | SqliteAdapterError
          > =>
            Effect.suspend(() => {
              if (!firstAttempt && performance.now() >= deadline) {
                return Effect.fail(writerLockAcquireFailed());
              }
              return Effect.result(
                acquireOnce(mode, deadline, timeout > 0),
              ).pipe(
                Effect.flatMap((result) => {
                  if (result._tag === "Success") {
                    return Effect.succeed(result.success);
                  }
                  if (isSqliteLockContention(result.failure)) {
                    const remainingMs = deadline - performance.now();
                    if (remainingMs <= 0) {
                      return Effect.fail(
                        writerLockAcquireFailed(result.failure),
                      );
                    }
                    return Effect.sleep(
                      Duration.millis(Math.min(10, remainingMs)),
                    ).pipe(Effect.flatMap(() => loop(false)));
                  }
                  if (isDatabaseWriterLockFailure(result.failure)) {
                    return Effect.fail(result.failure);
                  }
                  if (isSqliteAdapterError(result.failure)) {
                    return Effect.fail(result.failure);
                  }
                  return Effect.fail(writerLockAcquireFailed(result.failure));
                }),
              );
            });
          return loop(true);
        });
      };
      const release = (permit: DatabaseWriterPermit) => {
        return Effect.uninterruptible(
          Effect.suspend(() => {
            const active = activePermits.get(permit.token);
            if (active === undefined) {
              return Effect.fail({
                _tag: "DatabaseWriterLockFailure" as const,
                code: "P39_WRITER_LOCK_RELEASE_FAILED" as const,
              });
            }
            return active.rollback.pipe(
              Effect.onExit(() => {
                activePermits.delete(permit.token);
                return Scope.close(active.scope, Exit.void);
              }),
              Effect.mapError((cause) => ({
                _tag: "DatabaseWriterLockFailure" as const,
                code: "P39_WRITER_LOCK_RELEASE_FAILED" as const,
                cause,
              })),
            );
          }),
        );
      };
      const layerScope = yield* Effect.scope;
      yield* Scope.addFinalizer(
        layerScope,
        Effect.gen(function* () {
          for (const [token, active] of activePermits) {
            activePermits.delete(token);
            yield* active.rollback.pipe(Effect.ignore);
            yield* Scope.close(active.scope, Exit.void);
          }
        }),
      );
      return DatabaseWriterLockClient.of({
        acquire: (mode) => acquire(mode),
        release,
      });
    }),
  );
  return lockClient;
};

export const acquireRuntimeWriterPermit = (): Effect.Effect<
  DatabaseWriterPermit,
  DatabaseWriterLockFailure | SqliteAdapterError,
  DatabaseWriterLockClient
> =>
  Effect.flatMap(DatabaseWriterLockClient, (client) =>
    client.acquire("RuntimeShared"),
  );

export const acquireMaintenanceWriterExclusion = (): Effect.Effect<
  DatabaseWriterPermit,
  DatabaseWriterLockFailure | SqliteAdapterError,
  DatabaseWriterLockClient
> =>
  Effect.flatMap(DatabaseWriterLockClient, (client) =>
    client.acquire("MaintenanceExclusive"),
  );

export const releaseDatabaseWriterPermit = (
  _permit: DatabaseWriterPermit,
): Effect.Effect<void, DatabaseWriterLockFailure, DatabaseWriterLockClient> =>
  Effect.flatMap(DatabaseWriterLockClient, (client) => client.release(_permit));
