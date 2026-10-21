import { copyFileSync, existsSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Cause, Effect, Exit, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  CURRENT_SCHEMA_VERSION,
  P32_MIGRATIONS,
  P38_MIGRATIONS,
  P43_MIGRATION,
  P44_APPROVAL_REJECTED_NO_EFFECT_DENIAL_MIGRATION,
  P45_RETRY_VERIFICATION_ORIGIN_MIGRATION,
  P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION,
  P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION,
  P48_AH19_CONVERSATION_CHECKPOINT_OWNER_MIGRATION,
  P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_MIGRATION,
  P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_MIGRATION,
  P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_MIGRATION,
  preflightVerificationEvidenceSnapshot,
  runMigrations,
  runP39SqliteMaintenance,
  splitStatements,
  layer as sqliteLayer,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  createP39PrivateTestFile,
  removeP39PrivateTestDirectory,
  setP39PrivateWindowsAcl,
} from "./p39-windows-deployment-test.js";
import { HISTORICAL_SCHEMA42_SUFFIX_MIGRATIONS } from "./schema-prefix-contract.js";

export class Schema42TestDatabaseSetupError extends Error {
  readonly code: "P39_UNSUPPORTED_DEPLOYMENT" | "SCHEMA42_SETUP_FAILED";
  readonly databaseVersionAtFailure: number | undefined;

  constructor(
    code: Schema42TestDatabaseSetupError["code"],
    message: string,
    databaseVersionAtFailure?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "Schema42TestDatabaseSetupError";
    this.code = code;
    this.databaseVersionAtFailure = databaseVersionAtFailure;
  }
}

export interface Schema42TestDatabase {
  readonly directory: string;
  readonly databaseFilename: string;
  readonly p39ReportFilename: string;
  readonly cleanup: () => void;
}

export interface Schema42TestDatabaseOptions {
  /** Seeds test-owned legacy rows after the real P38 prefix and before P39. */
  readonly seedP38?: (databaseFilename: string) => Promise<void>;
  readonly prefix?: string;
  /** Optional private parent used by invocation-wide functional templates. */
  readonly parentDirectory?: string;
  /** Internal target selector for a current schema-44 runtime fixture. */
  readonly targetSchemaVersion?: 42 | 44 | 45 | 46 | 47 | 48 | 50 | 51;
}

export interface Schema42TestDatabaseFactory {
  /** Copies the closed trusted template into a new, independent SQLite file. */
  readonly create: () => Schema42TestDatabase;
  /** Removes the trusted template after all clones have been cleaned up. */
  readonly cleanup: () => void;
}

export type Schema44TestDatabase = Schema42TestDatabase;
export type Schema44TestDatabaseOptions = Schema42TestDatabaseOptions;
export type Schema44TestDatabaseFactory = Schema42TestDatabaseFactory;
export type Schema45TestDatabase = Schema42TestDatabase;
export type Schema45TestDatabaseOptions = Schema42TestDatabaseOptions;
export type Schema45TestDatabaseFactory = Schema42TestDatabaseFactory;
export type Schema46TestDatabase = Schema42TestDatabase;
export type Schema46TestDatabaseOptions = Schema42TestDatabaseOptions;
export type Schema46TestDatabaseFactory = Schema42TestDatabaseFactory;
export type Schema47TestDatabase = Schema42TestDatabase;
export type Schema47TestDatabaseOptions = Schema42TestDatabaseOptions;
export type Schema47TestDatabaseFactory = Schema42TestDatabaseFactory;
export type Schema48TestDatabase = Schema42TestDatabase;
export type Schema48TestDatabaseOptions = Schema42TestDatabaseOptions;
export type Schema48TestDatabaseFactory = Schema42TestDatabaseFactory;
export type Schema50TestDatabase = Schema42TestDatabase;
export type Schema50TestDatabaseOptions = Schema42TestDatabaseOptions;
export type Schema50TestDatabaseFactory = Schema42TestDatabaseFactory;
export type Schema51TestDatabase = Schema42TestDatabase;
export type Schema51TestDatabaseOptions = Schema42TestDatabaseOptions;
export type Schema51TestDatabaseFactory = Schema42TestDatabaseFactory;
export type CurrentSchemaTestDatabase = Schema42TestDatabase;
export type CurrentSchemaTestDatabaseOptions = Omit<
  Schema42TestDatabaseOptions,
  "targetSchemaVersion"
>;
export type CurrentSchemaTestDatabaseFactory = Schema42TestDatabaseFactory;

const upgradeSchema44Suffix = async (
  databaseFilename: string,
): Promise<void> => {
  await runPrimary(
    databaseFilename,
    Effect.gen(function* () {
      yield* runMigrations([
        P43_MIGRATION,
        P44_APPROVAL_REJECTED_NO_EFFECT_DENIAL_MIGRATION,
      ]);
    }),
  );
  const version = await readUserVersion(databaseFilename);
  if (version !== 44) {
    throw new Schema42TestDatabaseSetupError(
      "SCHEMA42_SETUP_FAILED",
      `Schema-44 offline upgrade ended at user_version ${version}, expected 44.`,
      version,
    );
  }
  await checkpointSqlite(databaseFilename);
};

export const upgradeSchema44TestDatabase = async (input: {
  readonly databaseFilename: string;
  readonly p39ReportFilename: string;
}): Promise<void> => {
  await upgradeSchema42TestDatabase(input);
  await upgradeSchema44Suffix(input.databaseFilename);
};

const upgradeSchema45Suffix = async (
  databaseFilename: string,
): Promise<void> => {
  await runPrimary(
    databaseFilename,
    Effect.gen(function* () {
      yield* runMigrations([P45_RETRY_VERIFICATION_ORIGIN_MIGRATION], {
        allowOfflineOnly: true,
      });
    }),
  );
  const version = await readUserVersion(databaseFilename);
  if (version !== 45) {
    throw new Schema42TestDatabaseSetupError(
      "SCHEMA42_SETUP_FAILED",
      `Schema-45 disposable fixture upgrade ended at user_version ${version}, expected 45.`,
      version,
    );
  }
  await checkpointSqlite(databaseFilename);
};

const upgradeSchema46Suffix = async (
  databaseFilename: string,
): Promise<void> => {
  const database = new DatabaseSync(databaseFilename);
  try {
    database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    const version = Number(
      (
        database.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    );
    if (version !== 45)
      throw new Error(`Schema-46 migration requires 45, found ${version}.`);
    preflightVerificationEvidenceSnapshot(database);
    for (const statement of splitStatements(
      P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION.sql,
    ))
      database.exec(statement);
    database.exec("PRAGMA user_version = 46");
    if (database.prepare("PRAGMA foreign_key_check").all().length > 0)
      throw new Error("Schema-46 migration produced foreign-key violations.");
    database.exec("COMMIT");
  } catch (cause) {
    try {
      if (database.isTransaction) database.exec("ROLLBACK");
    } catch {
      // Closing the connection also rolls back an interrupted transaction.
    }
    throw cause;
  } finally {
    database.close();
  }
  if ((await readUserVersion(databaseFilename)) !== 46)
    throw new Error("Schema-46 fixture did not reach user_version 46.");
  await checkpointSqlite(databaseFilename);
};

const upgradeSchema47Suffix = async (
  databaseFilename: string,
): Promise<void> => {
  await runPrimary(
    databaseFilename,
    Effect.gen(function* () {
      yield* runMigrations([P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION], {
        allowOfflineOnly: true,
      });
    }),
  );
  const version = await readUserVersion(databaseFilename);
  if (version !== 47) {
    throw new Schema42TestDatabaseSetupError(
      "SCHEMA42_SETUP_FAILED",
      `Schema-47 disposable fixture upgrade ended at user_version ${version}, expected 47.`,
      version,
    );
  }
  await checkpointSqlite(databaseFilename);
};

const upgradeSchema48Suffix = async (
  databaseFilename: string,
): Promise<void> => {
  await runPrimary(
    databaseFilename,
    Effect.gen(function* () {
      yield* runMigrations([P48_AH19_CONVERSATION_CHECKPOINT_OWNER_MIGRATION], {
        allowOfflineOnly: true,
      });
    }),
  );
  const version = await readUserVersion(databaseFilename);
  if (version !== 48) {
    throw new Schema42TestDatabaseSetupError(
      "SCHEMA42_SETUP_FAILED",
      `Schema-48 disposable fixture upgrade ended at user_version ${version}, expected 48.`,
      version,
    );
  }
  await checkpointSqlite(databaseFilename);
};

const upgradeSchema50Suffix = async (
  databaseFilename: string,
): Promise<void> => {
  await runPrimary(
    databaseFilename,
    Effect.gen(function* () {
      yield* runMigrations(
        [
          P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_MIGRATION,
          P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_MIGRATION,
        ],
        { allowOfflineOnly: true },
      );
    }),
  );
  const version = await readUserVersion(databaseFilename);
  if (version !== 50) {
    throw new Schema42TestDatabaseSetupError(
      "SCHEMA42_SETUP_FAILED",
      `Schema-50 disposable fixture upgrade ended at user_version ${version}, expected 50.`,
      version,
    );
  }
  await checkpointSqlite(databaseFilename);
};

const upgradeSchema51Suffix = async (
  databaseFilename: string,
): Promise<void> => {
  await runPrimary(
    databaseFilename,
    Effect.gen(function* () {
      yield* runMigrations(
        [P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_MIGRATION],
        { allowOfflineOnly: true },
      );
    }),
  );
  const version = await readUserVersion(databaseFilename);
  if (version !== 51) {
    throw new Schema42TestDatabaseSetupError(
      "SCHEMA42_SETUP_FAILED",
      `Schema-51 disposable fixture upgrade ended at user_version ${version}, expected 51.`,
      version,
    );
  }
  await checkpointSqlite(databaseFilename);
};

/** Creates a directory whose path remains owned while P39 ACL setup runs. */
export const createSchema42PrivateTestDirectory = (
  parent: string,
  prefix: string,
  setPrivateDirectoryAcl: (directory: string) => void = (directory) =>
    setP39PrivateWindowsAcl(directory, "directory"),
  removeDirectory: (directory: string) => void = removeP39PrivateTestDirectory,
): string => {
  const directory = mkdtempSync(join(parent, prefix));
  try {
    setPrivateDirectoryAcl(directory);
    return directory;
  } catch (cause) {
    try {
      removeDirectory(directory);
    } catch (cleanupCause) {
      throw new AggregateError(
        [cause, cleanupCause],
        "Schema-42 private test directory setup and cleanup both failed.",
      );
    }
    throw cause;
  }
};

const runPrimary = <A>(
  filename: string,
  effect: Effect.Effect<A, unknown, SqlClient>,
) =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(effect, sqliteLayer({ filename }))),
  );

const readUserVersion = (filename: string) =>
  runPrimary(
    filename,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      return Number(rows[0]?.user_version ?? 0);
    }),
  );

const checkpointSqlite = (filename: string) =>
  runPrimary(
    filename,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{ busy: number }>(
        "PRAGMA wal_checkpoint(TRUNCATE)",
      );
      if (Number(rows[0]?.busy ?? 0) !== 0) {
        throw new Error("SQLite WAL checkpoint remained busy.");
      }
    }),
  );

const quoteSqliteIdentifier = (identifier: string) =>
  `"${identifier.replaceAll('"', '""')}"`;

/** Creates an exact P32 schema from its accepted migration prefix and carries
 * forward only rows/columns that exist in both images. This is for disposable
 * historical qualification fixtures; it never reverse-edits a newer schema
 * or rewrites user_version. */
export const createP32HistoricalTestImage = async (input: {
  readonly sourceFilename: string;
  readonly targetFilename: string;
}): Promise<void> => {
  const source = new DatabaseSync(input.sourceFilename, { readOnly: true });
  try {
    const version = Number(
      (
        source.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    );
    if (version !== 42) {
      throw new Schema42TestDatabaseSetupError(
        "SCHEMA42_SETUP_FAILED",
        `Historical P32 seed source is schema ${version}; expected the schema-42 production fixture.`,
        version,
      );
    }
  } finally {
    source.close();
  }

  await runPrimary(
    input.targetFilename,
    Effect.gen(function* () {
      yield* runMigrations(P32_MIGRATIONS);
    }),
  );

  const target = new DatabaseSync(input.targetFilename);
  try {
    target.exec("PRAGMA foreign_keys = OFF");
    target
      .prepare("ATTACH DATABASE ? AS historical_source")
      .run(input.sourceFilename);
    const tables = target
      .prepare(
        `SELECT name FROM main.sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const quotedName = quoteSqliteIdentifier(name);
      const targetColumns = target
        .prepare(`PRAGMA main.table_info(${quotedName})`)
        .all() as Array<{ name: string }>;
      const sourceColumns = target
        .prepare(`PRAGMA historical_source.table_info(${quotedName})`)
        .all() as Array<{ name: string }>;
      const sourceColumnNames = new Set(sourceColumns.map(({ name }) => name));
      const commonColumns = targetColumns
        .map(({ name }) => name)
        .filter((column) => sourceColumnNames.has(column));
      if (commonColumns.length === 0) continue;
      const columnList = commonColumns.map(quoteSqliteIdentifier).join(", ");
      target.exec(
        `INSERT INTO main.${quotedName} (${columnList})
          SELECT ${columnList} FROM historical_source.${quotedName}`,
      );
    }
    target.exec("DETACH DATABASE historical_source");
  } finally {
    target.close();
  }

  const copiedVersion = await readUserVersion(input.targetFilename);
  if (copiedVersion !== 32) {
    throw new Schema42TestDatabaseSetupError(
      "SCHEMA42_SETUP_FAILED",
      `Historical P32 migration prefix ended at user_version ${copiedVersion}; expected 32.`,
      copiedVersion,
    );
  }
};

/**
 * Seed an owned P38 database with the common rows from a current schema-44
 * snapshot before the explicit P39/P40/P41/P42 builder reconstructs a real
 * schema-42 image. Ordinary entities use strict INSERT semantics so duplicate
 * identities fail closed. Only the migration-created P10 singleton is
 * replaced, and only by an exact UPDATE of its existing singleton key.
 */
export const copySchema44RowsIntoP38Seed = async (
  sourceFilename: string,
  targetFilename: string,
): Promise<void> => {
  const source = new DatabaseSync(sourceFilename, { readOnly: true });
  const target = new DatabaseSync(targetFilename);
  try {
    const sourceVersion = Number(
      (
        source.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    );
    const targetVersion = Number(
      (
        target.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    );
    if (sourceVersion !== 44 || targetVersion !== 38) {
      throw new Error(
        `Schema snapshot copy requires current source v44 and P38 target v38; got ${sourceVersion} and ${targetVersion}`,
      );
    }

    const sourceTables = new Set(
      (
        source
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .all() as Array<{ name: string }>
      ).map((table) => table.name),
    );
    const targetTables = target
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    target.exec("PRAGMA foreign_keys = OFF");
    target.exec("BEGIN IMMEDIATE");
    try {
      for (const { name } of targetTables) {
        if (!sourceTables.has(name)) continue;
        const columns = target
          .prepare(`PRAGMA table_info(${JSON.stringify(name)})`)
          .all() as Array<{ name: string }>;
        const sourceColumns = new Set(
          (
            source
              .prepare(`PRAGMA table_info(${JSON.stringify(name)})`)
              .all() as Array<{ name: string }>
          ).map((column) => column.name),
        );
        const commonColumns = columns
          .map((column) => column.name)
          .filter((column) => sourceColumns.has(column));
        if (commonColumns.length === 0) continue;
        const quotedTable = `"${name.replaceAll('"', '""')}"`;
        const quotedColumns = commonColumns
          .map((column) => `"${column.replaceAll('"', '""')}"`)
          .join(", ");
        const rows = source
          .prepare(`SELECT ${quotedColumns} FROM ${quotedTable}`)
          .all() as Array<Record<string, unknown>>;
        if (rows.length === 0) continue;
        const placeholders = commonColumns.map(() => "?").join(", ");

        if (name === "p10_attention_dispatch_state") {
          if (
            commonColumns.includes("singleton") === false ||
            rows.length !== 1 ||
            rows[0]?.singleton !== 1
          ) {
            throw new Error(
              "P10 dispatch state copy requires exactly singleton key 1",
            );
          }
          const existing = target
            .prepare("SELECT singleton FROM p10_attention_dispatch_state")
            .all() as Array<{ singleton: number }>;
          if (existing.length !== 1 || existing[0]?.singleton !== 1) {
            throw new Error(
              "P38 seed does not have exactly the expected P10 singleton row",
            );
          }
          const mutableColumns = commonColumns.filter(
            (column) => column !== "singleton",
          );
          const mutableValues = mutableColumns.map(
            (column) => rows[0]?.[column],
          );
          const update = target.prepare(
            `UPDATE ${quotedTable} SET ${mutableColumns
              .map((column) => `"${column.replaceAll('"', '""')}" = ?`)
              .join(", ")} WHERE "singleton" = ?`,
          );
          const changed = update.run(
            ...(mutableValues as Parameters<typeof update.run>),
            1,
          );
          if (Number(changed.changes) !== 1) {
            throw new Error(
              "P10 singleton UPDATE did not target exactly one row",
            );
          }
          continue;
        }

        const insert = target.prepare(
          `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES (${placeholders})`,
        );
        for (const row of rows) {
          insert.run(
            ...(commonColumns.map((column) => row[column]) as Parameters<
              typeof insert.run
            >),
          );
        }
      }
      target.exec("COMMIT");
    } catch (error) {
      target.exec("ROLLBACK");
      throw error;
    }
    const violations = target
      .prepare("PRAGMA foreign_key_check")
      .all() as Array<Record<string, unknown>>;
    if (violations.length > 0) {
      throw new Error(
        `Schema snapshot copy produced foreign-key violations: ${JSON.stringify(violations.slice(0, 8))}`,
      );
    }
  } finally {
    target.close();
    source.close();
  }
};

/** Builds a pristine P32 migration-prefix database for exact schema checks. */
export const createP32MigrationBaseline = async (
  filename: string,
): Promise<void> => {
  await runPrimary(
    filename,
    Effect.gen(function* () {
      yield* runMigrations(P32_MIGRATIONS);
    }),
  );
};

const failureValue = (exit: Exit.Failure<unknown, unknown>) =>
  Option.getOrNull(Cause.findErrorOption(exit.cause));

const isUnsupportedP39Deployment = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  "code" in value &&
  value.code === "P39_UNSUPPORTED_DEPLOYMENT";

/** Offline-upgrades an owned, disposable historical image to the exact
 * production schema-42 shape. P39 remains a separate maintenance step; this
 * helper never changes user_version directly or runs from the daemon. */
export const upgradeSchema42TestDatabase = async (input: {
  readonly databaseFilename: string;
  readonly p39ReportFilename: string;
}): Promise<void> => {
  await runPrimary(
    input.databaseFilename,
    Effect.gen(function* () {
      yield* runMigrations(P38_MIGRATIONS);
    }),
  );
  const version38 = await readUserVersion(input.databaseFilename);
  if (version38 !== 38) {
    throw new Schema42TestDatabaseSetupError(
      "SCHEMA42_SETUP_FAILED",
      `Schema-42 offline upgrade prefix ended at user_version ${version38}; expected 38.`,
      version38,
    );
  }

  const p39 = await Effect.runPromiseExit(
    runP39SqliteMaintenance({
      primaryFilename: input.databaseFilename,
      sidecarFilename: input.p39ReportFilename,
      protectedStoreFilenames: [],
    }),
  );
  if (Exit.isFailure(p39)) {
    const reason = failureValue(p39);
    if (isUnsupportedP39Deployment(reason)) {
      throw new Schema42TestDatabaseSetupError(
        "P39_UNSUPPORTED_DEPLOYMENT",
        `P39 maintenance is unsupported for this test environment; the disposable database remains at schema 38 and schema 42 was not fabricated.`,
        38,
        { cause: Cause.squash(p39.cause) },
      );
    }
    throw Cause.squash(p39.cause);
  }
  if (!existsSync(input.p39ReportFilename)) {
    throw new Schema42TestDatabaseSetupError(
      "SCHEMA42_SETUP_FAILED",
      "P39 maintenance completed without creating its separate report database.",
      39,
    );
  }
  if (
    realpathSync.native(input.databaseFilename) ===
    realpathSync.native(input.p39ReportFilename)
  ) {
    throw new Schema42TestDatabaseSetupError(
      "SCHEMA42_SETUP_FAILED",
      "P39 report database aliases the primary database.",
      39,
    );
  }

  for (const migration of HISTORICAL_SCHEMA42_SUFFIX_MIGRATIONS) {
    await runPrimary(
      input.databaseFilename,
      Effect.gen(function* () {
        yield* runMigrations([migration]);
      }),
    );
  }
  const version42 = await readUserVersion(input.databaseFilename);
  if (version42 !== 42) {
    throw new Schema42TestDatabaseSetupError(
      "SCHEMA42_SETUP_FAILED",
      `Schema-42 offline upgrade ended at user_version ${version42}, expected 42.`,
      version42,
    );
  }
  await checkpointSqlite(input.databaseFilename);
  await checkpointSqlite(input.p39ReportFilename);
};

/**
 * Creates a disposable, real SQLite database through the only approved test
 * path for the schema-42 runtime shape: ordinary P38, privileged P39
 * maintenance with a separate report database, then standalone P40/P41/P42.
 * A P39 deployment refusal is surfaced explicitly; this helper never fakes a
 * later user_version or substitutes descriptor SQL.
 */
export const createSchema42TestDatabase = async (
  options: Schema42TestDatabaseOptions = {},
): Promise<Schema42TestDatabase> => {
  const directory = createSchema42PrivateTestDirectory(
    options.parentDirectory ?? process.cwd(),
    options.prefix ??
      (options.targetSchemaVersion === 45 ||
      options.targetSchemaVersion === 46 ||
      options.targetSchemaVersion === 47 ||
      options.targetSchemaVersion === 48 ||
      options.targetSchemaVersion === 50 ||
      options.targetSchemaVersion === 51
        ? `arbor-schema${options.targetSchemaVersion}-test-`
        : options.targetSchemaVersion === 44
          ? "arbor-schema44-test-"
          : "arbor-schema42-test-"),
  );
  const databaseFilename = join(directory, "primary.sqlite");
  const p39ReportFilename = join(directory, "p39-report.sqlite");
  let retained = false;

  try {
    createP39PrivateTestFile(databaseFilename);
    await runPrimary(
      databaseFilename,
      Effect.gen(function* () {
        yield* runMigrations(P38_MIGRATIONS);
      }),
    );
    if (options.seedP38 !== undefined) {
      await options.seedP38(databaseFilename);
    }

    if (
      options.targetSchemaVersion === 45 ||
      options.targetSchemaVersion === 46 ||
      options.targetSchemaVersion === 47 ||
      options.targetSchemaVersion === 48 ||
      options.targetSchemaVersion === 50 ||
      options.targetSchemaVersion === 51
    ) {
      await upgradeSchema44TestDatabase({
        databaseFilename,
        p39ReportFilename,
      });
      await upgradeSchema45Suffix(databaseFilename);
      if (options.targetSchemaVersion === 46)
        await upgradeSchema46Suffix(databaseFilename);
      if (options.targetSchemaVersion === 47) {
        await upgradeSchema46Suffix(databaseFilename);
        await upgradeSchema47Suffix(databaseFilename);
      }
      if (options.targetSchemaVersion === 48) {
        await upgradeSchema46Suffix(databaseFilename);
        await upgradeSchema47Suffix(databaseFilename);
        await upgradeSchema48Suffix(databaseFilename);
      }
      if (options.targetSchemaVersion === 50) {
        await upgradeSchema46Suffix(databaseFilename);
        await upgradeSchema47Suffix(databaseFilename);
        await upgradeSchema48Suffix(databaseFilename);
        await upgradeSchema50Suffix(databaseFilename);
      }
      if (options.targetSchemaVersion === 51) {
        await upgradeSchema46Suffix(databaseFilename);
        await upgradeSchema47Suffix(databaseFilename);
        await upgradeSchema48Suffix(databaseFilename);
        await upgradeSchema50Suffix(databaseFilename);
        await upgradeSchema51Suffix(databaseFilename);
      }
    } else if (options.targetSchemaVersion === 44)
      await upgradeSchema44TestDatabase({
        databaseFilename,
        p39ReportFilename,
      });
    else
      await upgradeSchema42TestDatabase({
        databaseFilename,
        p39ReportFilename,
      });
    const expectedVersion = options.targetSchemaVersion ?? 42;
    const version = await readUserVersion(databaseFilename);
    if (version !== expectedVersion)
      throw new Error(`Schema-${expectedVersion} upgrade verification failed.`);

    retained = true;
    return {
      directory,
      databaseFilename,
      p39ReportFilename,
      cleanup: () => removeP39PrivateTestDirectory(directory),
    };
  } catch (cause) {
    if (cause instanceof Schema42TestDatabaseSetupError) throw cause;
    const version = await readUserVersion(databaseFilename).catch(
      () => undefined,
    );
    throw new Schema42TestDatabaseSetupError(
      "SCHEMA42_SETUP_FAILED",
      `Could not prepare the schema-42 test database${version === undefined ? "" : `; it remains at user_version ${version}`}.`,
      version,
      { cause },
    );
  } finally {
    if (!retained) removeP39PrivateTestDirectory(directory);
  }
};

export const createSchema44TestDatabase = (
  options: Schema44TestDatabaseOptions = {},
): Promise<Schema44TestDatabase> =>
  createSchema42TestDatabase({ ...options, targetSchemaVersion: 44 });

export const createSchema45TestDatabase = (
  options: Schema45TestDatabaseOptions = {},
): Promise<Schema45TestDatabase> =>
  createSchema42TestDatabase({ ...options, targetSchemaVersion: 45 });

export const createSchema46TestDatabase = (
  options: Schema46TestDatabaseOptions = {},
): Promise<Schema46TestDatabase> =>
  createSchema42TestDatabase({ ...options, targetSchemaVersion: 46 });

export const createSchema47TestDatabase = (
  options: Schema47TestDatabaseOptions = {},
): Promise<Schema47TestDatabase> =>
  createSchema42TestDatabase({ ...options, targetSchemaVersion: 47 });

export const createSchema48TestDatabase = (
  options: Schema48TestDatabaseOptions = {},
): Promise<Schema48TestDatabase> =>
  createSchema42TestDatabase({ ...options, targetSchemaVersion: 48 });

export const createSchema50TestDatabase = (
  options: Schema50TestDatabaseOptions = {},
): Promise<Schema50TestDatabase> =>
  createSchema42TestDatabase({ ...options, targetSchemaVersion: 50 });

export const createSchema51TestDatabase = (
  options: Schema51TestDatabaseOptions = {},
): Promise<Schema51TestDatabase> =>
  createSchema42TestDatabase({ ...options, targetSchemaVersion: 51 });

/**
 * Creates a disposable database at the production composition's current
 * schema. Ordinary runtime tests should use this instead of pinning a
 * historical schema number; historical upgrade/replay tests must continue to
 * request their exact source version explicitly.
 */
export const createCurrentSchemaTestDatabase = (
  options: CurrentSchemaTestDatabaseOptions = {},
): Promise<CurrentSchemaTestDatabase> =>
  createSchema42TestDatabase({
    ...options,
    targetSchemaVersion: CURRENT_SCHEMA_VERSION,
  });

/**
 * Builds the trusted schema-42/P39 template once for a test suite. Each case
 * gets a separate real SQLite file and P39 report sidecar copied only after
 * the template connections have closed. This avoids repeating privileged P39
 * setup without manufacturing user_version or migration SQL.
 */
export const createSchema42TestDatabaseFactory = async (
  options: Schema42TestDatabaseOptions = {},
): Promise<Schema42TestDatabaseFactory> => {
  const template = await createSchema42TestDatabase({
    ...options,
    prefix:
      options.prefix ??
      (options.targetSchemaVersion === 45 ||
      options.targetSchemaVersion === 46 ||
      options.targetSchemaVersion === 47 ||
      options.targetSchemaVersion === 48 ||
      options.targetSchemaVersion === 50 ||
      options.targetSchemaVersion === 51
        ? `arbor-schema${options.targetSchemaVersion}-template-`
        : options.targetSchemaVersion === 44
          ? "arbor-schema44-template-"
          : "arbor-schema42-template-"),
  });
  let cleanedUp = false;
  const cloneDirectories = new Set<string>();

  return {
    create: () => {
      if (cleanedUp) {
        throw new Error(
          "Cannot create a schema-42 test database after its factory was cleaned up.",
        );
      }
      const directory = createSchema42PrivateTestDirectory(
        process.cwd(),
        options.targetSchemaVersion === 45 ||
          options.targetSchemaVersion === 46 ||
          options.targetSchemaVersion === 47 ||
          options.targetSchemaVersion === 48 ||
          options.targetSchemaVersion === 50 ||
          options.targetSchemaVersion === 51
          ? `arbor-schema${options.targetSchemaVersion}-clone-`
          : options.targetSchemaVersion === 44
            ? "arbor-schema44-clone-"
            : "arbor-schema42-clone-",
      );
      const databaseFilename = join(directory, "primary.sqlite");
      const p39ReportFilename = join(directory, "p39-report.sqlite");
      try {
        copyFileSync(template.databaseFilename, databaseFilename);
        setP39PrivateWindowsAcl(databaseFilename, "file");
        copyFileSync(template.p39ReportFilename, p39ReportFilename);
        setP39PrivateWindowsAcl(p39ReportFilename, "file");
        cloneDirectories.add(directory);
        let cloneCleanedUp = false;
        return {
          directory,
          databaseFilename,
          p39ReportFilename,
          cleanup: () => {
            if (cloneCleanedUp) return;
            cloneCleanedUp = true;
            cloneDirectories.delete(directory);
            removeP39PrivateTestDirectory(directory);
          },
        };
      } catch (cause) {
        removeP39PrivateTestDirectory(directory);
        throw cause;
      }
    },
    cleanup: () => {
      if (cleanedUp) return;
      cleanedUp = true;
      for (const directory of cloneDirectories) {
        removeP39PrivateTestDirectory(directory);
      }
      cloneDirectories.clear();
      template.cleanup();
    },
  };
};

export const createSchema44TestDatabaseFactory = (
  options: Schema44TestDatabaseOptions = {},
): Promise<Schema44TestDatabaseFactory> =>
  createSchema42TestDatabaseFactory({ ...options, targetSchemaVersion: 44 });

export const createSchema45TestDatabaseFactory = (
  options: Schema45TestDatabaseOptions = {},
): Promise<Schema45TestDatabaseFactory> =>
  createSchema42TestDatabaseFactory({ ...options, targetSchemaVersion: 45 });

export const createSchema46TestDatabaseFactory = (
  options: Schema46TestDatabaseOptions = {},
): Promise<Schema46TestDatabaseFactory> =>
  createSchema42TestDatabaseFactory({ ...options, targetSchemaVersion: 46 });

export const createSchema47TestDatabaseFactory = (
  options: Schema47TestDatabaseOptions = {},
): Promise<Schema47TestDatabaseFactory> =>
  createSchema42TestDatabaseFactory({ ...options, targetSchemaVersion: 47 });

export const createSchema48TestDatabaseFactory = (
  options: Schema48TestDatabaseOptions = {},
): Promise<Schema48TestDatabaseFactory> =>
  createSchema42TestDatabaseFactory({ ...options, targetSchemaVersion: 48 });

export const createSchema50TestDatabaseFactory = (
  options: Schema50TestDatabaseOptions = {},
): Promise<Schema50TestDatabaseFactory> =>
  createSchema42TestDatabaseFactory({ ...options, targetSchemaVersion: 50 });

export const createSchema51TestDatabaseFactory = (
  options: Schema51TestDatabaseOptions = {},
): Promise<Schema51TestDatabaseFactory> =>
  createSchema42TestDatabaseFactory({ ...options, targetSchemaVersion: 51 });

/** Clone factory counterpart of {@link createCurrentSchemaTestDatabase}. */
export const createCurrentSchemaTestDatabaseFactory = (
  options: CurrentSchemaTestDatabaseOptions = {},
): Promise<CurrentSchemaTestDatabaseFactory> =>
  createSchema42TestDatabaseFactory({
    ...options,
    targetSchemaVersion: CURRENT_SCHEMA_VERSION,
  });

/** Runs one test case with its own cloned database and always removes it. */
export const withSchema44TestDatabase = async <A>(
  factory: Schema44TestDatabaseFactory,
  use: (database: Schema42TestDatabase) => Promise<A>,
): Promise<A> => {
  const database = factory.create();
  try {
    return await use(database);
  } finally {
    database.cleanup();
  }
};

export const withSchema42TestDatabase = async <A>(
  factory: Schema42TestDatabaseFactory,
  use: (database: Schema42TestDatabase) => Promise<A>,
): Promise<A> => {
  const database = factory.create();
  try {
    return await use(database);
  } finally {
    database.cleanup();
  }
};
