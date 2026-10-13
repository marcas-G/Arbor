import { copyFileSync, existsSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Cause, Effect, Exit, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  P38_MIGRATIONS,
  P40_TOOL_OBSERVATION_REPLAY_MIGRATION,
  P41_SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION,
  P42_PROJECT_RESOURCE_SOURCE_MIGRATION,
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
}

export interface Schema42TestDatabaseFactory {
  /** Copies the closed trusted template into a new, independent SQLite file. */
  readonly create: () => Schema42TestDatabase;
  /** Removes the trusted template after all clones have been cleaned up. */
  readonly cleanup: () => void;
}

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

const failureValue = (exit: Exit.Failure<unknown, unknown>) =>
  Option.getOrNull(Cause.findErrorOption(exit.cause));

const isUnsupportedP39Deployment = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  "code" in value &&
  value.code === "P39_UNSUPPORTED_DEPLOYMENT";

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
    process.cwd(),
    options.prefix ?? "arbor-schema42-test-",
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

    const p39 = await Effect.runPromiseExit(
      runP39SqliteMaintenance({
        primaryFilename: databaseFilename,
        sidecarFilename: p39ReportFilename,
        protectedStoreFilenames: [],
      }),
    );
    if (Exit.isFailure(p39)) {
      const reason = failureValue(p39);
      if (isUnsupportedP39Deployment(reason)) {
        const version = await readUserVersion(databaseFilename);
        throw new Schema42TestDatabaseSetupError(
          "P39_UNSUPPORTED_DEPLOYMENT",
          `P39 maintenance is unsupported for this test environment; the disposable database remains at schema ${version} and schema 42 was not fabricated.`,
          version,
          { cause: Cause.squash(p39.cause) },
        );
      }
      throw Cause.squash(p39.cause);
    }
    if (!existsSync(p39ReportFilename)) {
      throw new Schema42TestDatabaseSetupError(
        "SCHEMA42_SETUP_FAILED",
        "P39 maintenance completed without creating its separate report database.",
        39,
      );
    }
    if (
      realpathSync.native(databaseFilename) ===
      realpathSync.native(p39ReportFilename)
    ) {
      throw new Schema42TestDatabaseSetupError(
        "SCHEMA42_SETUP_FAILED",
        "P39 report database aliases the primary database.",
        39,
      );
    }

    for (const migration of schema42StandaloneSuffix) {
      await runPrimary(
        databaseFilename,
        Effect.gen(function* () {
          yield* runMigrations([migration]);
        }),
      );
    }
    const version = await readUserVersion(databaseFilename);
    if (version !== 42) {
      throw new Schema42TestDatabaseSetupError(
        "SCHEMA42_SETUP_FAILED",
        `Schema-42 test fixture ended at user_version ${version}, expected 42.`,
        version,
      );
    }
    await checkpointSqlite(databaseFilename);
    await checkpointSqlite(p39ReportFilename);

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
    prefix: options.prefix ?? "arbor-schema42-template-",
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
        "arbor-schema42-clone-",
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
