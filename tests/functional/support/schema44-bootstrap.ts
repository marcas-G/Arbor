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

/** Copy both closed template databases into an ACL-protected case directory. */
export const cloneFunctionalSchema50Database = async (
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
      throw new Error("Functional 44→50 fixture failed foreign_key_check");
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
  return { databaseFile, reportFile };
};

/** Historical call sites use this name for the current disposable fixture. */
export const cloneFunctionalSchema48Database = cloneFunctionalSchema50Database;

/** Historical names retained for existing test call sites; fixtures track the
 * current ordinary runtime schema, while migration tests use exact versions. */
export const cloneFunctionalSchema47Database = cloneFunctionalSchema50Database;
export const cloneFunctionalSchema46Database = cloneFunctionalSchema50Database;
export const cloneFunctionalSchema45Database = cloneFunctionalSchema50Database;
export const cloneFunctionalSchema44Database = cloneFunctionalSchema50Database;

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
