import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  realpathSync,
  statfsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type SqliteAdapterError, sqliteAdapterError } from "./errors.js";
import { splitStatements } from "./migrate.js";
import {
  P39_REPORT_APPLICATION_ID,
  P39_REPORT_DATABASE_DDL,
  P39_REPORT_USER_VERSION,
  type P39MaintenanceFailure,
} from "./p39-maintenance.js";
import { executeP39WindowsSecurityQuery } from "./p39-windows-security.js";
import {
  validateP39ProtectedDirectory,
  validateP39ProtectedFile,
} from "./p39-writer-lock.js";

const failure = (
  code: P39MaintenanceFailure["code"],
  cause?: unknown,
): P39MaintenanceFailure => ({
  _tag: "P39MaintenanceFailure",
  code,
  ...(cause === undefined ? {} : { cause }),
});

export type P39ReportSidecarValidationPhase =
  | "report-path-absolute-network-check"
  | "report-path-canonical-and-temp-check"
  | "report-parent-filesystem-acl"
  | "report-primary-sidecar-alias"
  | "report-primary-file-identity"
  | "report-sidecar-file-identity"
  | "report-protected-store-path-and-alias"
  | "report-database-path-revalidation"
  | "report-existing-new-sidecar-policy"
  | "report-initial-file-identity"
  | "report-profile-open-init-readback"
  | "report-profile-init-transaction-open"
  | "report-profile-init-before-commit"
  | "report-profile-init-commit-complete"
  | "report-final-path-and-identity";

type ReportValidationPhaseObserver = (
  phase: P39ReportSidecarValidationPhase,
) => void;

const canonicalExistingOrNewPath = (path: string): string => {
  if (existsSync(path)) return realpathSync.native(path);
  const parent = dirname(path);
  const canonicalParent = existsSync(parent)
    ? realpathSync.native(parent)
    : resolve(parent);
  return join(canonicalParent, basename(path));
};

const isUncPath = (path: string): boolean => path.startsWith("\\\\");

const normalizeWindowsExtendedPath = (path: string): string =>
  path.replace(/^\\\\\?\\/u, "");

const normalizedPath = (path: string): string => {
  const normalized =
    process.platform === "win32" ? normalizeWindowsExtendedPath(path) : path;
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const isWithinPath = (parent: string, child: string): boolean => {
  const childFromParent = relative(
    normalizedPath(parent),
    normalizedPath(child),
  );
  return (
    childFromParent === "" ||
    (!childFromParent.startsWith(`..${sep}`) &&
      childFromParent !== ".." &&
      !isAbsolute(childFromParent))
  );
};

const fileIdentity = (path: string): string | P39MaintenanceFailure => {
  try {
    const stat = statSync(path, { bigint: true });
    if (
      !stat.isFile() ||
      stat.dev === 0n ||
      stat.ino === 0n ||
      stat.nlink !== 1n ||
      !validateP39ProtectedFile(path)
    ) {
      return failure("P39_UNSUPPORTED_DEPLOYMENT");
    }
    return `${stat.dev}:${stat.ino}`;
  } catch (cause) {
    return failure("P39_REPORT_DB_PATH_INVALID", cause);
  }
};

const validateLocalFilesystem = (
  path: string,
): P39MaintenanceFailure | undefined => {
  try {
    const volumePath = existsSync(path) ? path : dirname(path);
    if (process.platform === "win32") {
      const encoded = Buffer.from(resolve(volumePath), "utf8").toString(
        "base64",
      );
      const script = [
        `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
        "$r=[IO.Path]::GetPathRoot($p)",
        "if($r.StartsWith(([string][char]92)+([char]92)+'?'+([char]92))){$r=$r.Substring(4)}",
        "$d=[IO.DriveInfo]::new($r)",
        "Write-Output ($d.DriveType.ToString()+'|'+$d.DriveFormat)",
      ].join(";");
      const output = executeP39WindowsSecurityQuery(script);
      const [driveType, driveFormat] = output.split("|");
      if (
        (driveType !== "Fixed" && driveType !== "Removable") ||
        !["NTFS", "ReFS", "exFAT", "FAT", "FAT32"].includes(driveFormat ?? "")
      ) {
        return failure("P39_REPORT_DB_PATH_INVALID");
      }
      return undefined;
    }

    const filesystemType = statfsSync(volumePath).type;
    const supportedLocalTypes = new Set([
      0x0000ef53, // ext2/3/4
      0x58465342, // XFS
      0x9123683e, // Btrfs
      0xf2f52010, // F2FS
      0x2011bab0, // exFAT
      0x00004d44, // FAT
    ]);
    if (!supportedLocalTypes.has(filesystemType)) {
      return failure("P39_REPORT_DB_PATH_INVALID");
    }
    return undefined;
  } catch (cause) {
    return failure("P39_REPORT_DB_PATH_INVALID", cause);
  }
};

/** Validate the explicitly selected sidecar before opening the primary DB.
 * Network paths and non-absolute paths are rejected. Windows VM/VFS/power-loss
 * qualification remains a separate release gate even for a local drive. */
export const validateP39ReportSidecarPath = (
  primaryFilename: string,
  sidecarFilename: string,
  protectedStoreFilenames: ReadonlyArray<string> = [],
  onPhase?: ReportValidationPhaseObserver,
): Effect.Effect<string, P39MaintenanceFailure> => {
  onPhase?.("report-path-absolute-network-check");
  if (
    !isAbsolute(primaryFilename) ||
    !isAbsolute(sidecarFilename) ||
    primaryFilename.startsWith("file:") ||
    sidecarFilename.startsWith("file:")
  ) {
    return Effect.fail(failure("P39_REPORT_DB_PATH_INVALID"));
  }
  const primaryNetworkPath = isUncPath(primaryFilename);
  const sidecarNetworkPath = isUncPath(sidecarFilename);
  if (primaryNetworkPath || sidecarNetworkPath) {
    return Effect.fail(failure("P39_REPORT_DB_PATH_INVALID"));
  }
  try {
    onPhase?.("report-path-canonical-and-temp-check");
    const primary = canonicalExistingOrNewPath(resolve(primaryFilename));
    const sidecar = canonicalExistingOrNewPath(resolve(sidecarFilename));
    if (
      normalizedPath(resolve(primaryFilename)) !== normalizedPath(primary) ||
      normalizedPath(resolve(sidecarFilename)) !== normalizedPath(sidecar) ||
      isWithinPath(realpathSync.native(tmpdir()), sidecar)
    ) {
      return Effect.fail(failure("P39_REPORT_DB_PATH_INVALID"));
    }
    if (
      isUncPath(primary) ||
      isUncPath(sidecar) ||
      (process.platform === "win32" &&
        (!/^(?:\\\\\?\\)?[a-z]:\\/iu.test(primary) ||
          !/^(?:\\\\\?\\)?[a-z]:\\/iu.test(sidecar)))
    ) {
      return Effect.fail(failure("P39_REPORT_DB_PATH_INVALID"));
    }
    onPhase?.("report-parent-filesystem-acl");
    for (const path of [primary, sidecar]) {
      const filesystemFailure = validateLocalFilesystem(path);
      if (
        filesystemFailure !== undefined ||
        !validateP39ProtectedDirectory(dirname(path))
      ) {
        return Effect.fail(
          filesystemFailure ?? failure("P39_UNSUPPORTED_DEPLOYMENT"),
        );
      }
    }
    onPhase?.("report-primary-sidecar-alias");
    if (normalizedPath(primary) === normalizedPath(sidecar)) {
      return Effect.fail(failure("P39_REPORT_DB_PATH_INVALID"));
    }
    onPhase?.("report-primary-file-identity");
    const primaryIdentity = fileIdentity(primary);
    if (typeof primaryIdentity !== "string") {
      return Effect.fail(primaryIdentity);
    }
    if (existsSync(sidecar)) {
      onPhase?.("report-sidecar-file-identity");
      const sidecarIdentity = fileIdentity(sidecar);
      if (
        typeof sidecarIdentity !== "string" ||
        sidecarIdentity === primaryIdentity
      ) {
        return Effect.fail(
          typeof sidecarIdentity === "string"
            ? failure("P39_REPORT_DB_PATH_INVALID")
            : sidecarIdentity,
        );
      }
    }
    onPhase?.("report-protected-store-path-and-alias");
    for (const protectedFilename of protectedStoreFilenames) {
      const protectedResolved = resolve(protectedFilename);
      if (!existsSync(protectedResolved)) {
        return Effect.fail(failure("P39_REPORT_DB_PATH_INVALID"));
      }
      const protectedCanonical = realpathSync.native(protectedResolved);
      if (
        normalizedPath(protectedResolved) !==
          normalizedPath(protectedCanonical) ||
        isWithinPath(realpathSync.native(tmpdir()), protectedCanonical)
      ) {
        return Effect.fail(failure("P39_REPORT_DB_PATH_INVALID"));
      }
      const filesystemFailure = validateLocalFilesystem(protectedCanonical);
      if (
        filesystemFailure !== undefined ||
        !validateP39ProtectedDirectory(dirname(protectedCanonical))
      ) {
        return Effect.fail(
          filesystemFailure ?? failure("P39_UNSUPPORTED_DEPLOYMENT"),
        );
      }
      const protectedIdentity = fileIdentity(protectedCanonical);
      if (
        typeof protectedIdentity !== "string" ||
        protectedIdentity === primaryIdentity ||
        (existsSync(sidecar) && protectedIdentity === fileIdentity(sidecar))
      ) {
        return Effect.fail(failure("P39_REPORT_DB_PATH_INVALID"));
      }
    }
    return Effect.succeed(sidecar);
  } catch (cause) {
    return Effect.fail(failure("P39_REPORT_DB_PATH_INVALID", cause));
  }
};

interface SidecarIdentity {
  readonly application_id: number;
}

interface UserVersion {
  readonly user_version: number;
}

interface JournalMode {
  readonly journal_mode: string;
}

interface Synchronous {
  readonly synchronous: number;
}

interface SidecarObject {
  readonly type: string;
  readonly name: string;
  readonly sql: string | null;
}

const normalizeSql = (sql: string | null): string =>
  (sql ?? "").replace(/\s+/gu, " ").trim().toLowerCase();

const expectedSchema = splitStatements(P39_REPORT_DATABASE_DDL)
  .map((statement) => {
    const match = /^CREATE\s+(TABLE|TRIGGER)\s+(\w+)/iu.exec(statement);
    return match === null
      ? ""
      : `${match[1]?.toLowerCase()}:${match[2]?.toLowerCase()}:${normalizeSql(statement)}`;
  })
  .sort();

const observedSchema = (
  objects: ReadonlyArray<SidecarObject>,
): ReadonlyArray<string> =>
  objects
    .map(
      ({ type, name, sql }) =>
        `${type.toLowerCase()}:${name.toLowerCase()}:${normalizeSql(sql)}`,
    )
    .sort();

const hasExactSchema = (objects: ReadonlyArray<SidecarObject>): boolean => {
  const actual = observedSchema(objects);
  return (
    actual.length === expectedSchema.length &&
    actual.every((object, index) => object === expectedSchema[index])
  );
};

const p39ReportSetup = (
  allowInitialize: boolean,
  onPhase?: ReportValidationPhaseObserver,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const identity = yield* sql.unsafe<SidecarIdentity>(
      "PRAGMA application_id",
    );
    const version = yield* sql.unsafe<UserVersion>("PRAGMA user_version");
    const journalBefore = yield* sql.unsafe<JournalMode>("PRAGMA journal_mode");
    const objects = yield* sql.unsafe<SidecarObject>(
      `SELECT type, name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    );
    const appId = Number(identity[0]?.application_id ?? 0);
    const userVersion = Number(version[0]?.user_version ?? 0);
    if (appId === 0 && userVersion === 0 && objects.length === 0) {
      if (!allowInitialize) {
        return yield* Effect.fail(failure("P39_REPORT_DB_SCHEMA_UNSUPPORTED"));
      }
      const journal = yield* sql.unsafe<JournalMode>(
        "PRAGMA journal_mode = WAL",
      );
      if (journal[0]?.journal_mode?.toLowerCase() !== "wal") {
        return yield* Effect.fail(failure("P39_REPORT_DB_PRAGMA_MISMATCH"));
      }
      yield* sql.unsafe("PRAGMA synchronous = FULL");
      yield* sql.unsafe("PRAGMA foreign_keys = ON");
      yield* sql.unsafe("PRAGMA busy_timeout = 5000");
      yield* sql.withTransaction(
        Effect.gen(function* () {
          onPhase?.("report-profile-init-transaction-open");
          for (const statement of splitStatements(P39_REPORT_DATABASE_DDL)) {
            yield* sql.unsafe(statement);
          }
          yield* sql.unsafe(
            `PRAGMA application_id = ${P39_REPORT_APPLICATION_ID}`,
          );
          yield* sql.unsafe(`PRAGMA user_version = ${P39_REPORT_USER_VERSION}`);
          onPhase?.("report-profile-init-before-commit");
        }),
      );
      if (process.env.NODE_ENV === "test")
        onPhase?.("report-profile-init-commit-complete");
    } else if (
      appId !== P39_REPORT_APPLICATION_ID ||
      userVersion !== P39_REPORT_USER_VERSION ||
      journalBefore[0]?.journal_mode?.toLowerCase() !== "wal" ||
      !hasExactSchema(objects)
    ) {
      return yield* Effect.fail(failure("P39_REPORT_DB_SCHEMA_UNSUPPORTED"));
    }

    const finalIdentity = yield* sql.unsafe<SidecarIdentity>(
      "PRAGMA application_id",
    );
    const finalVersion = yield* sql.unsafe<UserVersion>("PRAGMA user_version");
    const finalJournal = yield* sql.unsafe<JournalMode>("PRAGMA journal_mode");
    const finalObjects = yield* sql.unsafe<SidecarObject>(
      `SELECT type, name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    );
    yield* sql.unsafe("PRAGMA foreign_keys = ON");
    yield* sql.unsafe("PRAGMA busy_timeout = 5000");
    yield* sql.unsafe("PRAGMA synchronous = FULL");
    const foreignKeys = yield* sql.unsafe<{ foreign_keys: number }>(
      "PRAGMA foreign_keys",
    );
    const busyTimeout = yield* sql.unsafe<{ timeout: number }>(
      "PRAGMA busy_timeout",
    );
    const synchronous = yield* sql.unsafe<Synchronous>("PRAGMA synchronous");
    if (
      Number(finalIdentity[0]?.application_id) !== P39_REPORT_APPLICATION_ID ||
      Number(finalVersion[0]?.user_version) !== P39_REPORT_USER_VERSION ||
      finalJournal[0]?.journal_mode?.toLowerCase() !== "wal" ||
      !hasExactSchema(finalObjects) ||
      Number(foreignKeys[0]?.foreign_keys) !== 1 ||
      Number(busyTimeout[0]?.timeout) !== 5000 ||
      Number(synchronous[0]?.synchronous) !== 2
    ) {
      return yield* Effect.fail(failure("P39_REPORT_DB_PRAGMA_MISMATCH"));
    }
  });

/** Initialize or validate the operator sidecar using the production SQLite
 * Node VFS. Call and close this layer before opening the primary connection. */
export const validateP39ReportSidecarDatabase = (
  primaryFilename: string,
  sidecarFilename: string,
  protectedStoreFilenames: ReadonlyArray<string> = [],
  onPhase?: ReportValidationPhaseObserver,
): Effect.Effect<void, P39MaintenanceFailure | SqliteAdapterError> =>
  validateP39ReportSidecarDatabaseInternal(
    primaryFilename,
    sidecarFilename,
    protectedStoreFilenames,
    true,
    onPhase,
  );

/** Validate an already-created report sidecar without initializing or
 * substituting missing/empty evidence. Intended for resume-copy admission. */
export const validateP39ExistingReportSidecarDatabase = (
  primaryFilename: string,
  sidecarFilename: string,
  protectedStoreFilenames: ReadonlyArray<string> = [],
  onPhase?: ReportValidationPhaseObserver,
): Effect.Effect<void, P39MaintenanceFailure | SqliteAdapterError> =>
  validateP39ReportSidecarDatabaseInternal(
    primaryFilename,
    sidecarFilename,
    protectedStoreFilenames,
    false,
    onPhase,
  );

const validateP39ReportSidecarDatabaseInternal = (
  primaryFilename: string,
  sidecarFilename: string,
  protectedStoreFilenames: ReadonlyArray<string>,
  allowInitialize: boolean,
  onPhase?: ReportValidationPhaseObserver,
): Effect.Effect<void, P39MaintenanceFailure | SqliteAdapterError> =>
  Effect.gen(function* () {
    onPhase?.("report-database-path-revalidation");
    const path = yield* validateP39ReportSidecarPath(
      primaryFilename,
      sidecarFilename,
      protectedStoreFilenames,
      onPhase,
    );
    onPhase?.("report-existing-new-sidecar-policy");
    if (!existsSync(path) && !allowInitialize) {
      return yield* Effect.fail(failure("P39_REPORT_DB_PATH_INVALID"));
    }
    if (!existsSync(path)) {
      try {
        const descriptor = openSync(path, "wx", 0o600);
        closeSync(descriptor);
        if (process.platform !== "win32") chmodSync(path, 0o600);
      } catch (cause) {
        if (
          typeof cause !== "object" ||
          cause === null ||
          !("code" in cause) ||
          cause.code !== "EEXIST"
        ) {
          return yield* Effect.fail(
            failure("P39_UNSUPPORTED_DEPLOYMENT", cause),
          );
        }
      }
    }
    onPhase?.("report-initial-file-identity");
    const originalIdentity = fileIdentity(path);
    if (typeof originalIdentity !== "string") {
      return yield* Effect.fail(originalIdentity);
    }
    onPhase?.("report-profile-open-init-readback");
    yield* Effect.scoped(
      Effect.provide(
        p39ReportSetup(allowInitialize, onPhase).pipe(
          Effect.mapError((cause: SqlError | P39MaintenanceFailure) =>
            typeof cause === "object" &&
            cause !== null &&
            "_tag" in cause &&
            cause._tag === "P39MaintenanceFailure"
              ? (cause as P39MaintenanceFailure)
              : failure("P39_REPORT_DB_IO_FAILURE", cause),
          ),
        ),
        SqliteClient.layer({ filename: path, disableWAL: true }),
      ),
    );
    onPhase?.("report-final-path-and-identity");
    const finalPath = yield* validateP39ReportSidecarPath(
      primaryFilename,
      path,
      protectedStoreFilenames,
      onPhase,
    );
    const finalIdentity = fileIdentity(finalPath);
    if (typeof finalIdentity !== "string") {
      return yield* Effect.fail(finalIdentity);
    }
    if (finalPath !== path || finalIdentity !== originalIdentity) {
      return yield* Effect.fail(failure("P39_UNSUPPORTED_DEPLOYMENT"));
    }
  }).pipe(
    Effect.mapError((cause: P39MaintenanceFailure | SqliteAdapterError) =>
      typeof cause === "object" &&
      cause !== null &&
      "_tag" in cause &&
      cause._tag === "P39MaintenanceFailure"
        ? (cause as P39MaintenanceFailure)
        : sqliteAdapterError("failed to prepare P39 report sidecar", cause),
    ),
  );
