import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  parseSchemaUpgradeArguments,
  runSchemaUpgrade,
  type SchemaUpgradeArguments,
} from "../src/schema-upgrade.js";
import {
  assertDistinctPaths,
  existingPathIdentity,
  logicalSqliteDigest,
  readSchemaUpgradeManifest,
  readUserVersion,
  type SchemaUpgradePathIdentity,
  verifyP39ReportEvidence,
} from "../src/schema-upgrade-manifest.js";

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

describe("offline P39–P42 schema-upgrade CLI", () => {
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

  it("takes a SQLite backup and resumes only from the exact durable prepared boundary", async () => {
    const directory = makeP39PrivateTestDirectory(
      process.cwd(),
      ".schema-upgrade-cli-",
    );
    const args = copyArgs(directory);
    try {
      await seedVersion38(args.sourceDatabase as string);
      const sourceDigest = logicalSqliteDigest(args.sourceDatabase as string);
      await expect(
        runSchemaUpgrade(args, {
          afterDatabaseCommit: (version) => {
            if (version === 40)
              throw new Error("injected stop after database commit");
          },
        }),
      ).rejects.toThrow(/injected stop/u);
      expect(readUserVersion(args.sourceDatabase as string)).toBe(38);
      expect(logicalSqliteDigest(args.sourceDatabase as string)).toBe(
        sourceDigest,
      );
      expect(readUserVersion(args.database)).toBe(40);
      const manifestBeforeResume = readSchemaUpgradeManifest(args.copyManifest);
      expect(manifestBeforeResume.records.at(-1)?.record.kind).toBe("Prepared");

      await runSchemaUpgrade({ ...args, mode: "resume-copy" });
      expect(readUserVersion(args.database)).toBe(42);
      expect(readUserVersion(args.sourceDatabase as string)).toBe(38);
      expect(logicalSqliteDigest(args.sourceDatabase as string)).toBe(
        sourceDigest,
      );
      const completed = readSchemaUpgradeManifest(args.copyManifest);
      expect(completed.records.at(-1)?.record.kind).toBe("Committed");
      const beforeNoOpDigest = logicalSqliteDigest(args.database);
      await runSchemaUpgrade({ ...args, mode: "resume-copy" });
      expect(logicalSqliteDigest(args.database)).toBe(beforeNoOpDigest);
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
