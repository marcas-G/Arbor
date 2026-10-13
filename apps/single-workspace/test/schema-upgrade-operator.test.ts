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
  runMigrations,
} from "@arbor/persistence-sqlite";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  createP39PrivateTestFile,
  makeP39PrivateTestDirectory,
  removeP39PrivateTestDirectory,
} from "../../../tests/support/p39-windows-deployment-test.js";
import {
  formatSchemaUpgradeCliFailure,
  parseSchemaUpgradeArguments,
  runSchemaUpgrade,
  type SchemaUpgradeArguments,
  type SchemaUpgradeTestHooks,
} from "../src/schema-upgrade.js";
import {
  assertDistinctPaths,
  existingPathIdentity,
  logicalSqliteDigest,
  readSchemaUpgradeManifest,
  readUserVersion,
  type SchemaUpgradePathIdentity,
  SchemaUpgradeRefusal,
  verifyP39ReportEvidence,
  writeFullyAndSync,
} from "../src/schema-upgrade-manifest.js";

const CLI_PROCESS_TIMEOUT_MS = 1_200_000;

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

describe("offline P39–P42 schema-upgrade CLI", () => {
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

  it(
    "resumes exact prefixes and rejects provenance tampering",
    async () => {
      const directory = makeP39PrivateTestDirectory(
        process.cwd(),
        ".schema-upgrade-cli-",
      );
      const args = copyArgs(directory);
      const resumeArgs = { ...args, mode: "resume-copy" as const };
      try {
        await seedVersion38(args.sourceDatabase as string);
        const sourceDigest = logicalSqliteDigest(args.sourceDatabase as string);
        await expect(
          runSchemaUpgrade(args, {
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
          runSchemaUpgrade(resumeArgs, {
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
          runSchemaUpgrade(resumeArgs, {
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
          runSchemaUpgrade(resumeArgs, {
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
          runSchemaUpgrade(resumeArgs, {
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
          runSchemaUpgrade(resumeArgs, {
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
          runSchemaUpgrade(resumeArgs, {
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
          runSchemaUpgrade(resumeArgs, {
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

        const beforeNoOpDigest = logicalSqliteDigest(args.database);
        let version42ReopenedNoOp = false;
        await runSchemaUpgrade(resumeArgs, {
          afterVersion42NoOpVerification: () => {
            version42ReopenedNoOp = true;
          },
        });
        expect(version42ReopenedNoOp).toBe(true);
        expect(logicalSqliteDigest(args.database)).toBe(beforeNoOpDigest);
        const completeHeadLength = readSchemaUpgradeManifest(args.copyManifest)
          .records.length;
        const expectRefusalWithoutTargetChange = async (
          altered: SchemaUpgradeArguments,
          message: RegExp,
          hooks: SchemaUpgradeTestHooks = {},
        ) => {
          const targetDigest = logicalSqliteDigest(args.database);
          await expect(runSchemaUpgrade(altered, hooks)).rejects.toThrow(
            message,
          );
          expect(readUserVersion(args.database)).toBe(42);
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
        await expect(runSchemaUpgrade(resumeArgs)).rejects.toThrow(
          /target|boundary|prefix|version|duplicate column/u,
        );
        const restoredVersion = new DatabaseSync(args.database);
        try {
          restoredVersion.exec("PRAGMA user_version = 42");
        } finally {
          restoredVersion.close();
        }
        expect(readUserVersion(args.database)).toBe(42);

        const targetBeforeTamper = logicalSqliteDigest(args.database);
        const tamperTarget = new DatabaseSync(args.database);
        try {
          tamperTarget.exec("CREATE TABLE schema_upgrade_tamper(value TEXT)");
        } finally {
          tamperTarget.close();
        }
        await expect(runSchemaUpgrade(resumeArgs)).rejects.toThrow(
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
        await expect(runSchemaUpgrade(resumeArgs)).rejects.toThrow(
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
    "serializes two competing CLI resume processes on the maintenance permit",
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
          ({ record }) => record.kind === "Prepared" && record.step === "0042",
        );
        if (preparedIndex < 0)
          throw new Error("P42 Prepared boundary was not recorded");
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
              record.kind === "Committed" && record.step === "0042",
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
        expect(readUserVersion(args.database)).toBe(42);
        const completed = readSchemaUpgradeManifest(args.copyManifest);
        expect(
          completed.records.filter(
            ({ record }) =>
              record.kind === "Committed" && record.step === "0042",
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

  it("creates a P42 fresh target without accepting a source", async () => {
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
        | { readonly userVersion: 42; readonly reopenedReadOnly: true }
        | undefined;
      await runSchemaUpgrade(args, {
        afterVersion42NoOpVerification: (evidence) => {
          reopenedEvidence = evidence;
        },
      });
      expect(reopenedEvidence).toEqual({
        userVersion: 42,
        reopenedReadOnly: true,
      });
      expect(readUserVersion(args.database)).toBe(42);
      expect(readSchemaUpgradeManifest(args.copyManifest).header.mode).toBe(
        "fresh",
      );
      expect(
        readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
      ).toMatchObject({ kind: "Committed", step: "0042", toVersion: 42 });
    } finally {
      removeP39PrivateTestDirectory(directory);
    }
  }, 600_000);

  it("closes and read-only reopens a copied target before successful return", async () => {
    const directory = makeP39PrivateTestDirectory(
      process.cwd(),
      ".schema-upgrade-copy-reopen-",
    );
    const args = copyArgs(directory);
    try {
      await seedVersion38(args.sourceDatabase as string);
      let reopenedEvidence:
        | { readonly userVersion: 42; readonly reopenedReadOnly: true }
        | undefined;
      await runSchemaUpgrade(args, {
        afterVersion42NoOpVerification: (evidence) => {
          reopenedEvidence = evidence;
        },
      });
      expect(reopenedEvidence).toEqual({
        userVersion: 42,
        reopenedReadOnly: true,
      });
      expect(readUserVersion(args.database)).toBe(42);
      expect(readUserVersion(args.sourceDatabase as string)).toBe(38);
      expect(
        readSchemaUpgradeManifest(args.copyManifest).records.at(-1)?.record,
      ).toMatchObject({ kind: "Committed", step: "0042", toVersion: 42 });
    } finally {
      removeP39PrivateTestDirectory(directory);
    }
  }, 600_000);

  it("makes a P39-blocked copy permanently audit-only and refuses every resume", async () => {
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
  }, 600_000);

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
