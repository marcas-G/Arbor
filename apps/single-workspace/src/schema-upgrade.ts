import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  layer,
  P36_MIGRATIONS,
  P37_MIGRATIONS,
  P38_MIGRATIONS,
  P39_MAINTENANCE_MIGRATION_MANIFEST,
  P39_MAINTENANCE_MIGRATIONS,
  P40_TOOL_OBSERVATION_REPLAY_MIGRATION,
  P41_SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION,
  P42_PROJECT_RESOURCE_SOURCE_MIGRATION,
  p39WriterLockFilename,
  runMigrations,
  runP39SqliteMaintenance,
  runP39SqliteMaintenanceWithPermit,
  splitStatements,
  validateP39ProtectedDirectory,
} from "@arbor/persistence-sqlite";
import { sha256Hex } from "@arbor/ports";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  appendSchemaUpgradeRecord,
  assertDistinctPaths,
  canonicalExistingPath,
  canonicalNewPath,
  createSchemaUpgradeManifest,
  descriptorHashesThrough,
  existingPathIdentity,
  logicalSqliteDigest,
  prefixSignature,
  prefixSignatureForDigest,
  readSchemaUpgradeManifest,
  readUserVersion,
  reserveNewFile,
  type SchemaUpgradeMaintenancePhase,
  type SchemaUpgradeManifest,
  type SchemaUpgradeMode,
  type SchemaUpgradePathIdentity,
  SchemaUpgradeRefusal,
  sameIdentity,
  sqliteSchemaSignature,
  verifyP39ReportEvidence,
} from "./schema-upgrade-manifest.js";

const PINNED_DESCRIPTOR_HASHES: Readonly<Record<number, string>> = {
  37: "0d23988891b3a19a36b6a836a9697d674667681dde2123be4dcae6659e39e737",
  38: "fa109e056d88c49dada808a7b0bcc9edce4595d1812990c0fa4facd0b248110d",
  39: "6e791168987f23f5c282ce7d6bd2c5b5ad8361942dab968adbcca64aab753aec",
  40: "3b06ee795277152a3e09a97679c4017b5c7ad3d1009f8cd14b04329a2be002aa",
  41: "d3ad9133ea28150a271c9867ae390c1f6ba0692f9e6b449817b8aeae2aa1dfed",
  42: "a0294a5db440e402a6c32b5a2b596502e059642431157eadcb6be7212224e5aa",
};

/** Offline resume may hold the permit while checking trusted file provenance
 * and applying several schema transactions. A competing resume can wait up to
 * the CLI qualification window; lock timeout still fails closed. Runtime
 * callers retain the P39 default. */
const CLI_MAINTENANCE_PERMIT_BUSY_TIMEOUT_MS = 1_200_000;
const MAX_CLI_FAILURE_DETAIL_LENGTH = 512;

const safeErrorLabel = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value.replace(/[^A-Za-z0-9_.-]/gu, "?").slice(0, 80)
    : undefined;

const safeSchemaRefusalMessage = (message: string): string =>
  message
    .replace(
      /\b(secret|token|password|api[_-]?key|authorization)\b\s*[:=]\s*[^\s,;]+/giu,
      "$1=<redacted>",
    )
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[\s\S]*$/u, "<path>")
    .replace(/(^|[^A-Za-z0-9._-])\/[\s\S]*$/u, "$1<path>")
    .slice(0, 180);

export const formatSchemaUpgradeCliFailure = (
  cause: unknown,
  depth = 0,
): string => {
  if (cause instanceof Error) {
    const name =
      safeErrorLabel(
        cause instanceof SchemaUpgradeRefusal ? cause._tag : cause.name,
      ) ?? "Error";
    const message =
      cause instanceof SchemaUpgradeRefusal
        ? safeSchemaRefusalMessage(cause.message)
        : undefined;
    const diagnostic =
      cause instanceof SchemaUpgradeRefusal ? cause.diagnostic : undefined;
    const labels = [
      name,
      safeErrorLabel(diagnostic?.phase),
      safeErrorLabel(diagnostic?.code),
      safeErrorLabel(diagnostic?.reasonCode),
    ].filter((field): field is string => field !== undefined);
    const summary = labels.join("/");
    return [summary, message]
      .filter(Boolean)
      .join(": ")
      .slice(0, MAX_CLI_FAILURE_DETAIL_LENGTH);
  }
  if (depth > 4) return "[nested failure]";
  if (typeof cause === "object" && cause !== null) {
    const fields = cause as Record<string, unknown>;
    const identity = [fields._tag, fields.code, fields.reasonCode]
      .map(safeErrorLabel)
      .filter((field): field is string => field !== undefined)
      .join("/");
    const message =
      fields._tag === "SchemaUpgradeRefusal" &&
      typeof fields.message === "string"
        ? safeSchemaRefusalMessage(fields.message)
        : undefined;
    const nested =
      "cause" in fields
        ? formatSchemaUpgradeCliFailure(fields.cause, depth + 1)
        : undefined;
    return (
      [identity || "structured failure", message, nested]
        .filter((field): field is string => field !== undefined && field !== "")
        .join(": ")
        .slice(0, MAX_CLI_FAILURE_DETAIL_LENGTH) || "unknown structured failure"
    );
  }
  return typeof cause === "string" ? "string failure" : String(cause);
};

const findP39FailureCode = (
  cause: unknown,
  depth = 0,
): { code: string; reasonCode?: string } | undefined => {
  if (depth > 4 || typeof cause !== "object" || cause === null) {
    return undefined;
  }
  const fields = cause as Record<string, unknown>;
  if (
    fields._tag === "P39MaintenanceFailure" &&
    typeof fields.code === "string" &&
    /^P39_[A-Z0-9_]{1,72}$/u.test(fields.code)
  ) {
    const nested = findP39FailureCode(fields.cause, depth + 1);
    return {
      code: fields.code,
      ...(nested?.reasonCode === undefined
        ? {}
        : { reasonCode: nested.reasonCode }),
    };
  }
  if (
    fields._tag === "P39UnsupportedDeploymentDiagnostic" &&
    typeof fields.reasonCode === "string" &&
    /^P39_[A-Z0-9_]{1,72}$/u.test(fields.reasonCode)
  ) {
    return {
      code: "P39_UNSUPPORTED_DEPLOYMENT",
      reasonCode: fields.reasonCode,
    };
  }
  return "cause" in fields
    ? findP39FailureCode(fields.cause, depth + 1)
    : undefined;
};

const pinnedDescriptorHash = (version: number): string =>
  PINNED_DESCRIPTOR_HASHES[version] ??
  (() => {
    throw new SchemaUpgradeRefusal(
      `migration ${version} has no accepted SHA-256 pin`,
    );
  })();

export interface SchemaUpgradeArguments {
  readonly mode: SchemaUpgradeMode;
  readonly database: string;
  readonly sourceDatabase?: string;
  readonly p39ReportDatabase: string;
  readonly copyManifest: string;
}

/** Immutable process-local preview material for the offline qualification
 * hooks. Reuse is accepted only when the live target matches one exact
 * version, logical digest, and schema signature in this template. */
export interface SchemaUpgradePreviewTemplate {
  readonly sourceVersion: number;
  readonly prefixes: ReadonlyMap<
    number,
    { readonly digest: string; readonly signature: string }
  >;
  readonly p39Blocked: boolean;
  readonly sourceDigest: string;
}

/** Process-local fault point used only by the offline CLI qualification suite.
 * It is never populated by the command-line parser. */
export interface SchemaUpgradeTestHooks {
  readonly previewTemplate?: SchemaUpgradePreviewTemplate;
  readonly onPreviewTemplate?: (template: SchemaUpgradePreviewTemplate) => void;
  readonly beforeDatabaseTransaction?: (version: 39 | 40 | 41 | 42) => void;
  readonly afterDatabaseCommit?: (version: 39 | 40 | 41 | 42) => void;
  readonly afterVersion42NoOpVerification?: (evidence: {
    readonly userVersion: 42;
    readonly reopenedReadOnly: true;
  }) => void;
  readonly beforeMaintenancePermitAcquire?: () => void;
  readonly onMaintenanceFailure?: (
    phase: SchemaUpgradeMaintenancePhase,
    cause: unknown,
  ) => void;
}

export const parseSchemaUpgradeArguments = (
  args: ReadonlyArray<string>,
): SchemaUpgradeArguments => {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") {
      throw new SchemaUpgradeRefusal(schemaUpgradeUsage());
    }
    if (flag === undefined || !flag.startsWith("--")) {
      throw new SchemaUpgradeRefusal(
        `unexpected argument: ${flag ?? ""}\n${schemaUpgradeUsage()}`,
      );
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new SchemaUpgradeRefusal(
        `missing value for ${flag}\n${schemaUpgradeUsage()}`,
      );
    }
    if (values.has(flag))
      throw new SchemaUpgradeRefusal(`duplicate option: ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  const allowed = new Set([
    "--mode",
    "--database",
    "--source-database",
    "--p39-report-db",
    "--copy-manifest",
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key))
      throw new SchemaUpgradeRefusal(`unknown option: ${key}`);
  }
  const mode = values.get("--mode");
  const database = values.get("--database");
  const p39ReportDatabase = values.get("--p39-report-db");
  const copyManifest = values.get("--copy-manifest");
  if (
    (mode !== "fresh" && mode !== "copy" && mode !== "resume-copy") ||
    database === undefined ||
    p39ReportDatabase === undefined ||
    copyManifest === undefined
  )
    throw new SchemaUpgradeRefusal(
      `mode, --database, --p39-report-db, and --copy-manifest are required\n${schemaUpgradeUsage()}`,
    );
  const sourceDatabase = values.get("--source-database");
  if (
    mode === "fresh"
      ? sourceDatabase !== undefined
      : sourceDatabase === undefined
  ) {
    throw new SchemaUpgradeRefusal(
      mode === "fresh"
        ? "fresh mode does not accept --source-database"
        : `${mode} mode requires --source-database`,
    );
  }
  return {
    mode,
    database,
    ...(sourceDatabase === undefined ? {} : { sourceDatabase }),
    p39ReportDatabase,
    copyManifest,
  };
};

export const schemaUpgradeUsage = (): string =>
  [
    "Offline P39–P42 schema upgrade (operator-selected disposable target)",
    "  --mode fresh --database <new-target> --p39-report-db <new-report> --copy-manifest <new-manifest>",
    "  --mode copy --source-database <offline-source> --database <new-copy> --p39-report-db <new-report> --copy-manifest <new-manifest>",
    "  --mode resume-copy --source-database <same-source> --database <same-copy> --p39-report-db <same-report> --copy-manifest <same-manifest>",
  ].join("\n");

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
};

const runOnDatabase = <A>(
  filename: string,
  program: Effect.Effect<A, unknown, SqlClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(program, layer({ filename }))),
  );

const readVersionWithOpenSource = (database: DatabaseSync): number =>
  Number(
    (database.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );

const protectedApplicationDatabases = (): ReadonlyArray<string> => {
  const configured = process.env.ARBOR_DB;
  const candidate =
    configured === undefined
      ? resolve("./arbor-slice.db")
      : resolve(configured);
  return existsSync(candidate) ? [canonicalExistingPath(candidate)] : [];
};

const identityOrNull = (
  path: string | undefined,
): SchemaUpgradePathIdentity | null =>
  path === undefined ? null : existingPathIdentity(path);

const ensureNoDatabaseSidecars = (filename: string): void => {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (existsSync(`${filename}${suffix}`))
      throw new SchemaUpgradeRefusal(
        `SQLite sidecar already exists: ${filename}${suffix}`,
      );
  }
};

const rejectSqliteArtifactAliases = (
  databasePaths: ReadonlyArray<string>,
  evidencePaths: ReadonlyArray<string>,
): void => {
  const dbSidecars = databasePaths.flatMap((database) =>
    ["-wal", "-shm", "-journal"].map((suffix) =>
      resolve(`${database}${suffix}`).toLowerCase(),
    ),
  );
  for (const path of [...databasePaths, ...evidencePaths]) {
    if (dbSidecars.includes(resolve(path).toLowerCase())) {
      throw new SchemaUpgradeRefusal(`path aliases a SQLite sidecar: ${path}`);
    }
  }
};

const validatePathSet = (
  args: SchemaUpgradeArguments,
): {
  targetPath: string;
  reportPath: string;
  manifestPath: string;
  sourceIdentity: SchemaUpgradePathIdentity | null;
} => {
  if (args.mode === "resume-copy") {
    const sourcePath = canonicalExistingPath(args.sourceDatabase as string);
    const targetPath = canonicalExistingPath(args.database);
    const reportPath = canonicalExistingPath(args.p39ReportDatabase);
    const manifestPath = canonicalExistingPath(args.copyManifest);
    rejectSqliteArtifactAliases(
      [sourcePath, targetPath, reportPath],
      [manifestPath],
    );
    const sourceIdentity = existingPathIdentity(sourcePath);
    const targetIdentity = existingPathIdentity(targetPath);
    const reportIdentity = existingPathIdentity(reportPath);
    const manifestIdentity = existingPathIdentity(manifestPath);
    const lockPath = p39WriterLockFilename(targetPath);
    if (typeof lockPath !== "string")
      throw new SchemaUpgradeRefusal(
        `P39 writer lock path is unsupported: ${lockPath.code}`,
      );
    const lockIdentity = existingPathIdentity(lockPath);
    assertDistinctPaths([
      ["source", sourceIdentity],
      ["target", targetIdentity],
      ["P39 report", reportIdentity],
      ["copy manifest", manifestIdentity],
      ["writer lock", lockIdentity],
    ]);
    rejectSqliteArtifactAliases(
      [sourcePath, targetPath, reportPath, lockPath],
      [manifestPath],
    );
    return { targetPath, reportPath, manifestPath, sourceIdentity };
  }
  const sourcePath =
    args.mode === "copy"
      ? canonicalExistingPath(args.sourceDatabase as string)
      : undefined;
  const targetPath = canonicalNewPath(args.database);
  const reportPath = canonicalNewPath(args.p39ReportDatabase);
  const manifestPath = canonicalNewPath(args.copyManifest);
  const sourceIdentity = identityOrNull(sourcePath);
  const identities = [
    ["source", sourceIdentity],
    ["target", null],
    ["P39 report", null],
    ["copy manifest", null],
  ] as const;
  assertDistinctPaths(identities);
  for (const [leftName, leftPath] of [
    ["target", targetPath],
    ["P39 report", reportPath],
    ["copy manifest", manifestPath],
  ] as const) {
    for (const [rightName, rightPath] of [
      ["target", targetPath],
      ["P39 report", reportPath],
      ["copy manifest", manifestPath],
    ] as const) {
      if (
        leftName !== rightName &&
        resolve(leftPath).toLowerCase() === resolve(rightPath).toLowerCase()
      ) {
        throw new SchemaUpgradeRefusal(`${leftName} aliases ${rightName}`);
      }
    }
  }
  if (
    sourceIdentity !== null &&
    [targetPath, reportPath, manifestPath].some(
      (path) =>
        resolve(path).toLowerCase() ===
        resolve(sourceIdentity.canonicalPath).toLowerCase(),
    )
  ) {
    throw new SchemaUpgradeRefusal(
      "source aliases a new target or evidence path",
    );
  }
  for (const protectedPath of protectedApplicationDatabases()) {
    const protectedIdentity = existingPathIdentity(protectedPath);
    if (
      [targetPath, reportPath, manifestPath].some(
        (path) =>
          resolve(path).toLowerCase() ===
          resolve(protectedIdentity.canonicalPath).toLowerCase(),
      )
    ) {
      throw new SchemaUpgradeRefusal(
        "new target or evidence path aliases the configured application database",
      );
    }
  }
  for (const path of [targetPath, reportPath, manifestPath])
    ensureNoDatabaseSidecars(path);
  rejectSqliteArtifactAliases(
    [...(sourcePath === undefined ? [] : [sourcePath]), targetPath, reportPath],
    [manifestPath],
  );
  return { targetPath, reportPath, manifestPath, sourceIdentity };
};

const assertSourcePrefix = (version: number): void => {
  if (![36, 37, 38].includes(version))
    throw new SchemaUpgradeRefusal(
      `copy source schema ${version} is unsupported; expected 36, 37, or 38`,
    );
};

const verifySourcePrefixSchema = async (
  filename: string,
  version: number,
): Promise<void> => {
  const directory = mkdtempSync(
    join(dirname(filename), ".arbor-schema-prefix-check-"),
  );
  try {
    if (!validateP39ProtectedDirectory(directory))
      throw new SchemaUpgradeRefusal(
        "source-prefix verification directory failed the P39 protected ACL/local-volume checks",
      );
    const expectedDatabase = join(directory, "expected.sqlite");
    reserveNewFile(expectedDatabase);
    const migrations =
      version === 36
        ? P36_MIGRATIONS
        : version === 37
          ? P37_MIGRATIONS
          : P38_MIGRATIONS;
    await runOnDatabase(expectedDatabase, runMigrations(migrations));
    const actualVersion = readUserVersion(filename);
    const expectedVersion = readUserVersion(expectedDatabase);
    if (
      actualVersion !== version ||
      expectedVersion !== version ||
      sqliteSchemaSignature(filename) !==
        sqliteSchemaSignature(expectedDatabase)
    )
      throw new SchemaUpgradeRefusal(
        `schema ${version} source does not match the trusted cumulative descriptor prefix`,
      );
  } finally {
    const canonicalDirectory = realpathSync.native(directory);
    if (
      resolve(dirname(canonicalDirectory)).toLowerCase() !==
        resolve(dirname(filename)).toLowerCase() ||
      !basename(canonicalDirectory).startsWith(".arbor-schema-prefix-check-")
    ) {
      // A mismatch means the generated private scratch path was replaced by
      // the trusted OS identity. Leave it untouched for operator review.
    } else {
      rmSync(canonicalDirectory, { recursive: true, force: false });
    }
  }
};

const runFreshPrefix = async (targetPath: string): Promise<void> => {
  await runOnDatabase(targetPath, runMigrations(P38_MIGRATIONS));
  if (readUserVersion(targetPath) !== 38)
    throw new SchemaUpgradeRefusal(
      "fresh target did not reach the exact P38 prefix",
    );
};

const assertSourceUnchanged = (source: {
  readonly path: string;
  readonly identity: SchemaUpgradePathIdentity;
  readonly version: number;
  readonly digest: string;
}): void => {
  if (
    !sameIdentity(existingPathIdentity(source.path), source.identity) ||
    readUserVersion(source.path) !== source.version ||
    logicalSqliteDigest(source.path) !== source.digest
  )
    throw new SchemaUpgradeRefusal(
      "read-only copy source identity or logical content changed during offline upgrade",
    );
};

const createOrCopyTarget = async (
  args: SchemaUpgradeArguments,
  paths: ReturnType<typeof validatePathSet>,
): Promise<{
  target: SchemaUpgradePathIdentity;
  report: SchemaUpgradePathIdentity;
  lock: SchemaUpgradePathIdentity;
  manifestPath: string;
  source: SchemaUpgradePathIdentity | null;
  sourceVersion: number | null;
  sourceDigest: string | null;
}> => {
  let source: SchemaUpgradePathIdentity | null = null;
  let sourceVersion: number | null = null;
  let sourceDigest: string | null = null;
  if (args.mode === "copy") {
    source = paths.sourceIdentity;
    if (source === null)
      throw new SchemaUpgradeRefusal("copy source identity is missing");
    const sourceDb = new DatabaseSync(source.canonicalPath, { readOnly: true });
    try {
      sourceVersion = readVersionWithOpenSource(sourceDb);
      assertSourcePrefix(sourceVersion);
      await verifySourcePrefixSchema(source.canonicalPath, sourceVersion);
      sourceDigest = logicalSqliteDigest(source.canonicalPath);
      reserveNewFile(paths.targetPath);
      await backup(sourceDb, paths.targetPath);
      const copiedTarget = new DatabaseSync(paths.targetPath);
      try {
        const journal = copiedTarget
          .prepare("PRAGMA journal_mode = WAL")
          .get() as { journal_mode: string };
        if (journal.journal_mode.toLowerCase() !== "wal")
          throw new SchemaUpgradeRefusal(
            "new copy target could not enter the P39-required WAL mode",
          );
        copiedTarget.exec(
          "PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON",
        );
      } finally {
        copiedTarget.close();
      }
      if (logicalSqliteDigest(paths.targetPath) !== sourceDigest)
        throw new SchemaUpgradeRefusal(
          "SQLite backup target digest differs from read-only source snapshot",
        );
      if (
        readVersionWithOpenSource(sourceDb) !== sourceVersion ||
        logicalSqliteDigest(source.canonicalPath) !== sourceDigest
      ) {
        throw new SchemaUpgradeRefusal(
          "copy source changed during the SQLite backup operation",
        );
      }
    } finally {
      sourceDb.close();
    }
  } else {
    reserveNewFile(paths.targetPath);
    await runFreshPrefix(paths.targetPath);
  }
  const target = existingPathIdentity(paths.targetPath);
  const report = reserveNewFile(paths.reportPath);
  const lockPath = p39WriterLockFilename(target.canonicalPath);
  if (typeof lockPath !== "string")
    throw new SchemaUpgradeRefusal(
      `P39 writer lock path is unsupported: ${lockPath.code}`,
    );
  if (
    resolve(lockPath).toLowerCase() ===
    resolve(paths.manifestPath).toLowerCase()
  ) {
    throw new SchemaUpgradeRefusal(
      "copy manifest aliases the P39 writer-lock database",
    );
  }
  const lockIdentity = existingPathIdentity(lockPath);
  assertDistinctPaths([
    ["target", target],
    ["P39 report", report],
    ["writer lock", lockIdentity],
    ["source", source],
  ]);
  return {
    target,
    report,
    lock: lockIdentity,
    manifestPath: paths.manifestPath,
    source,
    sourceVersion,
    sourceDigest,
  };
};

const createInitialManifest = (
  args: SchemaUpgradeArguments,
  values: Awaited<ReturnType<typeof createOrCopyTarget>>,
): SchemaUpgradeManifest => {
  const initialUserVersion = readUserVersion(values.target.canonicalPath);
  if (args.mode === "fresh" && initialUserVersion !== 38)
    throw new SchemaUpgradeRefusal("fresh manifest may only bind a P38 target");
  if (args.mode === "copy" && initialUserVersion !== values.sourceVersion)
    throw new SchemaUpgradeRefusal(
      "copied target version differs from the source snapshot",
    );
  const version = initialUserVersion;
  const digest = logicalSqliteDigest(values.target.canonicalPath);
  if (values.sourceDigest !== null && digest !== values.sourceDigest)
    throw new SchemaUpgradeRefusal("initial copied target digest mismatch");
  const report = values.report;
  const manifest = createSchemaUpgradeManifest(values.manifestPath, {
    mode: args.mode === "resume-copy" ? "copy" : args.mode,
    target: values.target,
    source: values.source,
    sourceUserVersion: values.sourceVersion,
    sourceDigest: values.sourceDigest,
    backupCompleted: args.mode === "copy",
    initialUserVersion: version,
    initialPrefixSignature: prefixSignature(
      values.target.canonicalPath,
      version,
      descriptorHashesThrough(version),
    ),
    initialSchemaSignature: sqliteSchemaSignature(values.target.canonicalPath),
    initialTargetDigest: digest,
    report,
  });
  assertDistinctPaths([
    ["target", values.target],
    ["report", values.report],
    ["writer lock", values.lock],
    ["source", values.source],
    ["manifest", manifest.identity],
  ]);
  for (const protectedPath of protectedApplicationDatabases()) {
    const protectedIdentity = existingPathIdentity(protectedPath);
    assertDistinctPaths([
      ["application database", protectedIdentity],
      ["manifest", manifest.identity],
    ]);
  }
  return manifest;
};

const manifestStepState = (
  manifest: SchemaUpgradeManifest,
): {
  version: number;
  lastDigest: string;
  lastPrefixSignature: string;
  isolated: boolean;
  pending?: {
    fromVersion: number;
    toVersion: number;
    step: string;
    descriptorHashes: ReadonlyArray<string>;
    expectedPostDigest: string;
    expectedPrefixSignature: string;
  };
  committedSteps: ReadonlyArray<string>;
} => {
  const header = manifest.header;
  if (
    !Number.isInteger(header.initialUserVersion) ||
    header.initialUserVersion < 36 ||
    header.initialUserVersion > 38 ||
    (header.mode === "copy" &&
      (header.source === null ||
        header.sourceUserVersion !== header.initialUserVersion ||
        header.sourceDigest === null ||
        !/^[0-9a-f]{64}$/u.test(header.sourceDigest) ||
        header.backupCompleted !== true)) ||
    (header.mode === "fresh" &&
      (header.source !== null ||
        header.sourceDigest !== null ||
        header.backupCompleted !== false ||
        header.initialUserVersion !== 38))
  )
    throw new SchemaUpgradeRefusal("manifest initial provenance is incomplete");
  const startingVersion = header.initialUserVersion;
  const transitions = [
    {
      step: "p39-0037-0039",
      from: startingVersion,
      to: 39,
      hashes: P39_MAINTENANCE_MIGRATIONS.filter(
        ({ id }) => id > startingVersion && id <= 39,
      ).map(({ id }) => pinnedDescriptorHash(id)),
    },
    ...([40, 41, 42] as const).map((to) => ({
      step: String(to).padStart(4, "0"),
      from: to - 1,
      to,
      hashes: [pinnedDescriptorHash(to)],
    })),
  ];
  if (
    transitions.some(
      ({ hashes }) =>
        hashes.length === 0 || hashes.some((hash) => hash === undefined),
    )
  ) {
    throw new SchemaUpgradeRefusal(
      "copy manifest descriptor prefix is incomplete",
    );
  }
  const backupRecords = manifest.records
    .slice(1)
    .filter(({ record }) => record.kind === "BackupCompleted");
  if (backupRecords.length !== (header.mode === "copy" ? 1 : 0))
    throw new SchemaUpgradeRefusal(
      "manifest backup-completion record count is invalid",
    );
  if (header.mode === "copy") {
    if (manifest.records[1]?.record.kind !== "BackupCompleted")
      throw new SchemaUpgradeRefusal(
        "copy manifest backup evidence must precede migration records",
      );
    const backup = backupRecords[0]?.record;
    if (
      backup?.sourceDigest !== header.sourceDigest ||
      canonicalJson(backup?.source) !== canonicalJson(header.source) ||
      canonicalJson(backup?.target) !== canonicalJson(header.target) ||
      backup?.targetDigest !== header.initialTargetDigest
    )
      throw new SchemaUpgradeRefusal(
        "copy manifest backup-completion evidence does not match its header",
      );
  }

  let version = startingVersion;
  let lastDigest = header.initialTargetDigest;
  let lastPrefixSignature = header.initialPrefixSignature;
  let transitionIndex = 0;
  let pending:
    | {
        fromVersion: number;
        toVersion: number;
        step: string;
        descriptorHashes: ReadonlyArray<string>;
        expectedPostDigest: string;
        expectedPrefixSignature: string;
      }
    | undefined;
  let isolated = false;
  const committedSteps: string[] = [];
  for (const envelope of manifest.records.slice(1)) {
    const record = envelope.record;
    if (record.kind === "BackupCompleted") continue;
    if (record.kind === "Prepared") {
      const expected = transitions[transitionIndex];
      if (
        pending !== undefined ||
        expected === undefined ||
        record.step !== expected.step ||
        Number(record.fromVersion) !== expected.from ||
        Number(record.toVersion) !== expected.to ||
        canonicalJson(record.descriptorHashes) !==
          canonicalJson(expected.hashes) ||
        record.sourceTargetDigest !== lastDigest ||
        typeof record.expectedPostDigest !== "string" ||
        !/^[0-9a-f]{64}$/u.test(record.expectedPostDigest) ||
        typeof record.expectedPrefixSignature !== "string" ||
        !/^[0-9a-f]{64}$/u.test(record.expectedPrefixSignature)
      ) {
        throw new SchemaUpgradeRefusal(
          "copy manifest prepared step sequence/prefix is invalid",
        );
      }
      pending = {
        fromVersion: expected.from,
        toVersion: expected.to,
        step: expected.step,
        descriptorHashes: expected.hashes,
        expectedPostDigest: record.expectedPostDigest,
        expectedPrefixSignature: record.expectedPrefixSignature,
      };
      continue;
    }
    if (record.kind === "Committed") {
      const expected = transitions[transitionIndex];
      if (
        pending === undefined ||
        expected === undefined ||
        record.step !== pending.step ||
        Number(record.fromVersion) !== pending.fromVersion ||
        Number(record.toVersion) !== pending.toVersion ||
        canonicalJson(record.descriptorHashes) !==
          canonicalJson(pending.descriptorHashes) ||
        typeof record.targetDigest !== "string" ||
        !/^[0-9a-f]{64}$/u.test(record.targetDigest) ||
        record.targetDigest !== pending.expectedPostDigest ||
        typeof record.prefixSignature !== "string" ||
        !/^[0-9a-f]{64}$/u.test(record.prefixSignature) ||
        record.prefixSignature !== pending.expectedPrefixSignature
      ) {
        throw new SchemaUpgradeRefusal(
          "copy manifest committed step does not close its prepared prefix",
        );
      }
      version = pending.toVersion;
      lastDigest = record.targetDigest;
      lastPrefixSignature = record.prefixSignature;
      committedSteps.push(pending.step);
      pending = undefined;
      transitionIndex += 1;
      continue;
    }
    if (record.kind === "Isolated") {
      if (
        pending?.step !== "p39-0037-0039" ||
        typeof record.reportKey !== "string" ||
        typeof record.reportContentHash !== "string"
      ) {
        throw new SchemaUpgradeRefusal(
          "P39 isolation record is not bound to a prepared P39 step/report",
        );
      }
      isolated = true;
      continue;
    }
    throw new SchemaUpgradeRefusal(
      `copy manifest contains an unsupported record kind: ${String(record.kind)}`,
    );
  }
  if (isolated && manifest.records.at(-1)?.record.kind !== "Isolated") {
    throw new SchemaUpgradeRefusal("P39 isolated manifest is not terminal");
  }
  const tail = manifest.records.at(-1)?.record;
  if (tail?.kind !== "Prepared") pending = undefined;
  return {
    version,
    lastDigest,
    lastPrefixSignature,
    isolated,
    ...(pending === undefined ? {} : { pending }),
    committedSteps,
  };
};

const validateResume = async (
  args: SchemaUpgradeArguments,
  paths: ReturnType<typeof validatePathSet>,
): Promise<{
  manifest: SchemaUpgradeManifest;
  target: SchemaUpgradePathIdentity;
  report: SchemaUpgradePathIdentity;
  source: SchemaUpgradePathIdentity;
}> => {
  let manifest = readSchemaUpgradeManifest(paths.manifestPath);
  const target = existingPathIdentity(paths.targetPath);
  const report = existingPathIdentity(paths.reportPath);
  const source = existingPathIdentity(args.sourceDatabase as string);
  const header = manifest.header;
  if (header.mode !== "copy" || header.backupCompleted !== true)
    throw new SchemaUpgradeRefusal(
      "only a provenance-valid copy target can be resumed",
    );
  if (
    header.source === null ||
    !sameIdentity(header.target, target) ||
    !sameIdentity(header.report, report) ||
    !sameIdentity(header.source, source)
  ) {
    throw new SchemaUpgradeRefusal(
      "source, target, or report identity differs from the copy manifest",
    );
  }
  if (
    header.target.canonicalPath !== target.canonicalPath ||
    header.report.canonicalPath !== report.canonicalPath ||
    header.source?.canonicalPath !== source.canonicalPath
  ) {
    throw new SchemaUpgradeRefusal(
      "resume path does not exactly match the manifest path",
    );
  }
  const sourceDb = new DatabaseSync(source.canonicalPath, { readOnly: true });
  try {
    const sourceVersion = readVersionWithOpenSource(sourceDb);
    if (
      sourceVersion !== header.sourceUserVersion ||
      logicalSqliteDigest(source.canonicalPath) !== header.sourceDigest
    ) {
      throw new SchemaUpgradeRefusal(
        "original copy source identity/version/content changed",
      );
    }
    assertSourcePrefix(sourceVersion);
    if (
      sqliteSchemaSignature(source.canonicalPath) !==
      header.initialSchemaSignature
    ) {
      throw new SchemaUpgradeRefusal(
        "original copy source schema signature differs from the initial manifest",
      );
    }
  } finally {
    sourceDb.close();
  }
  const reportRows = verifyP39ReportEvidence(report.canonicalPath, report);
  const targetFingerprint = sha256Hex(target.canonicalPath);
  if (
    reportRows.some((row) => {
      try {
        return (
          (JSON.parse(row.reportJson) as { databaseFingerprint?: string })
            .databaseFingerprint === targetFingerprint
        );
      } catch {
        return true;
      }
    })
  )
    throw new SchemaUpgradeRefusal(
      "a P39 blocker report permanently isolates this copy target",
    );
  const state = manifestStepState(manifest);
  if (state.isolated)
    throw new SchemaUpgradeRefusal("manifest records terminal P39 isolation");
  let actualVersion = readUserVersion(target.canonicalPath);
  let actualDigest = logicalSqliteDigest(target.canonicalPath);
  if (state.pending !== undefined) {
    if (
      actualVersion === state.pending.fromVersion &&
      actualDigest === state.lastDigest
    ) {
      // A transaction that did not commit is safe to retry from the exact
      // preceding manifest boundary.
    } else if (
      actualVersion === state.pending.toVersion &&
      actualDigest === state.pending.expectedPostDigest &&
      prefixSignature(
        target.canonicalPath,
        actualVersion,
        descriptorHashesThrough(actualVersion),
      ) === state.pending.expectedPrefixSignature
    ) {
      // The SQLite transaction committed, but the process stopped before the
      // durable Committed manifest record. The Prepared record pins this exact
      // destination logical digest and descriptor prefix.
      manifest = appendSchemaUpgradeRecord(manifest, {
        kind: "Committed",
        step: state.pending.step,
        fromVersion: state.pending.fromVersion,
        toVersion: state.pending.toVersion,
        descriptorHashes: state.pending.descriptorHashes,
        targetDigest: actualDigest,
        prefixSignature: state.pending.expectedPrefixSignature,
      });
      actualVersion = readUserVersion(target.canonicalPath);
      actualDigest = logicalSqliteDigest(target.canonicalPath);
    } else {
      throw new SchemaUpgradeRefusal(
        "prepared migration is not at its exact preceding committed boundary; refusing ambiguous recovery",
      );
    }
  } else if (
    actualVersion !== state.version ||
    actualDigest !== state.lastDigest ||
    prefixSignature(
      target.canonicalPath,
      actualVersion,
      descriptorHashesThrough(actualVersion),
    ) !== state.lastPrefixSignature
  ) {
    throw new SchemaUpgradeRefusal(
      "copy target version/content differs from its last committed manifest boundary",
    );
  }
  if (actualVersion < 36 || actualVersion > 42)
    throw new SchemaUpgradeRefusal(
      `resume target version ${actualVersion} is unsupported`,
    );
  return { manifest, target, report, source };
};

const migrationDescriptorByVersion = (version: number) => {
  switch (version) {
    case 40:
      return {
        ...P40_TOOL_OBSERVATION_REPLAY_MIGRATION,
        requiresUserVersion: 39,
      };
    case 41:
      return {
        ...P41_SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION,
        requiresUserVersion: 40,
      };
    case 42:
      return {
        ...P42_PROJECT_RESOURCE_SOURCE_MIGRATION,
        requiresUserVersion: 41,
      };
    default:
      return undefined;
  }
};

const validateDescriptorPin = (version: number): void => {
  if (version >= 37 && version <= 39) {
    const p39Descriptor = P39_MAINTENANCE_MIGRATIONS.find(
      ({ id }) => id === version,
    );
    if (
      p39Descriptor === undefined ||
      sha256Hex(p39Descriptor.sql) !== PINNED_DESCRIPTOR_HASHES[version] ||
      P39_MAINTENANCE_MIGRATION_MANIFEST[version]?.sha256 !==
        PINNED_DESCRIPTOR_HASHES[version]
    )
      throw new SchemaUpgradeRefusal(
        `P39 descriptor ${version} differs from the accepted offline plan pin`,
      );
    return;
  }
  const descriptor = migrationDescriptorByVersion(version);
  if (descriptor === undefined)
    throw new SchemaUpgradeRefusal(
      `no standalone descriptor for migration ${version}`,
    );
  if (sha256Hex(descriptor.sql) !== PINNED_DESCRIPTOR_HASHES[version])
    throw new SchemaUpgradeRefusal(
      `migration ${version} SQL differs from the accepted offline plan pin`,
    );
};

interface PreviewPrefix {
  readonly digest: string;
  readonly signature: string;
}

type PreviewPlan = SchemaUpgradePreviewTemplate;

/** Compute exact post-transaction logical digests against a private SQLite
 * backup. Prepared records can then distinguish a rolled-back step from a
 * database commit whose manifest acknowledgement was interrupted. */
const previewCommittedPrefixes = async (
  targetPath: string,
): Promise<PreviewPlan> => {
  const directory = mkdtempSync(
    join(dirname(targetPath), ".arbor-schema-preview-"),
  );
  let database: DatabaseSync | undefined;
  try {
    if (!validateP39ProtectedDirectory(directory))
      throw new SchemaUpgradeRefusal(
        "private schema preview directory failed the P39 protected ACL/local-volume checks",
      );
    const previewPath = join(directory, basename(targetPath));
    reserveNewFile(previewPath);
    const source = new DatabaseSync(targetPath, { readOnly: true });
    try {
      await backup(source, previewPath);
    } finally {
      source.close();
    }
    database = new DatabaseSync(previewPath);
    const startVersion = readVersionWithOpenSource(database);
    const sourceDigest = logicalSqliteDigest(previewPath);
    if (sourceDigest !== logicalSqliteDigest(targetPath))
      throw new SchemaUpgradeRefusal(
        "private SQLite backup differs from the target's logical snapshot",
      );
    const results = new Map<number, PreviewPrefix>();
    const p39Suffix = P39_MAINTENANCE_MIGRATIONS.filter(
      ({ id }) => id > startVersion && id <= 39,
    );
    let p39Blocked = false;
    if (p39Suffix.length > 0) {
      if (
        startVersion < 36 ||
        startVersion > 38 ||
        p39Suffix.length !== 39 - startVersion ||
        p39Suffix.some(({ id }, index) => id !== startVersion + index + 1)
      )
        throw new SchemaUpgradeRefusal(
          "preview rejected a non-canonical P39 migration prefix",
        );
      const walMode = database.prepare("PRAGMA journal_mode = WAL").get() as {
        journal_mode: string;
      };
      if (walMode.journal_mode.toLowerCase() !== "wal")
        throw new SchemaUpgradeRefusal(
          "private P39 preview could not enter WAL mode",
        );
      database.close();
      database = undefined;
      const reportPath = join(directory, "preview-report.sqlite");
      reserveNewFile(reportPath);
      try {
        await Effect.runPromise(
          runP39SqliteMaintenance({
            primaryFilename: previewPath,
            sidecarFilename: reportPath,
            protectedStoreFilenames: [],
          }),
        );
      } catch (cause) {
        let reports: ReturnType<typeof verifyP39ReportEvidence>;
        try {
          reports = verifyP39ReportEvidence(
            reportPath,
            existingPathIdentity(reportPath),
          );
        } catch {
          throw cause;
        }
        const fingerprint = sha256Hex(resolve(previewPath));
        p39Blocked = reports.some((report) => {
          try {
            return (
              (
                JSON.parse(report.reportJson) as {
                  databaseFingerprint?: string;
                }
              ).databaseFingerprint === fingerprint
            );
          } catch {
            return true;
          }
        });
        if (!p39Blocked) throw cause;
      }
      database = new DatabaseSync(previewPath);
      if (p39Blocked)
        return {
          prefixes: results,
          p39Blocked,
          sourceDigest,
          sourceVersion: startVersion,
        };
      const digest = logicalSqliteDigest(previewPath);
      results.set(39, {
        digest,
        signature: prefixSignatureForDigest(
          39,
          descriptorHashesThrough(39),
          digest,
        ),
      });
    }
    for (const version of [40, 41, 42]) {
      const current = readVersionWithOpenSource(database);
      if (current >= version) continue;
      if (current !== version - 1)
        throw new SchemaUpgradeRefusal(
          `private preview of ${version} requires version ${version - 1}, found ${current}`,
        );
      validateDescriptorPin(version);
      const descriptor = migrationDescriptorByVersion(version);
      if (
        descriptor === undefined ||
        descriptor.requiresUserVersion !== current
      )
        throw new SchemaUpgradeRefusal(
          `private preview ${version} descriptor precondition is invalid`,
        );
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of splitStatements(descriptor.sql))
          database.exec(statement);
        database.exec(`PRAGMA user_version = ${version}`);
        database.exec("COMMIT");
      } catch (cause) {
        try {
          database.exec("ROLLBACK");
        } catch {
          /* connection close rolls back */
        }
        throw cause;
      }
      const violations = database.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0)
        throw new SchemaUpgradeRefusal(
          `private preview ${version} failed foreign_key_check`,
        );
      const digest = logicalSqliteDigest(previewPath);
      results.set(version, {
        digest,
        signature: prefixSignatureForDigest(
          version,
          descriptorHashesThrough(version),
          digest,
        ),
      });
    }
    return {
      prefixes: results,
      p39Blocked,
      sourceDigest,
      sourceVersion: startVersion,
    };
  } finally {
    database?.close();
    const canonicalDirectory = realpathSync.native(directory);
    if (
      resolve(dirname(canonicalDirectory)).toLowerCase() !==
        resolve(dirname(targetPath)).toLowerCase() ||
      !basename(canonicalDirectory).startsWith(".arbor-schema-preview-")
    ) {
      // A mismatch means the generated private scratch path was replaced by
      // the trusted OS identity. Leave it untouched for operator review.
    } else {
      rmSync(canonicalDirectory, { recursive: true, force: false });
    }
  }
};

const appendPrepared = (
  manifest: SchemaUpgradeManifest,
  target: string,
  step: string,
  fromVersion: number,
  toVersion: number,
  descriptorHashes: ReadonlyArray<string>,
  expectedPostDigest: string,
  expectedPrefixSignature: string,
): SchemaUpgradeManifest => {
  const digest = logicalSqliteDigest(target);
  const tail = manifest.records.at(-1)?.record;
  if (tail?.kind === "Prepared") {
    if (
      tail.step === step &&
      Number(tail.fromVersion) === fromVersion &&
      Number(tail.toVersion) === toVersion &&
      canonicalJson(tail.descriptorHashes) ===
        canonicalJson(descriptorHashes) &&
      tail.sourceTargetDigest === digest &&
      tail.expectedPostDigest === expectedPostDigest &&
      tail.expectedPrefixSignature === expectedPrefixSignature
    )
      return manifest;
    throw new SchemaUpgradeRefusal(
      "a different prepared migration record is still unresolved",
    );
  }
  return appendSchemaUpgradeRecord(manifest, {
    kind: "Prepared",
    step,
    fromVersion,
    toVersion,
    descriptorHashes,
    sourceTargetDigest: digest,
    expectedPostDigest,
    expectedPrefixSignature,
  });
};

const appendCommitted = (
  manifest: SchemaUpgradeManifest,
  target: string,
  step: string,
  fromVersion: number,
  toVersion: number,
  descriptorHashes: ReadonlyArray<string>,
): SchemaUpgradeManifest => {
  if (readUserVersion(target) !== toVersion)
    throw new SchemaUpgradeRefusal(
      `migration ${step} committed an unexpected user_version`,
    );
  const foreignKeys = new DatabaseSync(target, { readOnly: true });
  try {
    const violations = foreignKeys.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0)
      throw new SchemaUpgradeRefusal(
        `migration ${step} produced foreign key violations`,
      );
  } finally {
    foreignKeys.close();
  }
  const targetDigest = logicalSqliteDigest(target);
  return appendSchemaUpgradeRecord(manifest, {
    kind: "Committed",
    step,
    fromVersion,
    toVersion,
    descriptorHashes,
    targetDigest,
    prefixSignature: prefixSignature(
      target,
      toVersion,
      descriptorHashesThrough(toVersion),
    ),
  });
};

const runP40ToP42 = (
  primary: Parameters<
    Parameters<typeof runP39SqliteMaintenanceWithPermit>[1]
  >[0],
  initialManifest: SchemaUpgradeManifest,
  targetPath: string,
  previews: ReadonlyMap<number, PreviewPrefix>,
  hooks: SchemaUpgradeTestHooks,
  source?: {
    readonly path: string;
    readonly identity: SchemaUpgradePathIdentity;
    readonly version: number;
    readonly digest: string;
  },
) =>
  Effect.gen(function* () {
    let manifest = initialManifest;
    const startingVersion = Number(
      (yield* primary.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      ))[0]?.user_version,
    );
    if (startingVersion < 39 || startingVersion > 42)
      throw new SchemaUpgradeRefusal(
        `P40–P42 suffix expected version 39–42, found ${startingVersion}`,
      );
    for (const version of [40, 41, 42]) {
      const currentRows = yield* primary.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      const current = Number(currentRows[0]?.user_version);
      if (current >= version) continue;
      if (current !== version - 1)
        throw new SchemaUpgradeRefusal(
          `migration ${version} requires user_version ${version - 1}, found ${current}`,
        );
      validateDescriptorPin(version);
      const descriptor = migrationDescriptorByVersion(version);
      if (
        descriptor === undefined ||
        descriptor.requiresUserVersion !== current
      )
        throw new SchemaUpgradeRefusal(
          `migration ${version} prefix precondition failed`,
        );
      const descriptorHash = pinnedDescriptorHash(version);
      const preview = previews.get(version);
      if (preview === undefined)
        throw new SchemaUpgradeRefusal(
          `migration ${version} lacks an exact preview prefix`,
        );
      manifest = appendPrepared(
        manifest,
        targetPath,
        `${String(version).padStart(4, "0")}`,
        current,
        version,
        [descriptorHash],
        preview.digest,
        preview.signature,
      );
      hooks.beforeDatabaseTransaction?.(version as 40 | 41 | 42);
      yield* primary.withTransaction(
        Effect.gen(function* () {
          const check = yield* primary.unsafe<{ user_version: number }>(
            "PRAGMA user_version",
          );
          if (Number(check[0]?.user_version) !== current)
            throw new SchemaUpgradeRefusal(
              `migration ${version} prefix changed before transaction`,
            );
          for (const statement of splitStatements(descriptor.sql))
            yield* primary.unsafe(statement);
          yield* primary.unsafe(`PRAGMA user_version = ${version}`);
        }),
      );
      hooks.afterDatabaseCommit?.(version as 40 | 41 | 42);
      if (
        logicalSqliteDigest(targetPath) !== preview.digest ||
        prefixSignature(
          targetPath,
          version,
          descriptorHashesThrough(version),
        ) !== preview.signature
      ) {
        throw new SchemaUpgradeRefusal(
          `migration ${version} result differs from its prepared logical digest/schema prefix`,
        );
      }
      manifest = appendCommitted(
        manifest,
        targetPath,
        `${String(version).padStart(4, "0")}`,
        current,
        version,
        [descriptorHash],
      );
      if (source !== undefined) {
        assertSourceUnchanged(source);
      }
    }
    const finalVersion = Number(
      (yield* primary.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      ))[0]?.user_version,
    );
    if (finalVersion !== 42)
      throw new SchemaUpgradeRefusal(
        `schema upgrade ended at ${finalVersion}, expected 42`,
      );
    const violations = yield* primary.unsafe("PRAGMA foreign_key_check");
    if (violations.length > 0)
      throw new SchemaUpgradeRefusal(
        "schema version 42 failed foreign_key_check",
      );
    const projectColumns = yield* primary.unsafe<{
      name: string;
      notnull: number;
    }>("PRAGMA table_info(projects)");
    if (
      !projectColumns.some(
        ({ name, notnull }) =>
          name === "resource_source_json" && Number(notnull) === 1,
      )
    ) {
      throw new SchemaUpgradeRefusal(
        "P42 resource_source_json NOT NULL contract is missing",
      );
    }
    const legacyUnknown = yield* primary.unsafe<{ count: number }>(
      'SELECT COUNT(*) AS count FROM projects WHERE resource_source_json = \'{"_tag":"LegacyUnknown"}\'',
    );
    const projectCount = yield* primary.unsafe<{ count: number }>(
      "SELECT COUNT(*) AS count FROM projects",
    );
    if (Number(legacyUnknown[0]?.count) !== Number(projectCount[0]?.count)) {
      throw new SchemaUpgradeRefusal(
        "P42 did not explicitly attribute every project as LegacyUnknown",
      );
    }
    const finalDigest = logicalSqliteDigest(targetPath);
    if (finalDigest.length !== 64)
      throw new SchemaUpgradeRefusal("version 42 logical digest is invalid");
    if (source !== undefined) assertSourceUnchanged(source);
    if (finalVersion === 42 && manifestStepState(manifest).version < 42) {
      throw new SchemaUpgradeRefusal(
        "version 42 target lacks its final committed provenance record",
      );
    }
    return manifest;
  });

const runP39AndSuffix = async (
  targetPath: string,
  reportPath: string,
  prepareUnderPermit: () => Promise<{
    readonly manifest: SchemaUpgradeManifest;
    readonly source?: {
      readonly path: string;
      readonly identity: SchemaUpgradePathIdentity;
      readonly version: number;
      readonly digest: string;
    };
  }>,
  hooks: SchemaUpgradeTestHooks = {},
  reportMustAlreadyExist = false,
): Promise<void> => {
  const previewVersion = readUserVersion(targetPath);
  let previews: PreviewPlan;
  try {
    previews =
      hooks.previewTemplate ??
      (previewVersion === 42
        ? {
            prefixes: new Map(),
            p39Blocked: false,
            sourceDigest: logicalSqliteDigest(targetPath),
            sourceVersion: previewVersion,
          }
        : await previewCommittedPrefixes(targetPath));
    if (hooks.previewTemplate !== undefined) {
      const currentDigest = logicalSqliteDigest(targetPath);
      const expectedDigest =
        previewVersion === previews.sourceVersion
          ? previews.sourceDigest
          : previews.prefixes.get(previewVersion)?.digest;
      if (expectedDigest === undefined || currentDigest !== expectedDigest)
        throw new SchemaUpgradeRefusal(
          "target content differs from the offline preview template digest",
        );
      if (previewVersion !== previews.sourceVersion) {
        const expected = previews.prefixes.get(previewVersion);
        if (
          expected === undefined ||
          prefixSignature(
            targetPath,
            previewVersion,
            descriptorHashesThrough(previewVersion),
          ) !== expected.signature
        ) {
          throw new SchemaUpgradeRefusal(
            "target prefix differs from the offline preview template signature",
          );
        }
      }
    }
    hooks.onPreviewTemplate?.(previews);
  } catch (cause) {
    hooks.onMaintenanceFailure?.("schema-prefix-preview", cause);
    throw cause;
  }
  const p39Hashes = P39_MAINTENANCE_MIGRATIONS.filter(
    ({ id }) => id > previewVersion && id <= 39,
  ).map(({ id }) => {
    validateDescriptorPin(id);
    return pinnedDescriptorHash(id);
  });
  if (previewVersion > 42) {
    throw new SchemaUpgradeRefusal(
      `offline schema version ${previewVersion} is unsupported`,
    );
  }
  let prepared: SchemaUpgradeManifest | undefined;
  let source:
    | {
        readonly path: string;
        readonly identity: SchemaUpgradePathIdentity;
        readonly version: number;
        readonly digest: string;
      }
    | undefined;
  let versionAtPermit: number | undefined;
  let skipP39 = false;
  let isolationReportKey: string | undefined;
  let failurePhase: SchemaUpgradeMaintenancePhase =
    "writer-lock-initialization";
  const stepId = "p39-0037-0039";
  try {
    await Effect.runPromise(
      runP39SqliteMaintenanceWithPermit(
        {
          primaryFilename: targetPath,
          sidecarFilename: reportPath,
          protectedStoreFilenames: protectedApplicationDatabases(),
          writerLockBusyTimeoutMs: CLI_MAINTENANCE_PERMIT_BUSY_TIMEOUT_MS,
        },
        (primary) => {
          if (prepared === undefined || versionAtPermit === undefined) {
            throw new SchemaUpgradeRefusal(
              "manifest preparation did not complete under MaintenanceExclusive",
            );
          }
          if (!skipP39) {
            const preview = previews.prefixes.get(39);
            if (preview === undefined)
              throw new SchemaUpgradeRefusal(
                "P39 preview disappeared before commit",
              );
            if (source !== undefined) assertSourceUnchanged(source);
            hooks.afterDatabaseCommit?.(39);
            if (
              logicalSqliteDigest(targetPath) !== preview.digest ||
              prefixSignature(targetPath, 39, descriptorHashesThrough(39)) !==
                preview.signature
            ) {
              throw new SchemaUpgradeRefusal(
                "P39 target differs from the exact prepared prefix digest/schema signature",
              );
            }
            prepared = appendCommitted(
              prepared,
              targetPath,
              stepId,
              versionAtPermit,
              39,
              p39Hashes,
            );
          }
          return runP40ToP42(
            primary,
            prepared,
            targetPath,
            previews.prefixes,
            hooks,
            source,
          ).pipe(
            Effect.tap((nextManifest) =>
              Effect.sync(() => {
                prepared = nextManifest;
              }),
            ),
            Effect.asVoid,
          );
        },
        {
          reportMustAlreadyExist,
          onPhase: (phase) => {
            failurePhase = phase;
            if (phase === "writer-lock-acquisition") {
              hooks.beforeMaintenancePermitAcquire?.();
            }
          },
          afterPrimaryClosedNoOp: () =>
            Effect.promise(async () => {
              if (prepared === undefined) {
                throw new SchemaUpgradeRefusal(
                  "version 42 no-op has no validated provenance manifest",
                );
              }
              const expectedIdentity = prepared.header.target;
              if (
                !sameIdentity(
                  existingPathIdentity(targetPath),
                  expectedIdentity,
                )
              ) {
                throw new SchemaUpgradeRefusal(
                  "version 42 target identity changed after its primary connection closed",
                );
              }
              const expectedReportIdentity = prepared.header.report;
              if (
                !sameIdentity(
                  existingPathIdentity(reportPath),
                  expectedReportIdentity,
                )
              ) {
                throw new SchemaUpgradeRefusal(
                  "version 42 report identity differs from the manifest",
                );
              }
              verifyP39ReportEvidence(reportPath, expectedReportIdentity);
              if (source !== undefined) assertSourceUnchanged(source);
              const state = manifestStepState(prepared);
              const readOnly = new DatabaseSync(targetPath, {
                readOnly: true,
                enableForeignKeyConstraints: false,
              });
              let version: number;
              try {
                readOnly.exec("PRAGMA query_only = ON");
                version = Number(
                  (
                    readOnly.prepare("PRAGMA user_version").get() as {
                      user_version: number;
                    }
                  ).user_version,
                );
                const violations = readOnly
                  .prepare("PRAGMA foreign_key_check")
                  .all();
                if (violations.length > 0) {
                  throw new SchemaUpgradeRefusal(
                    "version 42 no-op target failed foreign_key_check",
                  );
                }
                const projectColumns = readOnly
                  .prepare("PRAGMA table_info(projects)")
                  .all() as Array<{ name: string; notnull: number }>;
                if (
                  !projectColumns.some(
                    ({ name, notnull }) =>
                      name === "resource_source_json" && Number(notnull) === 1,
                  )
                ) {
                  throw new SchemaUpgradeRefusal(
                    "version 42 no-op target lacks required resource provenance",
                  );
                }
                const legacyUnknown = Number(
                  (
                    readOnly
                      .prepare(
                        `SELECT COUNT(*) AS count FROM projects WHERE resource_source_json = '{"_tag":"LegacyUnknown"}'`,
                      )
                      .get() as { count: number }
                  ).count,
                );
                const projects = Number(
                  (
                    readOnly
                      .prepare("SELECT COUNT(*) AS count FROM projects")
                      .get() as { count: number }
                  ).count,
                );
                if (legacyUnknown !== projects) {
                  throw new SchemaUpgradeRefusal(
                    "version 42 no-op target lacks complete legacy provenance attribution",
                  );
                }
              } finally {
                readOnly.close();
              }
              const digest = logicalSqliteDigest(targetPath);
              const signature = prefixSignatureForDigest(
                42,
                descriptorHashesThrough(42),
                digest,
              );
              if (
                version !== 42 ||
                state.version !== 42 ||
                state.pending !== undefined ||
                state.isolated ||
                digest !== state.lastDigest ||
                signature !== state.lastPrefixSignature
              ) {
                throw new SchemaUpgradeRefusal(
                  "read-only reopened target is not the exact committed version 42 manifest head",
                );
              }
              hooks.afterVersion42NoOpVerification?.({
                userVersion: 42,
                reopenedReadOnly: true,
              });
            }),
          beforeMaintenance: () =>
            Effect.promise(async () => {
              failurePhase = "manifest-validation";
              const context = await prepareUnderPermit();
              prepared = context.manifest;
              source = context.source;
              versionAtPermit = readUserVersion(targetPath);
              const digestAtPermit = logicalSqliteDigest(targetPath);
              const progress = manifestStepState(prepared);
              if (
                progress.isolated ||
                versionAtPermit !== progress.version ||
                digestAtPermit !== progress.lastDigest
              ) {
                throw new SchemaUpgradeRefusal(
                  "target prefix differs from its validated manifest head under MaintenanceExclusive",
                );
              }
              const expectedStartingDigest =
                previewVersion === previews.sourceVersion
                  ? previews.sourceDigest
                  : previews.prefixes.get(previewVersion)?.digest;
              if (
                versionAtPermit === previewVersion &&
                digestAtPermit !== expectedStartingDigest
              ) {
                throw new SchemaUpgradeRefusal(
                  "target logical digest changed while waiting for MaintenanceExclusive",
                );
              }
              skipP39 = versionAtPermit >= 39;
              return skipP39;
            }),
          ...(previewVersion >= 39
            ? {}
            : {
                beforeP39: () =>
                  Effect.sync(() => {
                    if (
                      prepared === undefined ||
                      versionAtPermit !== previewVersion ||
                      logicalSqliteDigest(targetPath) !== previews.sourceDigest
                    )
                      throw new SchemaUpgradeRefusal(
                        "target prefix/manifest changed before P39 preparation",
                      );
                    const preview = previews.prefixes.get(39) ?? {
                      digest: previews.sourceDigest,
                      signature: prefixSignatureForDigest(
                        39,
                        descriptorHashesThrough(39),
                        previews.sourceDigest,
                      ),
                    };
                    prepared = appendPrepared(
                      prepared,
                      targetPath,
                      stepId,
                      previewVersion,
                      39,
                      p39Hashes,
                      preview.digest,
                      preview.signature,
                    );
                    hooks.beforeDatabaseTransaction?.(39);
                  }),
              }),
          ...(previewVersion >= 39
            ? {}
            : {
                onP39Blocked: () =>
                  Effect.sync(() => {
                    if (prepared === undefined) {
                      throw new SchemaUpgradeRefusal(
                        "P39 blocker has no prepared provenance record",
                      );
                    }
                    const reportIdentity = existingPathIdentity(reportPath);
                    const reports = verifyP39ReportEvidence(
                      reportPath,
                      reportIdentity,
                    );
                    const fingerprint = sha256Hex(resolve(targetPath));
                    const blocker = reports.find((report) => {
                      try {
                        return (
                          (
                            JSON.parse(report.reportJson) as {
                              databaseFingerprint?: string;
                            }
                          ).databaseFingerprint === fingerprint
                        );
                      } catch {
                        return false;
                      }
                    });
                    if (blocker === undefined) {
                      throw new SchemaUpgradeRefusal(
                        "P39 returned isolation without a matching durable report",
                      );
                    }
                    appendSchemaUpgradeRecord(prepared, {
                      kind: "Isolated",
                      step: stepId,
                      observedUserVersion: readUserVersion(targetPath),
                      reportKey: blocker.reportKey,
                      reportContentHash: blocker.contentHash,
                      target: existingPathIdentity(targetPath),
                    });
                    isolationReportKey = blocker.reportKey;
                  }),
              }),
        },
      ),
    );
  } catch (cause) {
    hooks.onMaintenanceFailure?.(failurePhase, cause);
    if (source !== undefined) assertSourceUnchanged(source);
    const p39Failure = findP39FailureCode(cause);
    if (isolationReportKey !== undefined) {
      if (p39Failure?.code === "P39_WRITER_LOCK_RELEASE_FAILED") {
        throw new SchemaUpgradeRefusal(
          "P39 maintenance permit release failed",
          { phase: failurePhase, code: p39Failure.code },
        );
      }
      throw new SchemaUpgradeRefusal(
        `P39 permanently isolated this disposable target (report ${isolationReportKey})`,
        {
          phase: failurePhase,
          code: "P39_LEGACY_DB_ISOLATED",
          ...(p39Failure?.code === undefined
            ? {}
            : { reasonCode: p39Failure.code }),
        },
      );
    }
    if (p39Failure !== undefined) {
      throw new SchemaUpgradeRefusal(
        `P39 maintenance failed (${p39Failure.code})`,
        {
          phase: failurePhase,
          code: p39Failure.code,
          ...(p39Failure.reasonCode === undefined
            ? {}
            : { reasonCode: p39Failure.reasonCode }),
        },
      );
    }
    throw cause;
  }
  if (prepared === undefined) {
    throw new SchemaUpgradeRefusal(
      "schema upgrade completed without provenance evidence",
    );
  }
  return;
};

export const runSchemaUpgrade = async (
  args: SchemaUpgradeArguments,
  testHooks: SchemaUpgradeTestHooks = {},
): Promise<void> => {
  const paths = validatePathSet(args);
  if (args.mode === "resume-copy") {
    await runP39AndSuffix(
      paths.targetPath,
      paths.reportPath,
      async () => {
        const resumed = await validateResume(args, paths);
        return {
          manifest: resumed.manifest,
          source: {
            path: resumed.source.canonicalPath,
            identity: resumed.source,
            version: Number(resumed.manifest.header.sourceUserVersion),
            digest: String(resumed.manifest.header.sourceDigest),
          },
        };
      },
      testHooks,
      true,
    );
    return;
  }

  const created = await createOrCopyTarget(args, paths);
  await runP39AndSuffix(
    created.target.canonicalPath,
    created.report.canonicalPath,
    async () => {
      let manifest = createInitialManifest(args, created);
      if (args.mode === "copy") {
        const source = created.source;
        if (
          source === null ||
          created.sourceVersion === null ||
          created.sourceDigest === null
        ) {
          throw new SchemaUpgradeRefusal(
            "copy source evidence was not captured",
          );
        }
        manifest = appendSchemaUpgradeRecord(manifest, {
          kind: "BackupCompleted",
          sourceDigest: created.sourceDigest,
          targetDigest: logicalSqliteDigest(created.target.canonicalPath),
          source: created.source,
          target: created.target,
        });
      }
      const source =
        created.source === null ||
        created.sourceVersion === null ||
        created.sourceDigest === null
          ? undefined
          : {
              path: created.source.canonicalPath,
              identity: created.source,
              version: created.sourceVersion,
              digest: created.sourceDigest,
            };
      return { manifest, ...(source === undefined ? {} : { source }) };
    },
    testHooks,
  );
};

const main = async (): Promise<void> => {
  if (
    process.argv
      .slice(2)
      .some((argument) => argument === "--help" || argument === "-h")
  ) {
    process.stdout.write(`${schemaUpgradeUsage()}\n`);
    return;
  }
  try {
    const args = parseSchemaUpgradeArguments(process.argv.slice(2));
    await runSchemaUpgrade(args);
    process.stdout.write("Schema upgrade completed at version 42.\n");
  } catch (cause) {
    const detail = formatSchemaUpgradeCliFailure(cause);
    process.stderr.write(`Schema upgrade refused or failed: ${detail}\n`);
    process.exitCode = 1;
  }
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  void main();
}
