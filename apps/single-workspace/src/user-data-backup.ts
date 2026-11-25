import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { reconcileRestoredLeases } from "@arbor/application";
import {
  acquireP39MaintenanceWriterExclusion,
  CURRENT_SCHEMA_VERSION,
  p39WriterLockFilename,
  p39WriterLockLayer,
  releaseP39WriterPermit,
} from "@arbor/persistence-sqlite";
import { Effect } from "effect";
import { makeHostProjectDirectories } from "./project-directories.js";
import { RESTORE_INCOMPLETE_MARKER } from "./user-data-restore-guard.js";

const casPattern = /^[a-f0-9]{64}$/u;
const registryPattern = /^directory-[a-f0-9]{64}\.json$/u;
const filePattern =
  /^(?:arbor\.db|arbor\.db\.blobs\/[a-f0-9]{64}|arbor\.db\.project-directories\/directory-[a-f0-9]{64}\.json)$/u;
const manifestName = "backup.json";
const exclusions = [
  "project-source-files",
  "model-configuration-and-credentials",
  "sandbox-authority-and-audit-files",
] as const;

interface BackupFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface UserDataBackupManifest {
  readonly format: "arbor-user-data";
  readonly version: 1;
  readonly schema: number;
  readonly createdAt: string;
  readonly files: ReadonlyArray<BackupFile>;
  readonly excluded: typeof exclusions;
  readonly symbolicEnvironmentSnapshotReferences: number;
}

/** Operator errors deliberately omit database content, model secrets and SQL. */
export class UserDataBackupError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function refuse(code: string): never {
  throw new UserDataBackupError(code);
}

const canonicalDirectory = (directory: string): string => {
  const path = resolve(directory);
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    realpathSync(path) !== path ||
    (process.getuid !== undefined && stat.uid !== process.getuid())
  ) {
    refuse("directory-must-be-owned-and-without-symlinks");
  }
  return path;
};

const syncDirectory = (path: string): void => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const newDirectory = (input: string): string => {
  const path = resolve(input);
  canonicalDirectory(dirname(path));
  // mkdir without recursive is the exclusive reservation; never overwrite.
  mkdirSync(path, { mode: 0o700 });
  syncDirectory(dirname(path));
  return path;
};

const writePrivate = (path: string, bytes: string): void => {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/** Stream through a no-follow descriptor, avoiding whole-Blob memory copies. */
const inspectOrCopy = (
  source: string,
  target?: string,
): Omit<BackupFile, "path"> => {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: number | undefined;
  try {
    const stat = fstatSync(input);
    if (
      !stat.isFile() ||
      (process.getuid !== undefined && stat.uid !== process.getuid())
    ) {
      refuse("backup-content-must-be-an-owned-regular-file");
    }
    if (target !== undefined) output = openSync(target, "wx", 0o600);
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (;;) {
      const count = readSync(input, chunk, 0, chunk.length, null);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
      if (output !== undefined) {
        let written = 0;
        while (written < count)
          written += writeSync(output, chunk, written, count - written);
      }
      bytes += count;
    }
    if (output !== undefined) fsyncSync(output);
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
  }
};

const validateDatabase = (database: DatabaseSync): void => {
  if (
    database.prepare("PRAGMA user_version").get()?.user_version !==
    CURRENT_SCHEMA_VERSION
  ) {
    refuse("only-current-database-format-is-supported-no-upgrade-performed");
  }
  if (
    database
      .prepare("PRAGMA integrity_check")
      .all()
      .some((row) => row.integrity_check !== "ok") ||
    database.prepare("PRAGMA foreign_key_check").all().length !== 0
  ) {
    refuse("database-integrity-check-failed");
  }
};

const withMaintenance = async <A>(
  databaseFile: string,
  body: () => Promise<A>,
): Promise<A> => {
  const lock = p39WriterLockFilename(databaseFile);
  if (typeof lock !== "string")
    refuse("database-path-does-not-support-maintenance");
  let bodyError: unknown;
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.acquireUseRelease(
            acquireP39MaintenanceWriterExclusion(),
            () =>
              Effect.tryPromise({
                try: async () => {
                  try {
                    return await body();
                  } catch (cause) {
                    bodyError = cause;
                    throw cause;
                  }
                },
                catch: (cause) => cause,
              }),
            (permit) => releaseP39WriterPermit(permit).pipe(Effect.orDie),
          ),
          p39WriterLockLayer(lock, 1000),
        ),
      ),
    );
  } catch {
    // Effect's rejected promise wraps typed failures. Preserve our own errors.
    if (bodyError instanceof UserDataBackupError) throw bodyError;
    const error = new UserDataBackupError(
      "maintenance-failed-stop-arbor-and-check-data-permissions",
    );
    throw error;
  }
};

// The typed reference inventory is defined below; arbitrary 64-character hashes
// (provider fingerprints, command digests, etc.) are not Blob references.
const referencedBlobs = (database: DatabaseSync): Set<string> => {
  const refs = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && casPattern.test(value)) refs.add(value);
  };
  for (const [table, column] of [
    ["artifacts", "blob_ref"],
    ["environment_changes", "snapshot_blob_ref"],
    ["verifications", "summary_ref"],
  ] as const) {
    for (const row of database
      .prepare(`SELECT ${column} AS ref FROM ${table}`)
      .iterate())
      add(row.ref);
  }
  // Deliver stores the model's summary inline. Even a checksum-only summary
  // is text, whereas SendMessage's four other kinds store BlobStore refs.
  for (const row of database
    .prepare("SELECT body_ref AS ref FROM messages WHERE kind <> 'Deliver'")
    .iterate())
    add(row.ref);
  for (const row of database
    .prepare(
      "SELECT checkpoint_ref AS ref FROM conversation_checkpoint_owners WHERE checkpoint_kind = 'Summary'",
    )
    .iterate())
    add(row.ref);
  const object = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const json = (value: unknown): Record<string, unknown> | undefined => {
    if (value === null) return undefined;
    if (typeof value !== "string") refuse("invalid-reference-json");
    return object(JSON.parse(value));
  };
  for (const row of database
    .prepare(
      "SELECT payload_json FROM session_entries WHERE item_type = 'AttachmentRef'",
    )
    .iterate()) {
    const item = json(row.payload_json);
    if (item?._tag === "AttachmentRef") add(item.ref);
  }
  for (const row of database
    .prepare(
      "SELECT portable_request_json FROM model_context_manifests WHERE portable_request_json IS NOT NULL",
    )
    .iterate()) {
    const items = json(row.portable_request_json)?.inputItems;
    if (Array.isArray(items))
      for (const item of items) {
        const attachment = object(item);
        if (attachment?._tag === "AttachmentRef") add(attachment.ref);
      }
  }
  for (const row of database
    .prepare(
      "SELECT payload_json FROM domain_events WHERE event_type = 'VerificationConcluded'",
    )
    .iterate())
    add(json(row.payload_json)?.summaryRef);
  for (const row of database
    .prepare("SELECT result_json FROM commands WHERE result_json IS NOT NULL")
    .iterate()) {
    const result = json(row.result_json);
    if (
      result?.state === "Concluded" &&
      typeof result.verificationId === "string"
    )
      add(result.summaryRef);
  }
  return refs;
};

const symbolicSnapshotCount = (database: DatabaseSync): number =>
  [
    ...database
      .prepare("SELECT snapshot_blob_ref FROM environment_changes")
      .iterate(),
  ].filter(
    (row) =>
      typeof row.snapshot_blob_ref !== "string" ||
      !casPattern.test(row.snapshot_blob_ref),
  ).length;

const directoryEntries = (directory: string, pattern: RegExp): string[] => {
  try {
    lstatSync(directory);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  canonicalDirectory(directory);
  return readdirSync(directory)
    .filter((name) => {
      if (name.startsWith(".pending-")) return false;
      if (!pattern.test(name)) refuse("unexpected-user-data-file");
      return true;
    })
    .sort();
};

/** Stopped-service backup: one real P39 permit spans SQLite + Blob + registry. */
export const createUserDataBackup = async (
  databaseFile: string,
  destination: string,
): Promise<UserDataBackupManifest> => {
  const source = resolve(databaseFile);
  canonicalDirectory(dirname(source));
  if (realpathSync(source) !== source)
    refuse("database-symlinks-are-not-supported");
  return withMaintenance(source, async () => {
    const root = newDirectory(destination);
    const database = new DatabaseSync(source, { readOnly: true });
    try {
      validateDatabase(database);
      const refs = referencedBlobs(database);
      const persistent = `${source}.blobs`;
      const blobNames = new Set([
        ...directoryEntries(persistent, casPattern),
        ...refs,
      ]);
      const registry = `${source}.project-directories`;
      const registryNames = directoryEntries(registry, registryPattern);
      makeHostProjectDirectories({ registryDirectory: registry });
      mkdirSync(join(root, "arbor.db.blobs"), { mode: 0o700 });
      mkdirSync(join(root, "arbor.db.project-directories"), { mode: 0o700 });
      const files: BackupFile[] = [];
      writePrivate(join(root, "arbor.db"), "");
      await backup(database, join(root, "arbor.db"));
      const snapshot = new DatabaseSync(join(root, "arbor.db"));
      try {
        // A portable, closed snapshot must not need external WAL/SHM files.
        snapshot.exec(
          "PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL",
        );
        validateDatabase(snapshot);
      } finally {
        snapshot.close();
      }
      const fd = openSync(join(root, "arbor.db"), "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      files.push({
        path: "arbor.db",
        ...inspectOrCopy(join(root, "arbor.db")),
      });
      for (const ref of [...blobNames].sort()) {
        const location = existsSync(join(persistent, ref))
          ? join(persistent, ref)
          : join(tmpdir(), "arbor-blobs", ref);
        if (!existsSync(location)) refuse("referenced-content-is-missing");
        canonicalDirectory(dirname(location));
        const path = `arbor.db.blobs/${ref}`;
        const info = inspectOrCopy(location, join(root, path));
        if (info.sha256 !== ref) refuse("blob-content-hash-mismatch");
        files.push({ path, ...info });
      }
      for (const name of registryNames) {
        const path = `arbor.db.project-directories/${name}`;
        files.push({
          path,
          ...inspectOrCopy(join(registry, name), join(root, path)),
        });
      }
      const manifest: UserDataBackupManifest = {
        format: "arbor-user-data",
        version: 1,
        schema: CURRENT_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        files,
        excluded: exclusions,
        symbolicEnvironmentSnapshotReferences: symbolicSnapshotCount(database),
      };
      syncDirectory(join(root, "arbor.db.blobs"));
      syncDirectory(join(root, "arbor.db.project-directories"));
      // Written last: a partial backup is never accepted by verify/restore.
      writePrivate(
        join(root, manifestName),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      syncDirectory(root);
      return manifest;
    } finally {
      database.close();
    }
  });
};

export const verifyUserDataBackup = (
  directory: string,
): UserDataBackupManifest => {
  const root = canonicalDirectory(directory);
  inspectOrCopy(join(root, manifestName));
  const parsed: unknown = JSON.parse(
    readFileSync(join(root, manifestName), "utf8"),
  );
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("format" in parsed) ||
    parsed.format !== "arbor-user-data" ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("schema" in parsed) ||
    parsed.schema !== CURRENT_SCHEMA_VERSION ||
    !("createdAt" in parsed) ||
    typeof parsed.createdAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.createdAt)) ||
    !("files" in parsed) ||
    !Array.isArray(parsed.files) ||
    !("excluded" in parsed) ||
    JSON.stringify(parsed.excluded) !== JSON.stringify(exclusions) ||
    !("symbolicEnvironmentSnapshotReferences" in parsed) ||
    !Number.isSafeInteger(parsed.symbolicEnvironmentSnapshotReferences) ||
    Number(parsed.symbolicEnvironmentSnapshotReferences) < 0
  ) {
    refuse("unsupported-or-incomplete-backup-manifest");
  }
  const manifest = parsed as UserDataBackupManifest;
  const expected = new Set<string>();
  for (const file of manifest.files) {
    if (
      typeof file !== "object" ||
      file === null ||
      typeof file.path !== "string" ||
      !filePattern.test(file.path) ||
      expected.has(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      typeof file.sha256 !== "string" ||
      !casPattern.test(file.sha256)
    ) {
      refuse("invalid-backup-inventory");
    }
    expected.add(file.path);
    canonicalDirectory(dirname(join(root, file.path)));
    const info = inspectOrCopy(join(root, file.path));
    if (
      info.bytes !== file.bytes ||
      info.sha256 !== file.sha256 ||
      (file.path.startsWith("arbor.db.blobs/") &&
        !file.path.endsWith(`/${file.sha256}`))
    ) {
      refuse("backup-file-missing-or-corrupt");
    }
  }
  if (!expected.has("arbor.db")) refuse("backup-database-is-missing");
  const actual = new Set([
    ...readdirSync(root).filter(
      (name) =>
        name !== manifestName &&
        name !== "arbor.db.blobs" &&
        name !== "arbor.db.project-directories",
    ),
    ...directoryEntries(join(root, "arbor.db.blobs"), casPattern).map(
      (name) => `arbor.db.blobs/${name}`,
    ),
    ...directoryEntries(
      join(root, "arbor.db.project-directories"),
      registryPattern,
    ).map((name) => `arbor.db.project-directories/${name}`),
  ]);
  if (
    actual.size !== expected.size ||
    [...actual].some((path) => !expected.has(path))
  )
    refuse("backup-inventory-does-not-match-files");
  const database = new DatabaseSync(join(root, "arbor.db"), { readOnly: true });
  try {
    validateDatabase(database);
    if (
      symbolicSnapshotCount(database) !==
      manifest.symbolicEnvironmentSnapshotReferences
    )
      refuse("backup-reference-report-does-not-match-database");
    for (const ref of referencedBlobs(database)) {
      if (!expected.has(`arbor.db.blobs/${ref}`))
        refuse("backup-omits-referenced-content");
    }
  } finally {
    database.close();
  }
  makeHostProjectDirectories({
    registryDirectory: join(root, "arbor.db.project-directories"),
  });
  return manifest;
};

/** Restore only into an exclusively created directory, never replace user data. */
export const restoreUserDataBackup = async (
  directory: string,
  destination: string,
): Promise<{ readonly invalidatedLeases: number }> => {
  const source = canonicalDirectory(directory);
  const manifest = verifyUserDataBackup(source);
  const target = newDirectory(destination);
  writePrivate(
    join(target, RESTORE_INCOMPLETE_MARKER),
    "Restore incomplete; do not start Arbor here.\n",
  );
  syncDirectory(target);
  mkdirSync(join(target, "arbor.db.blobs"), { mode: 0o700 });
  mkdirSync(join(target, "arbor.db.project-directories"), { mode: 0o700 });
  for (const file of manifest.files) {
    const info = inspectOrCopy(
      join(source, file.path),
      join(target, file.path),
    );
    if (info.bytes !== file.bytes || info.sha256 !== file.sha256)
      refuse("backup-changed-during-restore");
  }
  const invalidatedLeases = await withMaintenance(
    join(target, "arbor.db"),
    async () => {
      const database = new DatabaseSync(join(target, "arbor.db"));
      try {
        database.exec("PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
        validateDatabase(database);
        const leases = database
          .prepare(
            "SELECT execution_id, worker_id, worker_incarnation_id, generation FROM execution_leases",
          )
          .all();
        const reconciled = reconcileRestoredLeases(
          leases.map((row) => {
            if (
              typeof row.execution_id !== "string" ||
              typeof row.worker_id !== "string" ||
              typeof row.worker_incarnation_id !== "string" ||
              typeof row.generation !== "number" ||
              !Number.isSafeInteger(row.generation) ||
              row.generation < 0 ||
              row.generation >= Number.MAX_SAFE_INTEGER
            )
              refuse("invalid-restored-lease");
            return {
              executionId: row.execution_id,
              workerId: row.worker_id,
              workerIncarnationId: row.worker_incarnation_id,
              generation: row.generation,
            };
          }),
        );
        const update = database.prepare(
          "UPDATE execution_leases SET worker_incarnation_id = ?, generation = ?, expires_at = ?, updated_at = ? WHERE execution_id = ?",
        );
        for (const lease of reconciled.reconciled)
          update.run(
            lease.workerIncarnationId,
            lease.generation,
            "1970-01-01T00:00:00.000Z",
            new Date().toISOString(),
            lease.executionId,
          );
        database.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
        return reconciled.invalidatedCount;
      } finally {
        database.close();
      }
    },
  );
  syncDirectory(join(target, "arbor.db.blobs"));
  syncDirectory(join(target, "arbor.db.project-directories"));
  unlinkSync(join(target, RESTORE_INCOMPLETE_MARKER));
  syncDirectory(target);
  // The ordinary launcher runs normal startup recovery before accepting work.
  return { invalidatedLeases };
};
