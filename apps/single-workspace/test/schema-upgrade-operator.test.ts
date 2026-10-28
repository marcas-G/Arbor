import { spawn } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  layer,
  P38_MIGRATIONS,
  P45_RETRY_VERIFICATION_ORIGIN_MIGRATION,
  P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION,
  P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION,
  P48_AH19_CONVERSATION_CHECKPOINT_OWNER_MIGRATION,
  P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_MIGRATION,
  runMigrations,
} from "@arbor/persistence-sqlite";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createP39PrivateTestFile,
  makeP39PrivateTestDirectory,
  removeP39PrivateTestDirectory,
} from "../../../tests/support/p39-windows-deployment-test.js";
import {
  createCurrentSchemaTestDatabase,
  createSchema44TestDatabaseFactory,
  createSchema50TestDatabase,
  createSchema51TestDatabase,
  type Schema44TestDatabase,
  type Schema44TestDatabaseFactory,
} from "../../../tests/support/schema44-database.js";
import {
  formatSchemaUpgradeCliFailure,
  parseSchemaUpgradeArguments,
  runSchemaUpgrade,
  type SchemaUpgradeArguments,
  type SchemaUpgradePreviewTemplate,
  type SchemaUpgradeTestHooks,
  schemaUpgradeDescriptorPinKats,
} from "../src/schema-upgrade.js";
import {
  assertDistinctPaths,
  descriptorHashesThrough,
  existingPathIdentity,
  logicalSqliteDigest,
  prefixSignature,
  readSchemaUpgradeManifest,
  readUserVersion,
  type SchemaUpgradePathIdentity,
  SchemaUpgradeRefusal,
  sqliteSchemaSignature,
  verifyP39ReportEvidence,
  writeFullyAndSync,
} from "../src/schema-upgrade-manifest.js";

const CLI_PROCESS_TIMEOUT_MS = 1_800_000;
const EXHAUSTIVE_SCHEMA_UPGRADE =
  process.env.ARBOR_EXHAUSTIVE_SCHEMA_UPGRADE === "1";
const exhaustiveIt = EXHAUSTIVE_SCHEMA_UPGRADE ? it : it.skip;

let schema44Factory: Schema44TestDatabaseFactory | undefined;

beforeAll(async () => {
  schema44Factory = await createSchema44TestDatabaseFactory({
    prefix: ".schema-upgrade-operator-schema44-template-",
  });
}, 120_000);

afterAll(() => {
  schema44Factory?.cleanup();
  schema44Factory = undefined;
}, 120_000);

const createHistoricalSchemaClone = async (
  targetVersion: 44 | 45 | 46 | 47 | 48,
): Promise<Schema44TestDatabase> => {
  if (schema44Factory === undefined)
    throw new Error("Schema-44 upgrade template is not ready.");
  const fixture = schema44Factory.create();
  const suffix = [
    P45_RETRY_VERIFICATION_ORIGIN_MIGRATION,
    P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION,
    P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION,
    P48_AH19_CONVERSATION_CHECKPOINT_OWNER_MIGRATION,
  ].filter(({ id }) => id <= targetVersion);
  try {
    if (suffix.length > 0) {
      await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            runMigrations(suffix, { allowOfflineOnly: true }),
            layer({ filename: fixture.databaseFilename }),
          ),
        ),
      );
    }
    const actualVersion = readUserVersion(fixture.databaseFilename);
    if (actualVersion !== targetVersion) {
      throw new Error(
        `Historical clone reached schema ${actualVersion}; expected ${targetVersion}.`,
      );
    }
    return fixture;
  } catch (cause) {
    fixture.cleanup();
    throw cause;
  }
};

// The exact P38 prefix preview produced by the resume qualification can also
// serve later P38 copy cases in this file. runSchemaUpgrade accepts it only
// after matching the live target's logical digest and migration signature.
let p38PreviewTemplate: SchemaUpgradePreviewTemplate | undefined;

const seedVersion38 = async (filename: string): Promise<void> => {
  createP39PrivateTestFile(filename);
  await Effect.runPromise(
    Effect.scoped(
      Effect.provide(runMigrations(P38_MIGRATIONS), layer({ filename })),
    ),
  );
};

const copyArgs = (directory: string): SchemaUpgradeArguments => ({
  mode: "copy",
  sourceDatabase: join(directory, "source.sqlite"),
  database: join(directory, "target.sqlite"),
  p39ReportDatabase: join(directory, "report.sqlite"),
  copyManifest: join(directory, "provenance.jsonl"),
});

const seedSchema51WorkForP52OfflineQualification = (filename: string): void => {
  const database = new DatabaseSync(filename);
  try {
    database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    database
      .prepare(
        `INSERT INTO projects (
           project_id, name, root_workspace_id, project_policy,
           project_policy_revision, default_configuration, environment_ref,
           lifecycle, revision, created_at, updated_at
         ) VALUES (?, 'P52 offline fixture', ?, '{}', 0, '{}', 'local',
                   'Open', 0, 't0', 't0')`,
      )
      .run("prj_p52_offline", "ws_p52_offline");
    database
      .prepare(
        `INSERT INTO sessions (
           session_id, binding_kind, workspace_id, execution_id,
           context_epoch, created_at
         ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
      )
      .run("ses_p52_offline", "ws_p52_offline");
    database
      .prepare(
        `INSERT INTO workspaces (
           workspace_id, project_id, parent_workspace_id, name,
           responsibility_definition, responsibility_revision,
           resource_boundary, resource_boundary_revision, agent_binding,
           primary_session_id, current_work_id, workspace_policy,
           workspace_policy_revision, revision, lifecycle, created_at,
           updated_at
         ) VALUES (?, ?, NULL, 'root', '{}', 0, '{}', 0, '{}', ?, ?, '{}',
                   0, 0, 'Active', 't0', 't0')`,
      )
      .run(
        "ws_p52_offline",
        "prj_p52_offline",
        "ses_p52_offline",
        "wrk_p52_offline",
      );
    database
      .prepare(
        `INSERT INTO works (
           work_id, project_id, workspace_id, objective, why, constraints,
           completion_expectation, verification_mission, provenance,
           lifecycle, revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Open', 4, 't0', 't4')`,
      )
      .run(
        "wrk_p52_offline",
        "prj_p52_offline",
        "ws_p52_offline",
        "offline legacy objective",
        "offline legacy why",
        JSON.stringify(["immutable S2 backfill"]),
        "offline legacy expectation",
        JSON.stringify({
          goal: "offline legacy mission",
          criteria: [
            {
              criterionId: "offline",
              requirement: "the backfill preserves this mission",
              required: true,
            },
          ],
          riskRequirements: [],
        }),
        JSON.stringify({ predecessorWorkId: null, reason: "offline source" }),
      );
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
};

const schema48CopyArgs = (
  directory: string,
  sourceDatabase: string,
): SchemaUpgradeArguments => ({
  mode: "copy",
  sourceDatabase,
  database: join(directory, "schema50-copy.sqlite"),
  p39ReportDatabase: join(directory, "schema50-p39-report.sqlite"),
  copyManifest: join(directory, "schema50-copy-manifest.jsonl"),
});

const copyReportSidecar = async (
  source: string,
  destination: string,
): Promise<void> => {
  createP39PrivateTestFile(destination);
  const sourceDatabase = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(sourceDatabase, destination);
  } finally {
    sourceDatabase.close();
  }
};

const moveSqliteFiles = (source: string, destination: string): void => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const sourcePath = `${source}${suffix}`;
    if (existsSync(sourcePath)) {
      renameSync(sourcePath, `${destination}${suffix}`);
    }
  }
};

const resumeInChildProcess = (
  args: SchemaUpgradeArguments,
): Promise<{ readonly code: number | null; readonly output: string }> =>
  new Promise((resolve, reject) => {
    const cli = join(
      process.cwd(),
      "apps/single-workspace/dist/schema-upgrade.js",
    );
    const child = spawn(
      process.execPath,
      [
        cli,
        "--mode",
        "resume-copy",
        "--source-database",
        args.sourceDatabase as string,
        "--database",
        args.database,
        "--p39-report-db",
        args.p39ReportDatabase,
        "--copy-manifest",
        args.copyManifest,
      ],
      { cwd: process.cwd(), env: process.env, windowsHide: true },
    );
    let output = "";
    const timeout = setTimeout(() => child.kill(), CLI_PROCESS_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", (cause) => {
      clearTimeout(timeout);
      reject(cause);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, output });
    });
  });

describe("offline P39–P54 schema-upgrade CLI", () => {
  it("loops through short manifest writes and never flushes a stalled append", () => {
    const bytes = Buffer.from("append-only-record\n", "utf8");
    let output = Buffer.alloc(0);
    let flushCount = 0;
    writeFullyAndSync(
      bytes,
      (buffer, offset, remaining) => {
        const count = Math.min(3, remaining);
        output = Buffer.concat([
          output,
          buffer.subarray(offset, offset + count),
        ]);
        return count;
      },
      () => {
        flushCount += 1;
      },
    );
    expect(output).toEqual(bytes);
    expect(flushCount).toBe(1);

    let stalledFlushCount = 0;
    expect(() =>
      writeFullyAndSync(
        bytes,
        () => 0,
        () => {
          stalledFlushCount += 1;
        },
      ),
    ).toThrow(/forward progress/u);
    expect(stalledFlushCount).toBe(0);
  });

  it("renders structured CLI failures without object dumps, paths, or secrets", () => {
    const message = formatSchemaUpgradeCliFailure({
      _tag: "P39MaintenanceFailure",
      code: "P39_WRITER_LOCK_ACQUIRE_FAILED",
      cause: {
        _tag: "P39WriterLockFailure",
        code: "P39_WRITER_LOCK_ACQUIRE_FAILED",
        reasonCode: "SQLITE_BUSY",
        message: "secret=not-for-output C:\\private\\db.sqlite",
      },
    });
    expect(message).toBe(
      "P39MaintenanceFailure/P39_WRITER_LOCK_ACQUIRE_FAILED: " +
        "P39WriterLockFailure/P39_WRITER_LOCK_ACQUIRE_FAILED/SQLITE_BUSY",
    );
    expect(message).not.toContain("[object Object]");
    expect(message).not.toContain("private");
    expect(message).not.toContain("not-for-output");

    const refusal = formatSchemaUpgradeCliFailure(
      new SchemaUpgradeRefusal(
        "source path C:\\private\\source.sqlite rejected; token=hidden",
      ),
    );
    expect(refusal).toBe("SchemaUpgradeRefusal: source path <path>");
    const windowsPath = formatSchemaUpgradeCliFailure(
      new SchemaUpgradeRefusal(
        "failed C:\\Users\\ThinkPad\\Private Workspace\\db.sqlite; token=hidden",
      ),
    );
    expect(windowsPath).not.toContain("ThinkPad");
    expect(windowsPath).not.toContain("Private");
    expect(windowsPath).not.toContain("Workspace");
    expect(windowsPath).not.toContain("db.sqlite");

    const unixPath = formatSchemaUpgradeCliFailure(
      new SchemaUpgradeRefusal(
        "failed /var/lib/arbor private data.sqlite; secret=hidden",
      ),
    );
    expect(unixPath).not.toContain("/var");
    expect(unixPath).not.toContain("arbor");
    expect(unixPath).not.toContain("private");
    expect(unixPath).not.toContain("data.sqlite");
    expect(unixPath).not.toContain("hidden");
  });

  it("requires explicit complete mode arguments and rejects ambiguous source combinations", () => {
    expect(() =>
      parseSchemaUpgradeArguments(["--mode", "fresh", "--database", "db"]),
    ).toThrow();
    expect(() =>
      parseSchemaUpgradeArguments([
        "--mode",
        "fresh",
        "--database",
        "db",
        "--p39-report-db",
        "report",
        "--copy-manifest",
        "manifest",
        "--source-database",
        "source",
      ]),
    ).toThrow(/does not accept/u);
    expect(() =>
      parseSchemaUpgradeArguments([
        "--mode",
        "resume-copy",
        "--database",
        "target",
        "--p39-report-db",
        "report",
        "--copy-manifest",
        "manifest",
      ]),
    ).toThrow(/requires --source-database/u);
    expect(
      parseSchemaUpgradeArguments([
        "--mode",
        "copy",
        "--source-database",
        "source",
        "--database",
        "target",
        "--p39-report-db",
        "report",
        "--copy-manifest",
        "manifest",
      ]).mode,
    ).toBe("copy");
  });

  it("hashes SQLite storage classes, duplicate rows and AUTOINCREMENT state while ignoring physical/planner state", () => {
    const directory = mkdtempSync(join(process.cwd(), ".schema-digest-test-"));
    const filename = join(directory, "digest.sqlite");
    const db = new DatabaseSync(filename);
    try {
      db.exec(
        "CREATE TABLE values_table(value); INSERT INTO values_table VALUES (1),(1.5),('1'),(x'31'),(NULL)",
      );
      const typedDigest = logicalSqliteDigest(filename);
      db.exec("ANALYZE");
      expect(logicalSqliteDigest(filename)).toBe(typedDigest);
      db.exec("VACUUM");
      expect(logicalSqliteDigest(filename)).toBe(typedDigest);
      db.exec("INSERT INTO values_table VALUES (1)");
      expect(logicalSqliteDigest(filename)).not.toBe(typedDigest);

      db.exec(
        "CREATE TABLE sequence_table(id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO sequence_table DEFAULT VALUES; DELETE FROM sequence_table",
      );
      const sequenceDigest = logicalSqliteDigest(filename);
      db.exec("DELETE FROM sqlite_sequence WHERE name = 'sequence_table'");
      expect(logicalSqliteDigest(filename)).not.toBe(sequenceDigest);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: false });
    }
  });

  it("validates every migration predecessor and accepted descriptor hash in-process", () => {
    const kats = schemaUpgradeDescriptorPinKats();
    expect(kats.map(({ version }) => version)).toEqual([
      37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54,
    ]);
    expect(kats.map(({ requiresUserVersion }) => requiresUserVersion)).toEqual([
      36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53,
    ]);
    expect(kats.map(({ sha256 }) => sha256)).toEqual(
      descriptorHashesThrough(54),
    );
  });

  exhaustiveIt(
    "[exhaustive] resumes exact prefixes and rejects provenance tampering",
    async () => {
      const directory = makeP39PrivateTestDirectory(
        process.cwd(),
        ".schema-upgrade-cli-",
      );
      const args = copyArgs(directory);
      const resumeArgs = { ...args, mode: "resume-copy" as const };
      let previewTemplate = p38PreviewTemplate;
      const runPreparedUpgrade = (
        input: SchemaUpgradeArguments,
        hooks: SchemaUpgradeTestHooks = {},
      ) =>
        runSchemaUpgrade(input, {
          ...hooks,
          ...(previewTemplate === undefined ? {} : { previewTemplate }),
          onPreviewTemplate: (template) => {
            previewTemplate ??= template;
            p38PreviewTemplate ??= template;
            hooks.onPreviewTemplate?.(template);
          },
        });
      try {
        await seedVersion38(args.sourceDatabase as string);
        const sourceDigest = logicalSqliteDigest(args.sourceDatabase as string);
        await expect(
          runPreparedUpgrade(args, {
            beforeDatabaseTransaction: (version) => {
              if (version === 39)
                throw new Error("injected stop before migration 39");
            },
          }),
        ).rejects.toThrow(/injected stop before migration 39/u);
        expect(readUserVersion(args.sourceDatabase as string)).toBe(38);
        expect(logicalSqliteDigest(args.sourceDatabase as string)).toBe(
          sourceDigest,
        );
        expect(readUserVersion(args.database)).toBe(38);
        expect(
          readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
        ).toMatchObject({
          kind: "Prepared",
          step: "p39-0037-0039",
        });

        await expect(
          runPreparedUpgrade(resumeArgs, {
            afterDatabaseCommit: (version) => {
              if (version === 39)
                throw new Error("injected stop after migration 39 commit");
            },
          }),
        ).rejects.toThrow(/injected stop after migration 39 commit/u);
        expect(readUserVersion(args.database)).toBe(39);
        expect(
          readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
        ).toMatchObject({
          kind: "Prepared",
          step: "p39-0037-0039",
        });

        await expect(
          runPreparedUpgrade(resumeArgs, {
            beforeDatabaseTransaction: (version) => {
              if (version === 40)
                throw new Error("injected stop before migration 40");
            },
          }),
        ).rejects.toThrow(/injected stop before migration 40/u);
        expect(readUserVersion(args.database)).toBe(39);
        expect(
          readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
        ).toMatchObject({
          kind: "Prepared",
          step: "0040",
        });

        await expect(
          runPreparedUpgrade(resumeArgs, {
            afterDatabaseCommit: (version) => {
              if (version === 40)
                throw new Error("injected stop after migration 40 commit");
            },
          }),
        ).rejects.toThrow(/injected stop after migration 40 commit/u);
        expect(readUserVersion(args.database)).toBe(40);
        expect(
          readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
        ).toMatchObject({
          kind: "Prepared",
          step: "0040",
        });

        await expect(
          runPreparedUpgrade(resumeArgs, {
            beforeDatabaseTransaction: (version) => {
              if (version === 41)
                throw new Error("injected stop before migration 41");
            },
          }),
        ).rejects.toThrow(/injected stop before migration 41/u);
        expect(readUserVersion(args.database)).toBe(40);
        expect(
          readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
        ).toMatchObject({
          kind: "Prepared",
          step: "0041",
        });

        await expect(
          runPreparedUpgrade(resumeArgs, {
            afterDatabaseCommit: (version) => {
              if (version === 41)
                throw new Error("injected stop after migration 41 commit");
            },
          }),
        ).rejects.toThrow(/injected stop after migration 41 commit/u);
        expect(readUserVersion(args.database)).toBe(41);
        expect(
          readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
        ).toMatchObject({
          kind: "Prepared",
          step: "0041",
        });

        await expect(
          runPreparedUpgrade(resumeArgs, {
            beforeDatabaseTransaction: (version) => {
              if (version === 42)
                throw new Error("injected stop before migration 42");
            },
          }),
        ).rejects.toThrow(/injected stop before migration 42/u);
        expect(readUserVersion(args.database)).toBe(41);
        expect(
          readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
        ).toMatchObject({
          kind: "Prepared",
          step: "0042",
        });

        await expect(
          runPreparedUpgrade(resumeArgs, {
            afterDatabaseCommit: (version) => {
              if (version === 42)
                throw new Error("injected stop after migration 42 commit");
            },
          }),
        ).rejects.toThrow(/injected stop after migration 42 commit/u);
        expect(readUserVersion(args.database)).toBe(42);
        expect(
          readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
        ).toMatchObject({
          kind: "Prepared",
          step: "0042",
        });

        await expect(
          runPreparedUpgrade(resumeArgs, {
            beforeDatabaseTransaction: (version) => {
              if (version === 43)
                throw new Error("injected stop before migration 43");
            },
          }),
        ).rejects.toThrow(/injected stop before migration 43/u);
        expect(readUserVersion(args.database)).toBe(42);
        expect(
          readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
        ).toMatchObject({ kind: "Prepared", step: "0043" });

        await expect(
          runPreparedUpgrade(resumeArgs, {
            afterDatabaseCommit: (version) => {
              if (version === 43)
                throw new Error("injected stop after migration 43 commit");
            },
          }),
        ).rejects.toThrow(/injected stop after migration 43 commit/u);
        expect(readUserVersion(args.database)).toBe(43);
        expect(
          readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
        ).toMatchObject({ kind: "Prepared", step: "0043" });

        await expect(
          runPreparedUpgrade(resumeArgs, {
            beforeDatabaseTransaction: (version) => {
              if (version === 44)
                throw new Error("injected stop before migration 44");
            },
          }),
        ).rejects.toThrow(/injected stop before migration 44/u);
        expect(readUserVersion(args.database)).toBe(43);
        expect(
          readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
        ).toMatchObject({ kind: "Prepared", step: "0044" });

        await expect(
          runPreparedUpgrade(resumeArgs, {
            afterDatabaseCommit: (version) => {
              if (version === 44)
                throw new Error("injected stop after migration 44 commit");
            },
          }),
        ).rejects.toThrow(/injected stop after migration 44 commit/u);
        expect(readUserVersion(args.database)).toBe(44);
        expect(
          readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
        ).toMatchObject({ kind: "Prepared", step: "0044" });

        await expect(
          runPreparedUpgrade(resumeArgs, {
            beforeDatabaseTransaction: (version) => {
              if (version === 45)
                throw new Error("injected stop before migration 45");
            },
          }),
        ).rejects.toThrow(/injected stop before migration 45/u);
        expect(readUserVersion(args.database)).toBe(44);
        expect(
          readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
        ).toMatchObject({ kind: "Prepared", step: "0045" });

        await expect(
          runPreparedUpgrade(resumeArgs, {
            afterDatabaseCommit: (version) => {
              if (version === 45)
                throw new Error("injected stop after migration 45 commit");
            },
          }),
        ).rejects.toThrow(/injected stop after migration 45 commit/u);
        expect(readUserVersion(args.database)).toBe(45);
        expect(
          readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
        ).toMatchObject({ kind: "Prepared", step: "0045" });

        await runPreparedUpgrade(resumeArgs);
        expect(readUserVersion(args.database)).toBe(54);
        const beforeNoOpDigest = logicalSqliteDigest(args.database);
        let version54ReopenedNoOp = false;
        await runPreparedUpgrade(resumeArgs, {
          afterVersion54NoOpVerification: () => {
            version54ReopenedNoOp = true;
          },
        });
        expect(version54ReopenedNoOp).toBe(true);
        expect(logicalSqliteDigest(args.database)).toBe(beforeNoOpDigest);
        const completeHeadLength = readSchemaUpgradeManifest(args.copyManifest)
          .records.length;
        const expectRefusalWithoutTargetChange = async (
          altered: SchemaUpgradeArguments,
          message: RegExp,
          hooks: SchemaUpgradeTestHooks = {},
        ) => {
          const targetDigest = logicalSqliteDigest(args.database);
          await expect(runPreparedUpgrade(altered, hooks)).rejects.toThrow(
            message,
          );
          expect(readUserVersion(args.database)).toBe(54);
          expect(logicalSqliteDigest(args.database)).toBe(targetDigest);
          expect(
            readSchemaUpgradeManifest(args.copyManifest).records,
          ).toHaveLength(completeHeadLength);
        };
        await expectRefusalWithoutTargetChange(
          {
            ...resumeArgs,
            sourceDatabase: join(directory, "missing-source.sqlite"),
          },
          /canonical|path|identity/u,
        );
        await expectRefusalWithoutTargetChange(
          {
            ...resumeArgs,
            p39ReportDatabase: join(directory, "missing-report.sqlite"),
          },
          /canonical|path|identity/u,
        );
        await expectRefusalWithoutTargetChange(
          {
            ...resumeArgs,
            copyManifest: join(directory, "missing-manifest.jsonl"),
          },
          /canonical|path|identity/u,
        );

        const deletedReportPath = join(directory, "report-deleted.sqlite");
        let reportDeleted = false;
        try {
          await expectRefusalWithoutTargetChange(
            resumeArgs,
            /report|identity|path/u,
            {
              beforeMaintenancePermitAcquire: () => {
                reportDeleted = true;
                moveSqliteFiles(args.p39ReportDatabase, deletedReportPath);
              },
            },
          );
        } finally {
          if (reportDeleted) {
            moveSqliteFiles(deletedReportPath, args.p39ReportDatabase);
          }
        }

        const replacementReportPath = join(
          directory,
          "report-replacement.sqlite",
        );
        const displacedReportPath = join(directory, "report-original.sqlite");
        await copyReportSidecar(args.p39ReportDatabase, replacementReportPath);
        let reportReplaced = false;
        try {
          await expectRefusalWithoutTargetChange(
            resumeArgs,
            /report|identity|path/u,
            {
              beforeMaintenancePermitAcquire: () => {
                reportReplaced = true;
                moveSqliteFiles(args.p39ReportDatabase, displacedReportPath);
                moveSqliteFiles(replacementReportPath, args.p39ReportDatabase);
              },
            },
          );
        } finally {
          if (reportReplaced) {
            moveSqliteFiles(args.p39ReportDatabase, replacementReportPath);
            moveSqliteFiles(displacedReportPath, args.p39ReportDatabase);
          }
        }

        const originalVersion = new DatabaseSync(args.database);
        try {
          originalVersion.exec("PRAGMA user_version = 41");
        } finally {
          originalVersion.close();
        }
        await expect(runPreparedUpgrade(resumeArgs)).rejects.toThrow(
          /target|boundary|prefix|version|duplicate column/u,
        );
        const restoredVersion = new DatabaseSync(args.database);
        try {
          restoredVersion.exec("PRAGMA user_version = 50");
        } finally {
          restoredVersion.close();
        }
        expect(readUserVersion(args.database)).toBe(50);

        const targetBeforeTamper = logicalSqliteDigest(args.database);
        const tamperTarget = new DatabaseSync(args.database);
        try {
          tamperTarget.exec("CREATE TABLE schema_upgrade_tamper(value TEXT)");
        } finally {
          tamperTarget.close();
        }
        await expect(runPreparedUpgrade(resumeArgs)).rejects.toThrow(
          /content|boundary|manifest/u,
        );
        const restoreTarget = new DatabaseSync(args.database);
        try {
          restoreTarget.exec("DROP TABLE schema_upgrade_tamper");
        } finally {
          restoreTarget.close();
        }
        expect(logicalSqliteDigest(args.database)).toBe(targetBeforeTamper);

        const badReport = new DatabaseSync(args.p39ReportDatabase);
        try {
          badReport
            .prepare(
              "INSERT INTO p39_migration_block_reports(report_key,content_hash,report_json) VALUES(?,?,?)",
            )
            .run("a".repeat(64), "b".repeat(64), "{}");
        } finally {
          badReport.close();
        }
        await expectRefusalWithoutTargetChange(
          resumeArgs,
          /report|hash|schema/u,
        );

        const manifestText = readFileSync(args.copyManifest, "utf8");
        const lines = manifestText.trimEnd().split("\n");
        const last = lines.at(-1);
        if (last === undefined) throw new Error("manifest unexpectedly empty");
        const finalEnvelope = JSON.parse(last) as { hash: string };
        finalEnvelope.hash = `${finalEnvelope.hash[0] === "0" ? "1" : "0"}${finalEnvelope.hash.slice(1)}`;
        lines[lines.length - 1] = JSON.stringify(finalEnvelope);
        writeFileSync(args.copyManifest, `${lines.join("\n")}\n`);
        await expect(runPreparedUpgrade(resumeArgs)).rejects.toThrow(
          /hash chain/u,
        );
        expect(readUserVersion(args.sourceDatabase as string)).toBe(38);
        expect(logicalSqliteDigest(args.sourceDatabase as string)).toBe(
          sourceDigest,
        );
      } finally {
        removeP39PrivateTestDirectory(directory);
      }
    },
    CLI_PROCESS_TIMEOUT_MS,
  );

  it(
    "serializes two competing CLI resumes at the prepared P54 commit boundary",
    async () => {
      const directory = makeP39PrivateTestDirectory(
        process.cwd(),
        ".schema-upgrade-race-",
      );
      const args = copyArgs(directory);
      let failure: unknown;
      try {
        await seedVersion38(args.sourceDatabase as string);
        let copyFailurePhase: string | undefined;
        try {
          await runSchemaUpgrade(args, {
            onMaintenanceFailure: (phase) => {
              copyFailurePhase = phase;
            },
          });
        } catch (cause) {
          throw new Error(
            `copy setup failed during ${copyFailurePhase ?? "pre-maintenance"}: ${formatSchemaUpgradeCliFailure(cause)}`,
          );
        }
        const complete = readSchemaUpgradeManifest(args.copyManifest);
        const preparedIndex = complete.records.findIndex(
          ({ record }) => record.kind === "Prepared" && record.step === "0054",
        );
        if (preparedIndex < 0)
          throw new Error("P54 Prepared boundary was not recorded");
        const lines = readFileSync(args.copyManifest, "utf8")
          .trimEnd()
          .split("\n");
        const pendingManifest = `${lines.slice(0, preparedIndex + 1).join("\n")}\n`;
        writeFileSync(args.copyManifest, pendingManifest);
        const baseline = await resumeInChildProcess(args);
        expect(baseline.code, baseline.output).toBe(0);
        expect(
          readSchemaUpgradeManifest(args.copyManifest).records.filter(
            ({ record }) =>
              record.kind === "Committed" && record.step === "0054",
          ),
        ).toHaveLength(1);

        writeFileSync(args.copyManifest, pendingManifest);
        const before = preparedIndex + 1;
        const concurrent = await Promise.all([
          resumeInChildProcess(args),
          resumeInChildProcess(args),
        ]);
        expect(
          concurrent.map(({ code }) => code),
          JSON.stringify(concurrent.map(({ output }) => output)),
        ).toEqual([0, 0]);
        expect(readUserVersion(args.database)).toBe(54);
        const completed = readSchemaUpgradeManifest(args.copyManifest);
        expect(
          completed.records.filter(
            ({ record }) =>
              record.kind === "Committed" && record.step === "0054",
          ),
        ).toHaveLength(1);
        expect(completed.records.length).toBe(before + 1);
      } catch (cause) {
        failure = cause;
      }
      try {
        removeP39PrivateTestDirectory(directory);
      } catch (cleanupCause) {
        failure =
          failure === undefined
            ? cleanupCause
            : new AggregateError(
                [failure, cleanupCause],
                "CLI resume race and fixture cleanup both failed",
              );
      }
      if (failure !== undefined) throw failure;
    },
    CLI_PROCESS_TIMEOUT_MS,
  );

  it("creates a P54 fresh target without accepting a source", async () => {
    const directory = makeP39PrivateTestDirectory(
      process.cwd(),
      ".schema-upgrade-fresh-",
    );
    const args: SchemaUpgradeArguments = {
      mode: "fresh",
      database: join(directory, "fresh.sqlite"),
      p39ReportDatabase: join(directory, "fresh-report.sqlite"),
      copyManifest: join(directory, "fresh-manifest.jsonl"),
    };
    try {
      let reopenedEvidence:
        | { readonly userVersion: 54; readonly reopenedReadOnly: true }
        | undefined;
      await runSchemaUpgrade(args, {
        afterVersion54NoOpVerification: (evidence) => {
          reopenedEvidence = evidence;
        },
      });
      expect(reopenedEvidence).toEqual({
        userVersion: 54,
        reopenedReadOnly: true,
      });
      expect(readUserVersion(args.database)).toBe(54);
      expect(readSchemaUpgradeManifest(args.copyManifest).header.mode).toBe(
        "fresh",
      );
      expect(
        readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
      ).toMatchObject({
        kind: "Committed",
        step: "0054",
        fromVersion: 53,
        toVersion: 54,
      });
    } finally {
      removeP39PrivateTestDirectory(directory);
    }
  }, 600_000);

  it("upgrades a disposable schema-50 copy through 0054 and resumes as an exact no-op", async () => {
    const directory = makeP39PrivateTestDirectory(
      process.cwd(),
      ".schema-upgrade-50-to-51-",
    );
    const sourceFixture = await createSchema50TestDatabase();
    const args = schema48CopyArgs(directory, sourceFixture.databaseFilename);
    try {
      expect(readUserVersion(sourceFixture.databaseFilename)).toBe(50);
      const committedVersions: number[] = [];
      const preparedVersions: number[] = [];
      await runSchemaUpgrade(args, {
        afterDatabaseCommit: (version) => committedVersions.push(version),
        beforeDatabaseTransaction: (version) => preparedVersions.push(version),
      });
      expect(
        readUserVersion(args.database),
        `prepared=${JSON.stringify(preparedVersions)}; committed=${JSON.stringify(committedVersions)}; records=${JSON.stringify(readSchemaUpgradeManifest(args.copyManifest).records.map(({ record }) => record))}`,
      ).toBe(54);
      expect(readUserVersion(sourceFixture.databaseFilename)).toBe(50);
      const committed = readSchemaUpgradeManifest(args.copyManifest).records.at(
        -1,
      )?.record;
      expect(committed).toMatchObject({
        kind: "Committed",
        step: "0054",
        fromVersion: 53,
        toVersion: 54,
      });
      const digest = logicalSqliteDigest(args.database);
      await runSchemaUpgrade({ ...args, mode: "resume-copy" });
      expect(readUserVersion(args.database)).toBe(54);
      expect(logicalSqliteDigest(args.database)).toBe(digest);
      expect(
        readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
      ).toMatchObject({ kind: "Committed", step: "0054" });
    } finally {
      sourceFixture.cleanup();
      removeP39PrivateTestDirectory(directory);
    }
  }, 600_000);

  it("upgrades an exact schema-48 copy through pinned 0049–0054 prefixes", async () => {
    const directory = makeP39PrivateTestDirectory(
      process.cwd(),
      ".schema-upgrade-48-to-50-",
    );
    const sourceFixture = await createHistoricalSchemaClone(48);
    const args = schema48CopyArgs(directory, sourceFixture.databaseFilename);
    try {
      expect(sqliteSchemaSignature(sourceFixture.databaseFilename)).toBe(
        "f4333689c6f854362a985bd95153e9141f9c6ed443289a224185fe0a30e95a50",
      );
      expect(descriptorHashesThrough(50).slice(-2)).toEqual([
        "b8145e3a49f1de191544bd2598eea250910f2d54f9f56e497dd9e49e03cf22dc",
        "9f1bd851506ca468098c56f2efd6db3b277f443f1ed65ea910b3370db45bdf98",
      ]);
      const committedVersions: number[] = [];
      await runSchemaUpgrade(args, {
        afterDatabaseCommit: (version) => committedVersions.push(version),
      });
      expect(committedVersions.slice(-6)).toEqual([49, 50, 51, 52, 53, 54]);
      expect(readUserVersion(sourceFixture.databaseFilename)).toBe(48);
      expect(readUserVersion(args.database)).toBe(54);
      expect(sqliteSchemaSignature(args.database)).toBe(
        "2592a3628003c1afe9cb394f3b52d2085ce866e5a52da226c67bd07878712711",
      );
      const target = new DatabaseSync(args.database, { readOnly: true });
      try {
        expect(target.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        target.close();
      }
      const records = readSchemaUpgradeManifest(args.copyManifest).records.map(
        ({ record }) => record,
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          kind: "Committed",
          step: "0049",
          fromVersion: 48,
          toVersion: 49,
        }),
      );
      expect(records.at(-1)).toMatchObject({
        kind: "Committed",
        step: "0054",
        fromVersion: 53,
        toVersion: 54,
      });
    } finally {
      sourceFixture.cleanup();
      removeP39PrivateTestDirectory(directory);
    }
  }, 600_000);

  it.each([
    [
      "unexpected schema object",
      "CREATE TABLE unaccepted_schema48_object(value TEXT)",
    ],
    [
      "missing P43 object",
      "PRAGMA foreign_keys = OFF; DROP TABLE work_blockers",
    ],
    [
      "changed P44 trigger",
      "DROP TRIGGER tool_invocations_observation_insert_guard",
    ],
  ])(
    "rejects schema-48 prefix corruption before copying (%s)",
    async (_caseName, mutation) => {
      const directory = makeP39PrivateTestDirectory(
        process.cwd(),
        ".schema-upgrade-48-corrupt-",
      );
      const sourceFixture = await createHistoricalSchemaClone(48);
      const args = schema48CopyArgs(directory, sourceFixture.databaseFilename);
      try {
        const before = new DatabaseSync(sourceFixture.databaseFilename);
        try {
          before.exec(mutation);
        } finally {
          before.close();
        }
        const sourceDigest = logicalSqliteDigest(
          sourceFixture.databaseFilename,
        );
        await expect(runSchemaUpgrade(args)).rejects.toThrow(
          /schema 48 source does not match the trusted cumulative descriptor prefix/u,
        );
        expect(readUserVersion(sourceFixture.databaseFilename)).toBe(48);
        expect(logicalSqliteDigest(sourceFixture.databaseFilename)).toBe(
          sourceDigest,
        );
        expect(existsSync(args.database)).toBe(false);
      } finally {
        sourceFixture.cleanup();
        removeP39PrivateTestDirectory(directory);
      }
    },
    600_000,
  );

  it("refuses a schema-48 copy with an unreconciled NULL grant revision before persistent migration writes", async () => {
    const directory = makeP39PrivateTestDirectory(
      process.cwd(),
      ".schema-upgrade-48-null-grant-",
    );
    const sourceFixture = await createHistoricalSchemaClone(48);
    const args = schema48CopyArgs(directory, sourceFixture.databaseFilename);
    try {
      const seed = new DatabaseSync(sourceFixture.databaseFilename);
      try {
        seed
          .prepare(
            `INSERT INTO permission_grants (
             permission_grant_id, project_id, scope, issuer, lifetime,
             state, subject_kind, subject_ref, capability, revision
           ) VALUES ('pgr_schema48_invalid_null', 'prj_migration_preflight',
             'SandboxPolicy', 'user:test', 'PT1H', 'Active',
             'WorkspaceAgent', 'ws_bound', 'SandboxPolicy', NULL)`,
          )
          .run();
      } finally {
        seed.close();
      }
      const sourceDigest = logicalSqliteDigest(sourceFixture.databaseFilename);
      await expect(runSchemaUpgrade(args)).rejects.toThrow();
      expect(readUserVersion(sourceFixture.databaseFilename)).toBe(48);
      expect(logicalSqliteDigest(sourceFixture.databaseFilename)).toBe(
        sourceDigest,
      );
      expect(readUserVersion(args.database)).toBe(48);
      const target = new DatabaseSync(args.database, { readOnly: true });
      try {
        expect(
          target
            .prepare(
              "SELECT name FROM sqlite_schema WHERE name = 'sandbox_policy_decisions'",
            )
            .all(),
        ).toEqual([]);
        expect(
          target
            .prepare(
              "SELECT revision FROM permission_grants WHERE permission_grant_id = 'pgr_schema48_invalid_null'",
            )
            .get(),
        ).toEqual({ revision: null });
      } finally {
        target.close();
      }
    } finally {
      sourceFixture.cleanup();
      removeP39PrivateTestDirectory(directory);
    }
  }, 600_000);

  it("rejects a schema-49 source whose exact 0049 signature is altered before 0050", async () => {
    const directory = makeP39PrivateTestDirectory(
      process.cwd(),
      ".schema-upgrade-49-corrupt-",
    );
    const sourceFixture = await createHistoricalSchemaClone(48);
    const args = schema48CopyArgs(directory, sourceFixture.databaseFilename);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            runMigrations([P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_MIGRATION], {
              allowOfflineOnly: true,
            }),
            layer({ filename: sourceFixture.databaseFilename }),
          ),
        ),
      );
      const corrupt = new DatabaseSync(sourceFixture.databaseFilename);
      try {
        corrupt.exec("DROP TRIGGER sandbox_policy_decisions_no_update");
      } finally {
        corrupt.close();
      }
      expect(readUserVersion(sourceFixture.databaseFilename)).toBe(49);
      await expect(runSchemaUpgrade(args)).rejects.toThrow(
        /schema 49 source does not match the trusted cumulative descriptor prefix/u,
      );
      expect(readUserVersion(sourceFixture.databaseFilename)).toBe(49);
      expect(existsSync(args.database)).toBe(false);
    } finally {
      sourceFixture.cleanup();
      removeP39PrivateTestDirectory(directory);
    }
  }, 600_000);

  exhaustiveIt.each(["before commit", "after commit"])(
    "[exhaustive] rolls back or resumes migration 0049 %s and completes schema 54",
    async (boundary) => {
      const directory = makeP39PrivateTestDirectory(
        process.cwd(),
        ".schema-upgrade-49-reentry-",
      );
      const sourceFixture = await createHistoricalSchemaClone(48);
      const args = schema48CopyArgs(directory, sourceFixture.databaseFilename);
      try {
        await expect(
          runSchemaUpgrade(args, {
            ...(boundary === "before commit"
              ? {
                  beforeDatabaseTransaction: (version) => {
                    if (version === 49)
                      throw new Error("stop before 0049 commit");
                  },
                }
              : {
                  afterDatabaseCommit: (version) => {
                    if (version === 49)
                      throw new Error("stop after 0049 commit");
                  },
                }),
          }),
        ).rejects.toThrow(
          new RegExp(
            `stop ${boundary === "before commit" ? "before" : "after"} 0049 commit`,
            "u",
          ),
        );
        expect(readUserVersion(args.database)).toBe(
          boundary === "before commit" ? 48 : 49,
        );
        await runSchemaUpgrade({ ...args, mode: "resume-copy" });
        expect(readUserVersion(args.database)).toBe(54);
        expect(readUserVersion(sourceFixture.databaseFilename)).toBe(48);
      } finally {
        sourceFixture.cleanup();
        removeP39PrivateTestDirectory(directory);
      }
    },
    600_000,
  );

  it("upgrades an exact schema-51 source through P52 backfill and accepts schema-54 exact no-op", async () => {
    const directory = makeP39PrivateTestDirectory(
      process.cwd(),
      ".schema-upgrade-50-noop-",
    );
    const sourceFixture = await createSchema51TestDatabase();
    const args = schema48CopyArgs(directory, sourceFixture.databaseFilename);
    try {
      expect(readUserVersion(sourceFixture.databaseFilename)).toBe(51);
      seedSchema51WorkForP52OfflineQualification(
        sourceFixture.databaseFilename,
      );
      const sourceDigest = logicalSqliteDigest(sourceFixture.databaseFilename);
      let reopened = false;
      await expect(
        runSchemaUpgrade(args, {
          beforeDatabaseTransaction: (version) => {
            if (version === 52) throw new Error("stop before P52 commit");
          },
        }),
      ).rejects.toThrow("stop before P52 commit");
      expect(readUserVersion(args.database)).toBe(51);
      expect(
        readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
      ).toMatchObject({ kind: "Prepared", step: "0052", fromVersion: 51 });
      await expect(
        runSchemaUpgrade(
          { ...args, mode: "resume-copy" },
          {
            afterDatabaseCommit: (version) => {
              if (version === 52) throw new Error("stop after P52 commit");
            },
          },
        ),
      ).rejects.toThrow("stop after P52 commit");
      expect(readUserVersion(args.database)).toBe(52);
      expect(
        readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
      ).toMatchObject({ kind: "Prepared", step: "0052", fromVersion: 51 });
      await runSchemaUpgrade(
        { ...args, mode: "resume-copy" },
        {
          afterVersion54NoOpVerification: (evidence) => {
            reopened = evidence.userVersion === 54 && evidence.reopenedReadOnly;
          },
        },
      );
      expect(reopened).toBe(true);
      expect(readUserVersion(sourceFixture.databaseFilename)).toBe(51);
      expect(logicalSqliteDigest(sourceFixture.databaseFilename)).toBe(
        sourceDigest,
      );
      expect(readUserVersion(args.database)).toBe(54);
      const target = new DatabaseSync(args.database, { readOnly: true });
      try {
        const backfill = target
          .prepare(
            `SELECT work_id, work_revision, contract_json, contract_sha256,
                    record_kind, source_command_id, actor, provenance_json,
                    recorded_at
               FROM work_contract_revisions`,
          )
          .get() as Record<string, unknown> | undefined;
        expect(backfill).toMatchObject({
          work_id: "wrk_p52_offline",
          work_revision: 4,
          record_kind: "LegacyCurrentSnapshot",
          source_command_id: null,
          actor: null,
          recorded_at: "t4",
        });
        expect(JSON.parse(String(backfill?.contract_json))).toMatchObject({
          objective: "offline legacy objective",
          verificationMission: {
            goal: "offline legacy mission",
          },
        });
        expect(String(backfill?.contract_sha256)).toMatch(/^[0-9a-f]{64}$/u);
        expect(target.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        target.close();
      }
      const targetDigest = logicalSqliteDigest(args.database);
      await runSchemaUpgrade({ ...args, mode: "resume-copy" });
      expect(readUserVersion(args.database)).toBe(54);
      expect(logicalSqliteDigest(args.database)).toBe(targetDigest);

      const schema54Source = await createCurrentSchemaTestDatabase();
      try {
        const schema54Args = {
          ...schema48CopyArgs(directory, schema54Source.databaseFilename),
          database: join(directory, "schema54-source-copy.sqlite"),
          p39ReportDatabase: join(directory, "schema54-source-report.sqlite"),
          copyManifest: join(directory, "schema54-source-manifest.jsonl"),
        };
        expect(readUserVersion(schema54Source.databaseFilename)).toBe(54);
        const source54Digest = logicalSqliteDigest(
          schema54Source.databaseFilename,
        );
        await runSchemaUpgrade(schema54Args);
        expect(readUserVersion(schema54Args.database)).toBe(54);
        expect(logicalSqliteDigest(schema54Args.database)).toBe(source54Digest);
        expect(
          readSchemaUpgradeManifest(schema54Args.copyManifest).header
            .sourceUserVersion,
        ).toBe(54);
        expect(
          readSchemaUpgradeManifest(schema54Args.copyManifest).records.some(
            ({ record }) => record.kind === "Prepared",
          ),
        ).toBe(false);
      } finally {
        schema54Source.cleanup();
      }
    } finally {
      sourceFixture.cleanup();
      removeP39PrivateTestDirectory(directory);
    }
  }, 600_000);

  it("upgrades an exact disposable schema44 copy through offline migrations 0045–0054", async () => {
    const directory = makeP39PrivateTestDirectory(
      process.cwd(),
      ".schema-upgrade-44-to-48-",
    );
    const sourceFixture = await createHistoricalSchemaClone(44);
    const args: SchemaUpgradeArguments = {
      mode: "copy",
      sourceDatabase: sourceFixture.databaseFilename,
      database: join(directory, "schema48-copy.sqlite"),
      p39ReportDatabase: join(directory, "schema48-p39-report.sqlite"),
      copyManifest: join(directory, "schema48-copy-manifest.jsonl"),
    };
    try {
      const sourceDigest = logicalSqliteDigest(sourceFixture.databaseFilename);
      const sourcePrefix = prefixSignature(
        sourceFixture.databaseFilename,
        44,
        descriptorHashesThrough(44),
      );
      const sourceBefore = {
        userVersion: readUserVersion(sourceFixture.databaseFilename),
        digest: sourceDigest,
        prefix: sourcePrefix,
      };
      expect(sqliteSchemaSignature(sourceFixture.databaseFilename)).toBe(
        "3cbae01c8835a1b4e40d62660725f15f746b04f06e2b08aca94eedc66c9d6ce7",
      );
      await runSchemaUpgrade(args);
      expect(readUserVersion(args.database)).toBe(54);
      expect(readUserVersion(sourceFixture.databaseFilename)).toBe(44);
      expect(logicalSqliteDigest(sourceFixture.databaseFilename)).toBe(
        sourceBefore.digest,
      );
      const target = new DatabaseSync(args.database, { readOnly: true });
      try {
        expect(target.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        const inboxColumns = target
          .prepare("PRAGMA table_info(inbox_entries)")
          .all() as Array<{ name: string }>;
        expect(inboxColumns.map(({ name }) => name)).toContain("revision");
        expect(inboxColumns.map(({ name }) => name)).toContain("updated_at");
      } finally {
        target.close();
      }
      const committed = readSchemaUpgradeManifest(args.copyManifest).records.at(
        -1,
      )?.record;
      expect(committed).toMatchObject({
        kind: "Committed",
        step: "0054",
        fromVersion: 53,
        toVersion: 54,
      });
      expect(
        readSchemaUpgradeManifest(args.copyManifest).records.some(
          ({ record }) =>
            record.kind === "Committed" &&
            record.step === "0047" &&
            record.fromVersion === 46 &&
            record.toVersion === 47,
        ),
      ).toBe(true);
      expect(
        readSchemaUpgradeManifest(args.copyManifest).records.some(
          ({ record }) =>
            record.kind === "Committed" &&
            record.step === "0046" &&
            record.fromVersion === 45 &&
            record.toVersion === 46,
        ),
      ).toBe(true);
      console.info(
        `P45 disposable source fingerprint: user_version=${sourceBefore.userVersion} digest=${sourceBefore.digest} prefix=${sourceBefore.prefix}`,
      );
    } finally {
      sourceFixture.cleanup();
      removeP39PrivateTestDirectory(directory);
    }
  }, 600_000);

  it("upgrades an exact disposable schema46 copy through offline migrations 0047–0054", async () => {
    const directory = makeP39PrivateTestDirectory(
      process.cwd(),
      ".schema-upgrade-46-to-48-",
    );
    const sourceFixture = await createHistoricalSchemaClone(46);
    const args: SchemaUpgradeArguments = {
      mode: "copy",
      sourceDatabase: sourceFixture.databaseFilename,
      database: join(directory, "schema48-copy.sqlite"),
      p39ReportDatabase: join(directory, "schema48-p39-report.sqlite"),
      copyManifest: join(directory, "schema48-copy-manifest.jsonl"),
    };
    try {
      const sourceDigest = logicalSqliteDigest(sourceFixture.databaseFilename);
      const sourcePrefix = prefixSignature(
        sourceFixture.databaseFilename,
        46,
        descriptorHashesThrough(46),
      );
      await runSchemaUpgrade(args);
      expect(readUserVersion(args.database)).toBe(54);
      expect(readUserVersion(sourceFixture.databaseFilename)).toBe(46);
      expect(logicalSqliteDigest(sourceFixture.databaseFilename)).toBe(
        sourceDigest,
      );
      expect(
        prefixSignature(
          sourceFixture.databaseFilename,
          46,
          descriptorHashesThrough(46),
        ),
      ).toBe(sourcePrefix);
      expect(
        readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
      ).toMatchObject({
        kind: "Committed",
        step: "0054",
        fromVersion: 53,
        toVersion: 54,
      });
    } finally {
      sourceFixture.cleanup();
      removeP39PrivateTestDirectory(directory);
    }
  }, 600_000);

  it("upgrades an exact disposable schema47 copy through offline migrations 0048–0054 and resumes as a no-op", async () => {
    const directory = makeP39PrivateTestDirectory(
      process.cwd(),
      ".schema-upgrade-47-to-48-",
    );
    const sourceFixture = await createHistoricalSchemaClone(47);
    const args: SchemaUpgradeArguments = {
      mode: "copy",
      sourceDatabase: sourceFixture.databaseFilename,
      database: join(directory, "schema48-copy.sqlite"),
      p39ReportDatabase: join(directory, "schema48-p39-report.sqlite"),
      copyManifest: join(directory, "schema48-copy-manifest.jsonl"),
    };
    try {
      const sourceDigest = logicalSqliteDigest(sourceFixture.databaseFilename);
      const sourcePrefix = prefixSignature(
        sourceFixture.databaseFilename,
        47,
        descriptorHashesThrough(47),
      );
      await runSchemaUpgrade(args);
      expect(readUserVersion(args.database)).toBe(54);
      expect(readUserVersion(sourceFixture.databaseFilename)).toBe(47);
      expect(logicalSqliteDigest(sourceFixture.databaseFilename)).toBe(
        sourceDigest,
      );
      expect(
        prefixSignature(
          sourceFixture.databaseFilename,
          47,
          descriptorHashesThrough(47),
        ),
      ).toBe(sourcePrefix);
      expect(
        readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
      ).toMatchObject({
        kind: "Committed",
        step: "0054",
        fromVersion: 53,
        toVersion: 54,
      });
      const targetDigest = logicalSqliteDigest(args.database);
      await runSchemaUpgrade({ ...args, mode: "resume-copy" });
      expect(logicalSqliteDigest(args.database)).toBe(targetDigest);
      expect(readUserVersion(args.database)).toBe(54);
    } finally {
      sourceFixture.cleanup();
      removeP39PrivateTestDirectory(directory);
    }
  }, 600_000);

  exhaustiveIt(
    "[exhaustive] upgrades an exact disposable schema45 copy through offline migrations 0046–0054",
    async () => {
      const directory = makeP39PrivateTestDirectory(
        process.cwd(),
        ".schema-upgrade-45-to-48-",
      );
      const sourceFixture = await createHistoricalSchemaClone(45);
      const args: SchemaUpgradeArguments = {
        mode: "copy",
        sourceDatabase: sourceFixture.databaseFilename,
        database: join(directory, "schema48-copy.sqlite"),
        p39ReportDatabase: join(directory, "schema48-p39-report.sqlite"),
        copyManifest: join(directory, "schema48-copy-manifest.jsonl"),
      };
      try {
        const sourceDigest = logicalSqliteDigest(
          sourceFixture.databaseFilename,
        );
        expect(sqliteSchemaSignature(sourceFixture.databaseFilename)).toBe(
          "38c6e9348dab9dbbea21b92b2b6a0bd7b92d9a66cbda404753ac64b526a2e938",
        );
        const sourcePrefix = prefixSignature(
          sourceFixture.databaseFilename,
          45,
          descriptorHashesThrough(45),
        );
        await runSchemaUpgrade(args);
        expect(readUserVersion(args.database)).toBe(54);
        expect(readUserVersion(sourceFixture.databaseFilename)).toBe(45);
        expect(logicalSqliteDigest(sourceFixture.databaseFilename)).toBe(
          sourceDigest,
        );
        expect(
          prefixSignature(
            sourceFixture.databaseFilename,
            45,
            descriptorHashesThrough(45),
          ),
        ).toBe(sourcePrefix);
        const target = new DatabaseSync(args.database, { readOnly: true });
        try {
          expect(target.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
          const columns = target
            .prepare("PRAGMA table_info(verifications)")
            .all() as Array<{ name: string }>;
          expect(columns.map(({ name }) => name)).toContain("criteria_results");
          expect(columns.map(({ name }) => name)).toContain("snapshot_status");
          const guards = target
            .prepare(
              `SELECT name FROM sqlite_master WHERE type='trigger'
               AND name IN ('verifications_snapshot_shape_insert',
                            'verifications_snapshot_shape_update')`,
            )
            .all();
          expect(guards).toHaveLength(2);
        } finally {
          target.close();
        }
        expect(
          readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
        ).toMatchObject({
          kind: "Committed",
          step: "0054",
          fromVersion: 53,
          toVersion: 54,
        });
        expect(
          readSchemaUpgradeManifest(args.copyManifest).records.some(
            ({ record }) =>
              record.kind === "Committed" &&
              record.step === "0046" &&
              record.fromVersion === 45 &&
              record.toVersion === 46,
          ),
        ).toBe(true);
      } finally {
        sourceFixture.cleanup();
        removeP39PrivateTestDirectory(directory);
      }
    },
    600_000,
  );

  exhaustiveIt(
    "[exhaustive] closes and read-only reopens a copied target before successful return",
    async () => {
      const directory = makeP39PrivateTestDirectory(
        process.cwd(),
        ".schema-upgrade-copy-reopen-",
      );
      const args = copyArgs(directory);
      try {
        await seedVersion38(args.sourceDatabase as string);
        let reopenedEvidence:
          | { readonly userVersion: 54; readonly reopenedReadOnly: true }
          | undefined;
        await runSchemaUpgrade(args, {
          ...(p38PreviewTemplate === undefined
            ? {}
            : { previewTemplate: p38PreviewTemplate }),
          afterVersion54NoOpVerification: (evidence) => {
            reopenedEvidence = evidence;
          },
        });
        expect(reopenedEvidence).toEqual({
          userVersion: 54,
          reopenedReadOnly: true,
        });
        expect(readUserVersion(args.database)).toBe(54);
        expect(readUserVersion(args.sourceDatabase as string)).toBe(38);
        expect(
          readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
        ).toMatchObject({
          kind: "Committed",
          step: "0054",
          fromVersion: 53,
          toVersion: 54,
        });
      } finally {
        removeP39PrivateTestDirectory(directory);
      }
    },
    1_200_000,
  );

  exhaustiveIt(
    "[exhaustive] makes a P39-blocked copy permanently audit-only and refuses every resume",
    async () => {
      const directory = makeP39PrivateTestDirectory(
        process.cwd(),
        ".schema-upgrade-isolated-",
      );
      const args = copyArgs(directory);
      try {
        await seedVersion38(args.sourceDatabase as string);
        const source = new DatabaseSync(args.sourceDatabase as string);
        try {
          source.exec("PRAGMA foreign_keys = OFF");
          source
            .prepare(
              `INSERT INTO tool_invocations (
             invocation_id, execution_id, workspace_id, tool_name, tool_version,
             side_effect_semantics, arguments_json, resolved_regions_json,
             approval_id, effect_admission_state, intent_at, settled_at,
             settlement_kind, settlement_json, result_ref
           ) VALUES (?, 'exe_legacy_orphan', 'ws_legacy_orphan', 'read', '1',
                     'ReadOnly', '{}', '[]', NULL, 'NotAdmitted', 't1', NULL,
                     NULL, NULL, NULL)`,
            )
            .run("tin_cli_blocker");
        } finally {
          source.close();
        }
        const sourceDigest = logicalSqliteDigest(args.sourceDatabase as string);
        await expect(runSchemaUpgrade(args)).rejects.toThrow(
          /permanently isolated/u,
        );
        expect(readUserVersion(args.database)).toBe(38);
        expect(logicalSqliteDigest(args.sourceDatabase as string)).toBe(
          sourceDigest,
        );
        const reportRows = verifyP39ReportEvidence(
          args.p39ReportDatabase,
          existingPathIdentity(args.p39ReportDatabase),
        );
        expect(reportRows).toHaveLength(1);
        expect(
          readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record
            .kind,
        ).toBe("Isolated");
        const targetDigest = logicalSqliteDigest(args.database);
        await expect(
          runSchemaUpgrade({ ...args, mode: "resume-copy" }),
        ).rejects.toThrow(/permanently isolates/u);
        expect(readUserVersion(args.database)).toBe(38);
        expect(logicalSqliteDigest(args.database)).toBe(targetDigest);
      } finally {
        removeP39PrivateTestDirectory(directory);
      }
    },
    600_000,
  );

  it("rejects hard-link identities and symlink path components before opening a source", () => {
    const directory = makeP39PrivateTestDirectory(
      process.cwd(),
      ".schema-upgrade-alias-",
    );
    const original = join(directory, "source.sqlite");
    const hardLink = join(directory, "hard-link.sqlite");
    const junctionTarget = join(directory, "junction-target");
    const junction = join(directory, "junction");
    try {
      createP39PrivateTestFile(original);
      linkSync(original, hardLink);
      expect(() => existingPathIdentity(original)).toThrow(
        /identity\/owner\/ACL/u,
      );
      expect(() =>
        assertDistinctPaths([
          [
            "source",
            {
              canonicalPath: original,
              file: { device: "1", fileId: "9" },
            } as SchemaUpgradePathIdentity,
          ],
          [
            "target",
            {
              canonicalPath: hardLink,
              file: { device: "1", fileId: "9" },
            } as SchemaUpgradePathIdentity,
          ],
        ]),
      ).toThrow(/same file/u);
      mkdirSync(junctionTarget);
      createP39PrivateTestFile(join(junctionTarget, "source.sqlite"));
      symlinkSync(
        junctionTarget,
        junction,
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(() =>
        existingPathIdentity(join(junction, "source.sqlite")),
      ).toThrow(/reparse path component/u);
    } finally {
      removeP39PrivateTestDirectory(directory);
    }
  });
});
