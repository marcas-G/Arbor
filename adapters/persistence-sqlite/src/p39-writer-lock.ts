import { execFileSync } from "node:child_process";
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

/** Validate the primary/lock directory as a protected local write boundary.
 * Windows broad-principal write ACEs and POSIX world-writable directories fail
 * closed; a shared POSIX group must be setgid and contain the current process. */
export const validateP39ProtectedDirectory = (directory: string): boolean => {
  try {
    const stat = statSync(directory, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.dev === 0n ||
      !isSupportedLocalFilesystem(directory)
    ) {
      return false;
    }
    if (process.platform === "win32") {
      const encoded = Buffer.from(directory, "utf8").toString("base64");
      const script = [
        "$ErrorActionPreference='Stop'",
        `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
        "$i=Get-Item -LiteralPath $p -Force",
        "if(!$i.PSIsContainer -or (($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){exit 2}",
        "$a=Get-Acl -LiteralPath $p",
        "$w=[Security.Principal.WindowsIdentity]::GetCurrent()",
        "$s=@($w.User.Value)+@($w.Groups|ForEach-Object {$_.Value})",
        "$b=@('S-1-1-0','S-1-5-11','S-1-5-32-545')",
        "$m=[int][Security.AccessControl.FileSystemRights]::Write -bor [int][Security.AccessControl.FileSystemRights]::Modify -bor [int][Security.AccessControl.FileSystemRights]::FullControl -bor [int][Security.AccessControl.FileSystemRights]::CreateFiles -bor [int][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles",
        "$g=$false",
        "foreach($r in $a.Access){$sid=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value;if($r.AccessControlType -eq 'Allow' -and (([int]$r.FileSystemRights -band $m) -ne 0)){if($b -contains $sid){exit 3};if($s -contains $sid){$g=$true}}}",
        "$o=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value",
        "if(!$g -or !($o -eq $w.User.Value -or $o -eq 'S-1-5-18' -or $o -eq 'S-1-5-32-544')){exit 4}",
        "Write-Output 'OK'",
      ].join(";");
      return (
        execFileSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", script],
          { encoding: "utf8", timeout: 5000, windowsHide: true },
        ).trim() === "OK"
      );
    }
    const mode = Number(stat.mode & 0o7777n);
    if ((mode & 0o002) !== 0) return false;
    if ((mode & 0o020) !== 0) {
      const primaryGroup = process.getgid?.();
      const groups = process.getgroups?.();
      if (primaryGroup === undefined || groups === undefined) return false;
      const allowedGroups = new Set([primaryGroup, ...groups]);
      return (
        (mode & 0o2000) !== 0 &&
        (mode & 0o010) !== 0 &&
        allowedGroups.has(Number(stat.gid))
      );
    }
    const currentUid = process.getuid?.();
    return (
      currentUid !== undefined &&
      Number(stat.uid) === currentUid &&
      (mode & 0o077) === 0 &&
      (mode & 0o100) !== 0
    );
  } catch {
    return false;
  }
};

/** A stable, primary-adjacent lock database path shared by all accounts that
 * can legally open the primary. The canonical parent is a common root (not a
 * per-user state directory); aliases are normalized or rejected above. */
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
        _tag: "P39WriterLockFailure",
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
    if (!validateP39ProtectedDirectory(parent)) {
      return invalidLockPath();
    }
    const filename = join(
      parent,
      `.arbor-p39-writer-${sha256Hex(`${stat.dev}:${stat.ino}`)}.sqlite`,
    );
    const parentStat = statSync(parent, { bigint: true });
    const sharedGroupDirectory =
      process.platform !== "win32" &&
      (Number(parentStat.mode & 0o7777n) & 0o020) !== 0;
    const lockFileMode = sharedGroupDirectory ? 0o660 : 0o600;
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
    return filename;
  } catch {
    return invalidLockPath();
  }
};

export interface P39PreparedPrimaryDatabasePath {
  readonly databaseFilename: string;
  readonly writerLockFilename: string;
}

/** Prepare a new zero-byte SQLite file only after the parent volume is known
 * local and supported. This gives every daemon/maintenance process the same
 * device+file-id lock key, including their first startup. */
export const prepareP39PrimaryDatabasePath = (
  filename: string,
): P39PreparedPrimaryDatabasePath | P39WriterLockFailure => {
  if (
    filename === ":memory:" ||
    filename.trim().length === 0 ||
    filename.startsWith("file:")
  ) {
    return invalidLockPath();
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
        !/^(?:\\\\\?\\)?[a-z]:\\/iu.test(canonicalParent)) ||
      !isSupportedLocalFilesystem(canonicalParent, true)
    ) {
      return invalidLockPath();
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
    const lockFilename = p39WriterLockFilename(canonical);
    return typeof lockFilename === "string"
      ? { databaseFilename: canonical, writerLockFilename: lockFilename }
      : lockFilename;
  } catch {
    return invalidLockPath();
  }
};

const invalidLockPath = (): P39WriterLockFailure => ({
  _tag: "P39WriterLockFailure",
  code: "P39_WRITER_LOCK_PATH_INVALID",
});

const normalizeForPlatform = (path: string): string => {
  const normalized =
    process.platform === "win32" ? path.replace(/^\\\\\?\\/u, "") : path;
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const isSupportedLocalFilesystem = (
  path: string,
  allowTemporaryFs = false,
): boolean => {
  try {
    if (process.platform === "win32") {
      const encoded = Buffer.from(path, "utf8").toString("base64");
      const script = [
        `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
        "$r=[IO.Path]::GetPathRoot($p)",
        "if($r.StartsWith(([string][char]92)+([char]92)+'?'+([char]92))){$r=$r.Substring(4)}",
        "$d=[IO.DriveInfo]::new($r)",
        "Write-Output ($d.DriveType.ToString()+'|'+$d.DriveFormat)",
      ].join(";");
      const output = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", timeout: 5000, windowsHide: true },
      ).trim();
      const [driveType, driveFormat] = output.split("|");
      return (
        (driveType === "Fixed" || driveType === "Removable") &&
        ["NTFS", "ReFS", "exFAT", "FAT", "FAT32"].includes(driveFormat ?? "")
      );
    }
    const filesystemType = statfsSync(path).type;
    const supportedLocalTypes = new Set([
      0x0000ef53, // ext2/3/4
      0x58465342, // XFS
      0x9123683e, // Btrfs
      0xf2f52010, // F2FS
      0x2011bab0, // exFAT
      0x00004d44, // FAT
      ...(allowTemporaryFs ? [0x01021994] : []), // tmpfs (primary test data only)
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
