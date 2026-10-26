import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { cwd } from "node:process";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import {
  layer,
  P45_RETRY_VERIFICATION_ORIGIN_MIGRATION,
  P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION,
  P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION,
  P48_AH19_CONVERSATION_CHECKPOINT_OWNER_MIGRATION,
  P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_MIGRATION,
  P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_MIGRATION,
  P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_MIGRATION,
  P52_WORK_CONTRACT_REVISION_MIGRATION,
  P53_CANONICAL_OWNERSHIP_CARVEOUTS_MIGRATION,
  P54_NATIVE_PROCESS_MODE_NO_EFFECT_DENIAL_MIGRATION,
  preflightVerificationEvidenceSnapshot,
  runMigrations,
  splitStatements,
} from "../../../adapters/persistence-sqlite/src/index.js";
import { backfillRetryVerificationOrigins } from "../../../apps/single-workspace/src/retry-verification-origin-backfill.js";
import {
  removeP39PrivateTestDirectory,
  setP39PrivateWindowsAcl,
} from "../../support/p39-windows-deployment-test.js";
import {
  createSchema44TestDatabase,
  type Schema44TestDatabase,
} from "../../support/schema44-database.js";

const manifestEnvironmentKey = "ARBOR_FUNCTIONAL_SCHEMA44_MANIFEST";
const manifestFilename = "schema44-manifest.json";

interface FunctionalSchema44Manifest {
  readonly version: 1;
  readonly root: string;
  readonly primary: string;
  readonly report: string;
}

const isInside = (root: string, candidate: string): boolean => {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== ".." &&
      !isAbsolute(relativePath))
  );
};

export const createFunctionalSchema44Template = async (): Promise<
  () => void
> => {
  const root = mkdtempSync(join(cwd(), ".arbor-functional-schema44-"));
  let template: Schema44TestDatabase | undefined;
  let cleaned = false;
  try {
    setP39PrivateWindowsAcl(root, "directory");
    template = await createSchema44TestDatabase({
      prefix: "template-",
      parentDirectory: root,
    });
    const manifest: FunctionalSchema44Manifest = {
      version: 1,
      root,
      primary: template.databaseFilename,
      report: template.p39ReportFilename,
    };
    const path = join(root, manifestFilename);
    writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
    setP39PrivateWindowsAcl(path, "file");
    process.env[manifestEnvironmentKey] = path;
  } catch (error) {
    template?.cleanup();
    removeP39PrivateTestDirectory(root);
    throw error;
  }

  return () => {
    if (cleaned) return;
    cleaned = true;
    const path = process.env[manifestEnvironmentKey];
    if (path !== undefined && isInside(root, path)) {
      delete process.env[manifestEnvironmentKey];
    }
    removeP39PrivateTestDirectory(root);
  };
};

const readManifest = (): FunctionalSchema44Manifest => {
  const path = process.env[manifestEnvironmentKey];
  if (path === undefined) {
    throw new Error(
      "Functional schema-44 bootstrap is missing; run through the functional Vitest or Playwright configuration.",
    );
  }
  const absolutePath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (cause) {
    throw new Error("Functional schema-44 manifest cannot be read.", { cause });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("root" in parsed) ||
    typeof parsed.root !== "string" ||
    !("primary" in parsed) ||
    typeof parsed.primary !== "string" ||
    !("report" in parsed) ||
    typeof parsed.report !== "string"
  ) {
    throw new Error("Functional schema-44 manifest has an invalid shape.");
  }
  const manifest = parsed as FunctionalSchema44Manifest;
  const root = resolve(manifest.root);
  if (
    !isInside(root, absolutePath) ||
    !isInside(root, manifest.primary) ||
    !isInside(root, manifest.report) ||
    !existsSync(manifest.primary) ||
    !existsSync(manifest.report)
  ) {
    throw new Error("Functional schema-44 manifest paths are not trusted.");
  }
  return { ...manifest, root };
};

/** Copy the closed schema-44 template and stop at the exact historical
 * schema-48 boundary. This is intentionally exposed only to functional tests
 * that qualify an operator whose accepted input contract is schema 48. */
export const replaceFunctionalFixtureWithSchema48Source = async (
  directory: string,
): Promise<{ readonly databaseFile: string; readonly reportFile: string }> => {
  const manifest = readManifest();
  if (!isInside(manifest.root, directory)) {
    throw new Error(
      "Functional fixture directory is outside its private root.",
    );
  }
  const databaseFile = join(directory, "arbor-functional.db");
  const reportFile = join(directory, "arbor-functional-p39-report.db");
  copyFileSync(manifest.primary, databaseFile, 0);
  setP39PrivateWindowsAcl(databaseFile, "file");
  copyFileSync(manifest.report, reportFile, 0);
  setP39PrivateWindowsAcl(reportFile, "file");
  const database = new DatabaseSync(databaseFile);
  try {
    database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    const version = Number(
      (
        database.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    );
    if (version !== 44) {
      throw new Error(
        `Functional schema upgrade expected 44, found ${version}`,
      );
    }
    const inboxReferences = database
      .prepare(
        `SELECT m.name AS table_name, f."table" AS referenced_table
           FROM sqlite_master AS m, pragma_foreign_key_list(m.name) AS f
          WHERE m.type = 'table' AND f."table" = 'inbox_entries'`,
      )
      .all();
    if (inboxReferences.length > 0) {
      throw new Error("Schema44 source has an unexpected FK to inbox_entries");
    }
    for (const statement of splitStatements(
      P45_RETRY_VERIFICATION_ORIGIN_MIGRATION.sql,
    )) {
      database.exec(statement);
    }
    backfillRetryVerificationOrigins(database);
    database.exec("PRAGMA user_version = 45");
    preflightVerificationEvidenceSnapshot(database);
    for (const statement of splitStatements(
      P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION.sql,
    )) {
      database.exec(statement);
    }
    database.exec("PRAGMA user_version = 46");
    for (const statement of splitStatements(
      P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION.sql,
    )) {
      database.exec(statement);
    }
    database.exec("PRAGMA user_version = 47");
    for (const statement of splitStatements(
      P48_AH19_CONVERSATION_CHECKPOINT_OWNER_MIGRATION.sql,
    )) {
      database.exec(statement);
    }
    database.exec("PRAGMA user_version = 48");
    if (database.prepare("PRAGMA foreign_key_check").all().length > 0) {
      throw new Error("Functional 44→48 fixture failed foreign_key_check");
    }
    database.exec("COMMIT");
  } catch (cause) {
    try {
      if (database.isTransaction) database.exec("ROLLBACK");
    } catch {
      /* connection close rolls back the disposable fixture transaction */
    }
    throw cause;
  } finally {
    database.close();
  }
  const schema48 = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const version = Number(
      (
        schema48.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    );
    if (version !== 48) {
      throw new Error(
        `Functional historical clone ended at ${version}; expected schema 48.`,
      );
    }
  } finally {
    schema48.close();
  }
  return { databaseFile, reportFile };
};

/** Upgrade an exact disposable schema-48 image through the ordinary accepted
 * migration prefix to the current runtime schema. */
export const upgradeFunctionalSchema48DatabaseToCurrent = async (
  databaseFile: string,
): Promise<void> => {
  const database = new DatabaseSync(databaseFile);
  try {
    database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    const version = Number(
      (
        database.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    );
    if (version !== 48) {
      throw new Error(
        `Functional schema-48 upgrade requires exact source 48; found ${version}.`,
      );
    }
    for (const migration of [
      P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_MIGRATION,
      P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_MIGRATION,
    ]) {
      for (const statement of splitStatements(migration.sql)) {
        database.exec(statement);
      }
      database.exec(`PRAGMA user_version = ${migration.id}`);
    }
    if (database.prepare("PRAGMA foreign_key_check").all().length > 0) {
      throw new Error("Functional 48→50 fixture failed foreign_key_check");
    }
    database.exec("COMMIT");
  } catch (cause) {
    try {
      if (database.isTransaction) database.exec("ROLLBACK");
    } catch {
      /* connection close rolls back the disposable fixture transaction */
    }
    throw cause;
  } finally {
    database.close();
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        runMigrations([P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_MIGRATION], {
          allowOfflineOnly: true,
        }),
        layer({ filename: databaseFile }),
      ),
    ),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        runMigrations([P52_WORK_CONTRACT_REVISION_MIGRATION], {
          allowOfflineOnly: true,
        }),
        layer({ filename: databaseFile }),
      ),
    ),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        runMigrations([P53_CANONICAL_OWNERSHIP_CARVEOUTS_MIGRATION], {
          allowOfflineOnly: true,
        }),
        layer({ filename: databaseFile }),
      ),
    ),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        runMigrations([P54_NATIVE_PROCESS_MODE_NO_EFFECT_DENIAL_MIGRATION], {
          allowOfflineOnly: true,
        }),
        layer({ filename: databaseFile }),
      ),
    ),
  );
  const currentSchema = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const currentVersion = Number(
      (
        currentSchema.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    );
    if (
      currentVersion !== 54 ||
      currentSchema.prepare("PRAGMA foreign_key_check").all().length > 0
    ) {
      throw new Error(
        `Functional disposable schema upgrade ended at ${currentVersion} or failed foreign_key_check; expected schema 54.`,
      );
    }
  } finally {
    currentSchema.close();
  }
};

/** Copy the closed schema-44 template, then upgrade a private clone through
 * the current offline migration prefix. Historical export names below are
 * aliases only. */
export const cloneFunctionalCurrentSchemaDatabase = async (
  directory: string,
): Promise<{ readonly databaseFile: string; readonly reportFile: string }> => {
  const clone = await replaceFunctionalFixtureWithSchema48Source(directory);
  await upgradeFunctionalSchema48DatabaseToCurrent(clone.databaseFile);
  return clone;
};

/** Historical aliases retained for existing test call sites; every helper
 * now returns a current-schema disposable clone. Tests for exact historical
 * versions use `tests/support/schema44-database.ts` instead. */
export const cloneFunctionalSchema50Database =
  cloneFunctionalCurrentSchemaDatabase;
export const cloneFunctionalSchema51Database =
  cloneFunctionalCurrentSchemaDatabase;
export const cloneFunctionalSchema52Database =
  cloneFunctionalCurrentSchemaDatabase;
export const cloneFunctionalSchema48Database =
  cloneFunctionalCurrentSchemaDatabase;
export const cloneFunctionalSchema47Database =
  cloneFunctionalCurrentSchemaDatabase;
export const cloneFunctionalSchema46Database =
  cloneFunctionalCurrentSchemaDatabase;
export const cloneFunctionalSchema45Database =
  cloneFunctionalCurrentSchemaDatabase;
export const cloneFunctionalSchema44Database =
  cloneFunctionalCurrentSchemaDatabase;

export const createFunctionalFixtureDirectory = (): string => {
  const manifest = readManifest();
  const directory = mkdtempSync(join(manifest.root, "fixture-"));
  try {
    setP39PrivateWindowsAcl(directory, "directory");
    return directory;
  } catch (cause) {
    removeP39PrivateTestDirectory(directory);
    throw cause;
  }
};

export const removeFunctionalFixtureDirectory = (directory: string): void => {
  removeP39PrivateTestDirectory(directory);
};

export const functionalSchema44ManifestPath = (): string | undefined =>
  process.env[manifestEnvironmentKey];
