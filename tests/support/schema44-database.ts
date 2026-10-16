import { copyFileSync, existsSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Cause, Effect, Exit, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  P32_MIGRATIONS,
  P38_MIGRATIONS,
  P40_TOOL_OBSERVATION_REPLAY_MIGRATION,
  P41_SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION,
  P42_PROJECT_RESOURCE_SOURCE_MIGRATION,
  P43_MIGRATION,
  P44_APPROVAL_REJECTED_NO_EFFECT_DENIAL_MIGRATION,
  runMigrations,
  runP39SqliteMaintenance,
  layer as sqliteLayer,
} from "../../adapters/persistence-sqlite/src/index.js";
import {
  createP39PrivateTestFile,
  removeP39PrivateTestDirectory,
  setP39PrivateWindowsAcl,
} from "./p39-windows-deployment-test.js";

const schema42StandaloneSuffix = [
  P40_TOOL_OBSERVATION_REPLAY_MIGRATION,
  P41_SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION,
  P42_PROJECT_RESOURCE_SOURCE_MIGRATION,
] as const;

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
  readonly targetSchemaVersion?: 42 | 44;
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

  for (const migration of schema42StandaloneSuffix) {
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
      (options.targetSchemaVersion === 44
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

    if (options.targetSchemaVersion === 44)
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
      (options.targetSchemaVersion === 44
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
        options.targetSchemaVersion === 44
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
