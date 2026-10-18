import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  P39_REPORT_APPLICATION_ID,
  P39_REPORT_USER_VERSION,
  p39WriterLockFilename,
  RetryVerificationOriginRepositoryLive,
  layer as sqliteLayer,
  TransactionPortLive,
} from "@arbor/persistence-sqlite";
import {
  RetryVerificationOriginRepository,
  sha256Hex,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  p39WindowsTestEnvironment,
  removeP39PrivateTestDirectory,
} from "../../../tests/support/p39-windows-deployment-test.js";
import {
  canonicalP6InboxJson,
  deriveTrustedSchema48Signature,
  p6InboxManifestEnvelope,
  p6InboxRebuildUsage,
  parseP6InboxRebuildArguments,
  validateP6InboxManifestText,
} from "../src/p6-inbox-rebuild.js";
import { rejectSqliteArtifactAliases } from "../src/schema-upgrade.js";
import {
  descriptorHashesThrough,
  logicalSqliteDigest,
} from "../src/schema-upgrade-manifest.js";
import { viewQueryFaceWithRetryAvailability } from "../src/transport/composition.js";

describe("P6 Inbox operator rebuild CLI contract", () => {
  it("requires explicit absolute database, P39 sidecar and JSONL manifest paths", () => {
    expect(() => parseP6InboxRebuildArguments([])).toThrow(/required/u);
    expect(() =>
      parseP6InboxRebuildArguments([
        "--database",
        "relative.sqlite",
        "--p39-sidecar",
        "C:\\tmp\\p39.sqlite",
        "--manifest",
        "C:\\tmp\\manifest.jsonl",
      ]),
    ).toThrow(/absolute/u);
    expect(
      parseP6InboxRebuildArguments([
        "--database",
        "C:\\tmp\\primary.sqlite",
        "--p39-sidecar",
        "C:\\tmp\\p39.sqlite",
        "--manifest",
        "C:\\tmp\\manifest.jsonl",
      ]),
    ).toMatchObject({ resume: false });
  });

  it("rejects unknown/repeated options and documents the isolated operator-only flags", () => {
    expect(() =>
      parseP6InboxRebuildArguments([
        "--database",
        "C:\\tmp\\primary.sqlite",
        "--database",
        "C:\\tmp\\other.sqlite",
        "--p39-sidecar",
        "C:\\tmp\\p39.sqlite",
        "--manifest",
        "C:\\tmp\\manifest.jsonl",
      ]),
    ).toThrow(/unsupported/u);
    expect(p6InboxRebuildUsage()).toContain("--p39-sidecar");
    expect(p6InboxRebuildUsage()).toContain("--manifest");
  });

  it("derives the exact version-48 schema signature from trusted descriptors", async () => {
    expect(await deriveTrustedSchema48Signature()).toMatch(/^[0-9a-f]{64}$/u);
  }, 120_000);

  it("validates the canonical manifest hash-chain and rejects tamper/torn records", () => {
    const created = p6InboxManifestEnvelope(0, null, {
      kind: "Created",
      schema: "arbor-p6-unbound-legacy-inbox-rebuild-manifest/v1",
      nonce: "a".repeat(64),
      operation: "rebuild-unbound-legacy-inbox-projections",
      schemaVersion: 48,
      schemaSignature: "b".repeat(64),
      descriptors: descriptorHashesThrough(48),
      initialDatabaseDigest: "c".repeat(64),
    });
    const prepared = p6InboxManifestEnvelope(1, created.hash, {
      kind: "Prepared",
      nonce: "a".repeat(64),
      schemaVersion: 48,
      schemaSignature: "b".repeat(64),
      preWriteDatabaseDigest: "c".repeat(64),
      canonicalInputDigest: "d".repeat(64),
      projectionBefore: [],
      projectionBeforeDigest: sha256Hex("[]"),
      operationId: "f".repeat(64),
    });
    const text = `${canonicalP6InboxJson(created)}\n${canonicalP6InboxJson(prepared)}\n`;
    expect(validateP6InboxManifestText(text)).toHaveLength(2);
    expect(() =>
      validateP6InboxManifestText(
        `${text.replace('"kind":"Prepared"', '"kind":"Committed"')}`,
      ),
    ).toThrow(/hash chain/u);
    expect(() => validateP6InboxManifestText(text.slice(0, -1))).toThrow(
      /torn/u,
    );
  });

  it("rejects operator evidence paths aliasing every SQLite protected-file suffix", () => {
    const primary = "C:\\Arbor\\primary.sqlite";
    const reportSidecar = "C:\\Arbor\\p39-report.sqlite";
    for (const suffix of ["-wal", "-shm", "-journal"] as const) {
      expect(() =>
        rejectSqliteArtifactAliases([primary], [`${primary}${suffix}`]),
      ).toThrow(/sidecar/u);
      expect(() =>
        rejectSqliteArtifactAliases(
          [reportSidecar],
          [`${reportSidecar}${suffix}`],
        ),
      ).toThrow(/sidecar/u);
    }
  });

  it("runs and resumes through the real P39 CLI in a clean child-process fixture", async () => {
    const repositoryRoot = resolve(
      process.cwd(),
      process
        .cwd()
        .replaceAll("\\", "/")
        .toLowerCase()
        .endsWith("apps/single-workspace")
        ? "../.."
        : ".",
    );
    const handoffDirectory = mkdtempSync(
      join(tmpdir(), "arbor-p6-rebuild-handoff-"),
    );
    const handoff = join(handoffDirectory, "fixture.json");
    const child = spawn(
      process.execPath,
      [
        join(repositoryRoot, "node_modules", "vitest", "vitest.mjs"),
        "run",
        join(
          repositoryRoot,
          "apps/single-workspace/test/p6-inbox-rebuild-fixture-child.test.ts",
        ),
        "--reporter=dot",
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          ARBOR_P6_FIXTURE_CHILD: "1",
          ARBOR_P6_FIXTURE_RESULT: handoff,
        },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let childOutput = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      childOutput += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      childOutput += chunk;
    });
    const close = new Promise<number | null>((resolveClose) =>
      child.once("close", resolveClose),
    );
    let fixtureDirectory: string | undefined;
    try {
      const fixtureChildCode = await close;
      expect(fixtureChildCode, childOutput).toBe(0);
      expect(
        existsSync(handoff),
        `fixture subprocess did not publish a database at ${handoff}: ${childOutput}`,
      ).toBe(true);
      const fixture = JSON.parse(readFileSync(handoff, "utf8")) as {
        readonly directory: string;
        readonly databaseFilename: string;
        readonly p39ReportFilename: string;
      };
      fixtureDirectory = fixture.directory;
      const manifest = join(fixture.directory, "p6-rebuild.jsonl");
      const cli = resolve(
        repositoryRoot,
        "apps/single-workspace/dist/p6-inbox-rebuild.js",
      );
      if (process.env.ARBOR_P6_SIDE_CAR_RACE_ONLY === "1") {
        await raceOperatorSidecar(
          repositoryRoot,
          cli,
          fixture.databaseFilename,
          fixture.directory,
        );
        return;
      }
      if (process.env.ARBOR_P6_SIDECAR_CRASH_ONLY === "1") {
        await qualifySidecarCrashRestart(
          repositoryRoot,
          cli,
          fixture.databaseFilename,
          fixture.p39ReportFilename,
          fixture.directory,
        );
        return;
      }
      const interruptedAfterCommit = await stopOperatorCliAtBoundary(
        cli,
        fixture.databaseFilename,
        fixture.p39ReportFilename,
        manifest,
        "database-committed",
      );
      expect(interruptedAfterCommit.code).not.toBe(0);
      const preparedText = readFileSync(manifest, "utf8");
      const beforeAuditRecords = preparedText
        .trimEnd()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              record: Record<string, unknown> & { kind: string };
            },
        );
      expect(beforeAuditRecords.map(({ record }) => record.kind)).toEqual([
        "Created",
        "Prepared",
      ]);
      const readback = new DatabaseSync(fixture.databaseFilename, {
        readOnly: true,
      });
      try {
        expect(
          readback
            .prepare(
              `SELECT workspace_id,kind,summary,correlation_id,admitted_at,
                      consumed_at,revision FROM inbox_entries
                WHERE entry_key = ?`,
            )
            .get(
              "retry-verification-unbound:cmd_018f2b3c-4d5e-7abc-8def-01234567a459",
            ),
        ).toMatchObject({
          workspace_id: "ws_018f2b3c-4d5e-7abc-8def-01234567a457",
          kind: "Governance",
          summary:
            "A historical RetryVerification receipt has incomplete origin evidence.",
          correlation_id: "cmd_018f2b3c-4d5e-7abc-8def-01234567a459",
          admitted_at: "2026-10-18T00:00:00.000Z",
          consumed_at: null,
          revision: 1,
        });
        expect(readback.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        readback.close();
      }
      await assertUnboundLegacyReadSurface(fixture.databaseFilename);
      await qualifySidecarCrashRestart(
        repositoryRoot,
        cli,
        fixture.databaseFilename,
        fixture.p39ReportFilename,
        fixture.directory,
      );
      const resumed = await runOperatorCli(
        cli,
        fixture.databaseFilename,
        fixture.p39ReportFilename,
        manifest,
        true,
      );
      expect(resumed.code, resumed.output).toBe(0);
      const committed = readFileSync(manifest, "utf8");
      expect(committed.startsWith(preparedText)).toBe(true);
      expect(readFileSync(manifest, "utf8")).toBe(committed);
      const records = committed
        .trimEnd()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              record: Record<string, unknown> & { kind: string };
            },
        );
      expect(records.map(({ record }) => record.kind)).toEqual([
        "Created",
        "Prepared",
        "Committed",
      ]);
      expect(records[0]?.record.descriptors).toEqual(
        descriptorHashesThrough(48),
      );
      expect(records[1]?.record.canonicalInputDigest).toBe(
        records[2]?.record.canonicalInputDigest,
      );
      expect(records[2]?.record).toMatchObject({
        inserted: 0,
        moved: 0,
        noOp: 1,
      });

      const p39ManifestAlias = `${fixture.p39ReportFilename}-journal`;
      expect(existsSync(p39ManifestAlias)).toBe(false);
      const primaryBeforeReportAlias = logicalSqliteDigest(
        fixture.databaseFilename,
      );
      const reportBeforeAlias = logicalSqliteDigest(fixture.p39ReportFilename);
      const reportManifestAliasRun = await runOperatorCli(
        cli,
        fixture.databaseFilename,
        fixture.p39ReportFilename,
        p39ManifestAlias,
        false,
      );
      expect(
        reportManifestAliasRun.code,
        reportManifestAliasRun.output,
      ).not.toBe(0);
      expect(existsSync(p39ManifestAlias)).toBe(false);
      expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(
        primaryBeforeReportAlias,
      );
      expect(logicalSqliteDigest(fixture.p39ReportFilename)).toBe(
        reportBeforeAlias,
      );

      const sameTargetManifest = join(
        fixture.directory,
        "p6-same-target-application.jsonl",
      );
      const sameTargetRun = await runOperatorCli(
        cli,
        fixture.databaseFilename,
        join(fixture.directory, "p6-same-target-report.sqlite"),
        sameTargetManifest,
        false,
        { ARBOR_DB: fixture.databaseFilename },
      );
      expect(sameTargetRun.code, sameTargetRun.output).toBe(0);

      const movedProjection = new DatabaseSync(fixture.databaseFilename);
      try {
        movedProjection
          .prepare(
            `UPDATE inbox_entries
                SET workspace_id = 'ws_018f2b3c-4d5e-7abc-8def-01234567a458',
                    revision = 2, updated_at = 'projection-preimage'
              WHERE entry_key = ?`,
          )
          .run(
            "retry-verification-unbound:cmd_018f2b3c-4d5e-7abc-8def-01234567a459",
          );
      } finally {
        movedProjection.close();
      }
      const firstMoveManifest = join(
        fixture.directory,
        "p6-first-route-move.jsonl",
      );
      const interruptedFirstMove = await stopOperatorCliAtBoundary(
        cli,
        fixture.databaseFilename,
        fixture.p39ReportFilename,
        firstMoveManifest,
        "prepared",
      );
      expect(interruptedFirstMove.code).not.toBe(0);
      expect(
        validateP6InboxManifestText(
          readFileSync(firstMoveManifest, "utf8"),
        ).map(({ record }) => record.kind),
      ).toEqual(["Created", "Prepared"]);
      const firstMovePreimage = new DatabaseSync(fixture.databaseFilename, {
        readOnly: true,
      });
      try {
        expect(
          firstMovePreimage
            .prepare(
              `SELECT workspace_id, revision, updated_at FROM inbox_entries
                WHERE entry_key = ?`,
            )
            .get(
              "retry-verification-unbound:cmd_018f2b3c-4d5e-7abc-8def-01234567a459",
            ),
        ).toMatchObject({
          workspace_id: "ws_018f2b3c-4d5e-7abc-8def-01234567a458",
          revision: 2,
          updated_at: "projection-preimage",
        });
      } finally {
        firstMovePreimage.close();
      }
      const secondMoveManifest = join(
        fixture.directory,
        "p6-second-route-move.jsonl",
      );
      const secondMove = await runOperatorCli(
        cli,
        fixture.databaseFilename,
        fixture.p39ReportFilename,
        secondMoveManifest,
        false,
      );
      expect(secondMove.code, secondMove.output).toBe(0);
      expect(
        validateP6InboxManifestText(readFileSync(secondMoveManifest, "utf8"))[2]
          ?.record,
      ).toMatchObject({ inserted: 0, moved: 1, noOp: 0 });
      const secondMovePostimage = new DatabaseSync(fixture.databaseFilename, {
        readOnly: true,
      });
      let secondMoveUpdatedAt = "";
      try {
        const row = secondMovePostimage
          .prepare(
            `SELECT workspace_id, revision, updated_at FROM inbox_entries
              WHERE entry_key = ?`,
          )
          .get(
            "retry-verification-unbound:cmd_018f2b3c-4d5e-7abc-8def-01234567a459",
          ) as {
          workspace_id: string;
          revision: number;
          updated_at: string;
        };
        expect(row).toMatchObject({
          workspace_id: "ws_018f2b3c-4d5e-7abc-8def-01234567a457",
          revision: 3,
        });
        secondMoveUpdatedAt = row.updated_at;
      } finally {
        secondMovePostimage.close();
      }
      const beforeFirstMoveResume = logicalSqliteDigest(
        fixture.databaseFilename,
      );
      const replayedFirstMove = await runOperatorCli(
        cli,
        fixture.databaseFilename,
        fixture.p39ReportFilename,
        firstMoveManifest,
        true,
      );
      expect(replayedFirstMove.code, replayedFirstMove.output).toBe(0);
      expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(
        beforeFirstMoveResume,
      );
      const replayedMoveReadback = new DatabaseSync(fixture.databaseFilename, {
        readOnly: true,
      });
      try {
        expect(
          replayedMoveReadback
            .prepare(
              `SELECT workspace_id, revision, updated_at FROM inbox_entries
                WHERE entry_key = ?`,
            )
            .get(
              "retry-verification-unbound:cmd_018f2b3c-4d5e-7abc-8def-01234567a459",
            ),
        ).toEqual({
          workspace_id: "ws_018f2b3c-4d5e-7abc-8def-01234567a457",
          revision: 3,
          updated_at: secondMoveUpdatedAt,
        });
      } finally {
        replayedMoveReadback.close();
      }
      const replayedFirstMoveRecords = validateP6InboxManifestText(
        readFileSync(firstMoveManifest, "utf8"),
      );
      expect(replayedFirstMoveRecords.map(({ record }) => record.kind)).toEqual(
        ["Created", "Prepared", "Committed"],
      );
      expect(replayedFirstMoveRecords[2]?.record).toMatchObject({
        inserted: 0,
        moved: 0,
        noOp: 1,
      });

      const createdOnlyManifest = join(
        fixture.directory,
        "p6-created-only-drift.jsonl",
      );
      const createdOnlyStopped = await stopOperatorCliAtBoundary(
        cli,
        fixture.databaseFilename,
        fixture.p39ReportFilename,
        createdOnlyManifest,
        "created",
      );
      expect(createdOnlyStopped.code).not.toBe(0);
      const createdOnlyRecords = validateP6InboxManifestText(
        readFileSync(createdOnlyManifest, "utf8"),
      );
      expect(createdOnlyRecords.map(({ record }) => record.kind)).toEqual([
        "Created",
      ]);
      const createdOnlyDriftDb = new DatabaseSync(fixture.databaseFilename);
      try {
        createdOnlyDriftDb
          .prepare(
            "UPDATE works SET revision = 1, updated_at = '2026-10-18T00:01:00.000Z' WHERE work_id = 'wrk_p6_operator_fixture'",
          )
          .run();
      } finally {
        createdOnlyDriftDb.close();
      }
      const driftDigest = logicalSqliteDigest(fixture.databaseFilename);
      const createdOnlyDrift = await runOperatorCli(
        cli,
        fixture.databaseFilename,
        fixture.p39ReportFilename,
        createdOnlyManifest,
        true,
      );
      expect(createdOnlyDrift.code, createdOnlyDrift.output).not.toBe(0);
      expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(driftDigest);
      expect(
        validateP6InboxManifestText(
          readFileSync(createdOnlyManifest, "utf8"),
        ).map(({ record }) => record.kind),
      ).toEqual(["Created"]);
      const restoreCreatedDrift = new DatabaseSync(fixture.databaseFilename);
      try {
        restoreCreatedDrift
          .prepare(
            "UPDATE works SET revision = 0, updated_at = 't0' WHERE work_id = 'wrk_p6_operator_fixture'",
          )
          .run();
      } finally {
        restoreCreatedDrift.close();
      }
      const createdOnlyResume = await runOperatorCli(
        cli,
        fixture.databaseFilename,
        fixture.p39ReportFilename,
        createdOnlyManifest,
        true,
      );
      expect(createdOnlyResume.code, createdOnlyResume.output).toBe(0);

      const descriptorDriftManifest = join(
        fixture.directory,
        "p6-created-only-descriptor-drift.jsonl",
      );
      const descriptorDriftStopped = await stopOperatorCliAtBoundary(
        cli,
        fixture.databaseFilename,
        fixture.p39ReportFilename,
        descriptorDriftManifest,
        "created",
      );
      expect(descriptorDriftStopped.code).not.toBe(0);
      const validCreatedRecord = validateP6InboxManifestText(
        readFileSync(descriptorDriftManifest, "utf8"),
      )[0];
      expect(validCreatedRecord?.record.kind).toBe("Created");
      const descriptorDriftHeader = p6InboxManifestEnvelope(0, null, {
        ...validCreatedRecord?.record,
        descriptors: descriptorHashesThrough(48).slice(0, -1),
      });
      writeFileSync(
        descriptorDriftManifest,
        `${canonicalP6InboxJson(descriptorDriftHeader)}\n`,
        { flag: "w", mode: 0o600 },
      );
      const descriptorDriftBefore = logicalSqliteDigest(
        fixture.databaseFilename,
      );
      const descriptorDriftResume = await runOperatorCli(
        cli,
        fixture.databaseFilename,
        fixture.p39ReportFilename,
        descriptorDriftManifest,
        true,
      );
      expect(descriptorDriftResume.code, descriptorDriftResume.output).not.toBe(
        0,
      );
      expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(
        descriptorDriftBefore,
      );

      const preparedCrashManifest = join(
        fixture.directory,
        "p6-prepared-crash.jsonl",
      );
      const interruptedPrepared = await stopOperatorCliAtBoundary(
        cli,
        fixture.databaseFilename,
        fixture.p39ReportFilename,
        preparedCrashManifest,
        "prepared",
      );
      expect(interruptedPrepared.code).not.toBe(0);
      expect(
        validateP6InboxManifestText(
          readFileSync(preparedCrashManifest, "utf8"),
        ).map(({ record }) => record.kind),
      ).toEqual(["Created", "Prepared"]);
      const driftDb = new DatabaseSync(fixture.databaseFilename);
      try {
        driftDb
          .prepare(
            "UPDATE works SET revision = 1, updated_at = '2026-10-18T00:01:00.000Z' WHERE work_id = 'wrk_p6_operator_fixture'",
          )
          .run();
      } finally {
        driftDb.close();
      }
      const digestAfterExternalInputDrift = logicalSqliteDigest(
        fixture.databaseFilename,
      );
      const driftResume = await runOperatorCli(
        cli,
        fixture.databaseFilename,
        fixture.p39ReportFilename,
        preparedCrashManifest,
        true,
      );
      expect(driftResume.code, driftResume.output).not.toBe(0);
      expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(
        digestAfterExternalInputDrift,
      );
      expect(
        validateP6InboxManifestText(
          readFileSync(preparedCrashManifest, "utf8"),
        ).map(({ record }) => record.kind),
      ).toEqual(["Created", "Prepared"]);
      const restoreDrift = new DatabaseSync(fixture.databaseFilename);
      try {
        restoreDrift
          .prepare(
            "UPDATE works SET revision = 0, updated_at = 't0' WHERE work_id = 'wrk_p6_operator_fixture'",
          )
          .run();
      } finally {
        restoreDrift.close();
      }
      const digestBeforePreparedResume = logicalSqliteDigest(
        fixture.databaseFilename,
      );
      const preparedResume = await runOperatorCli(
        cli,
        fixture.databaseFilename,
        fixture.p39ReportFilename,
        preparedCrashManifest,
        true,
      );
      expect(preparedResume.code, preparedResume.output).toBe(0);
      const preparedCommitted = validateP6InboxManifestText(
        readFileSync(preparedCrashManifest, "utf8"),
      );
      expect(preparedCommitted.map(({ record }) => record.kind)).toEqual([
        "Created",
        "Prepared",
        "Committed",
      ]);
      expect(preparedCommitted[2]?.record).toMatchObject({
        inserted: 0,
        moved: 0,
        noOp: 1,
      });
      expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(
        digestBeforePreparedResume,
      );

      const digestBeforeRefusals = logicalSqliteDigest(
        fixture.databaseFilename,
      );
      const missingResume = await runOperatorCli(
        cli,
        fixture.databaseFilename,
        fixture.p39ReportFilename,
        join(fixture.directory, "missing-resume.jsonl"),
        true,
      );
      expect(missingResume.code, missingResume.output).not.toBe(0);
      const tamperedManifest = join(fixture.directory, "tampered.jsonl");
      writeFileSync(
        tamperedManifest,
        committed.replace('"kind":"Committed"', '"kind":"Forged"'),
        { flag: "wx", mode: 0o600 },
      );
      const tamperedResume = await runOperatorCli(
        cli,
        fixture.databaseFilename,
        fixture.p39ReportFilename,
        tamperedManifest,
        true,
      );
      expect(tamperedResume.code, tamperedResume.output).not.toBe(0);
      expect(existsSync(tamperedManifest)).toBe(true);
      expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(
        digestBeforeRefusals,
      );

      for (const invalidPrefix of [
        "schema47",
        "schema49",
        "pseudo48",
      ] as const) {
        const invalidDatabase = join(
          fixture.directory,
          `${invalidPrefix}.sqlite`,
        );
        copyFileSync(fixture.databaseFilename, invalidDatabase);
        const invalid = new DatabaseSync(invalidDatabase);
        try {
          if (invalidPrefix === "schema47")
            invalid.exec("PRAGMA user_version = 47");
          else if (invalidPrefix === "schema49")
            invalid.exec("PRAGMA user_version = 49");
          else
            invalid.exec("CREATE TABLE p6_schema_tamper (id TEXT PRIMARY KEY)");
        } finally {
          invalid.close();
        }
        const beforeInvalidRun = logicalSqliteDigest(invalidDatabase);
        const invalidManifest = join(
          fixture.directory,
          `${invalidPrefix}.jsonl`,
        );
        const invalidRun = await runOperatorCli(
          cli,
          invalidDatabase,
          fixture.p39ReportFilename,
          invalidManifest,
          false,
        );
        expect(invalidRun.code, invalidRun.output).not.toBe(0);
        expect(existsSync(invalidManifest)).toBe(false);
        expect(logicalSqliteDigest(invalidDatabase)).toBe(beforeInvalidRun);
      }

      await raceOperatorSidecar(
        repositoryRoot,
        cli,
        fixture.databaseFilename,
        fixture.directory,
      );
      seedFailAfterFirstCandidate(fixture.databaseFilename);
      const digestBeforeRollback = logicalSqliteDigest(
        fixture.databaseFilename,
      );
      const rollbackManifest = join(fixture.directory, "p6-rollback.jsonl");
      const rollbackRun = await runOperatorCli(
        cli,
        fixture.databaseFilename,
        fixture.p39ReportFilename,
        rollbackManifest,
        false,
      );
      expect(rollbackRun.code, rollbackRun.output).not.toBe(0);
      expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(
        digestBeforeRollback,
      );
      const rollbackRecords = validateP6InboxManifestText(
        readFileSync(rollbackManifest, "utf8"),
      );
      expect(rollbackRecords.map(({ record }) => record.kind)).toEqual([
        "Created",
        "Prepared",
      ]);
      const afterRollback = new DatabaseSync(fixture.databaseFilename, {
        readOnly: true,
      });
      try {
        expect(
          afterRollback
            .prepare(
              "SELECT entry_key FROM inbox_entries WHERE entry_key LIKE 'retry-verification-unbound:%'",
            )
            .all(),
        ).toEqual([]);
      } finally {
        afterRollback.close();
      }

      const lockFiles = readdirSync(fixture.directory).filter(
        (name) =>
          name.startsWith(".arbor-p39-writer-") && name.endsWith(".sqlite"),
      );
      const primaryStat = statSync(fixture.databaseFilename, { bigint: true });
      const expectedLockFilename = `.arbor-p39-writer-${sha256Hex(`${primaryStat.dev}:${primaryStat.ino}`)}.sqlite`;
      expect(lockFiles).toContain(expectedLockFilename);
      const lockFilename = join(fixture.directory, expectedLockFilename);
      const protectedAppDbFilename = join(
        fixture.directory,
        "protected-empty-application.sqlite",
      );
      const protectedAppDb = new DatabaseSync(protectedAppDbFilename);
      protectedAppDb.close();
      const protectedAppManifest = join(
        fixture.directory,
        "p6-protected-application-alias.jsonl",
      );
      const protectedAppDigest = logicalSqliteDigest(protectedAppDbFilename);
      const protectedAppAlias = await runOperatorCli(
        cli,
        fixture.databaseFilename,
        protectedAppDbFilename,
        protectedAppManifest,
        false,
        { ARBOR_DB: protectedAppDbFilename },
      );
      expect(protectedAppAlias.code, protectedAppAlias.output).not.toBe(0);
      expect(existsSync(protectedAppManifest)).toBe(false);
      expect(logicalSqliteDigest(protectedAppDbFilename)).toBe(
        protectedAppDigest,
      );

      const protectedWalDbFilename = join(
        fixture.directory,
        "protected-wal-application.sqlite",
      );
      const protectedWalDb = new DatabaseSync(protectedWalDbFilename);
      protectedWalDb.exec(
        "PRAGMA journal_mode = WAL; CREATE TABLE protected_data(value TEXT);",
      );
      protectedWalDb
        .prepare("INSERT INTO protected_data VALUES ('protected')")
        .run();
      const protectedWalDigest = logicalSqliteDigest(protectedWalDbFilename);
      expect(
        existsSync(`${protectedWalDbFilename}-wal`),
        "protected app DB WAL must remain present and untouched",
      ).toBe(true);
      const protectedWalManifest = join(
        fixture.directory,
        "p6-protected-application-wal-alias.jsonl",
      );
      const protectedWalBefore = logicalSqliteDigest(fixture.databaseFilename);
      const protectedWalAlias = await runOperatorCli(
        cli,
        fixture.databaseFilename,
        `${protectedWalDbFilename}-wal`,
        protectedWalManifest,
        false,
        { ARBOR_DB: protectedWalDbFilename },
      );
      expect(protectedWalAlias.code, protectedWalAlias.output).not.toBe(0);
      expect(existsSync(protectedWalManifest)).toBe(false);
      expect(logicalSqliteDigest(protectedWalDbFilename)).toBe(
        protectedWalDigest,
      );
      expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(
        protectedWalBefore,
      );
      const protectedWalIdentityAlias = join(
        fixture.directory,
        "p6-protected-wal-hardlink.sqlite",
      );
      linkSync(`${protectedWalDbFilename}-wal`, protectedWalIdentityAlias);
      const hardlinkManifest = join(
        fixture.directory,
        "p6-protected-wal-hardlink.jsonl",
      );
      const hardlinkAlias = await runOperatorCli(
        cli,
        fixture.databaseFilename,
        protectedWalIdentityAlias,
        hardlinkManifest,
        false,
        { ARBOR_DB: protectedWalDbFilename },
      );
      expect(hardlinkAlias.code, hardlinkAlias.output).not.toBe(0);
      expect(existsSync(hardlinkManifest)).toBe(false);
      expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(
        protectedWalBefore,
      );
      unlinkSync(protectedWalIdentityAlias);
      protectedWalDb.close();
      for (const [label, sidecarPath] of [
        ["writer-lock", lockFilename],
      ] as const) {
        const aliasManifest = join(
          fixture.directory,
          `p6-${label}-alias.jsonl`,
        );
        const aliasBefore = logicalSqliteDigest(fixture.databaseFilename);
        const aliasRun = await runOperatorCli(
          cli,
          fixture.databaseFilename,
          sidecarPath,
          aliasManifest,
          false,
          {},
        );
        expect(aliasRun.code, `${label}: ${aliasRun.output}`).not.toBe(0);
        expect(existsSync(aliasManifest)).toBe(false);
        expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(aliasBefore);
      }
      const holder = spawn(
        process.execPath,
        [
          join(
            repositoryRoot,
            "apps/single-workspace/test/p6-writer-lock-holder.mjs",
          ),
          lockFilename,
        ],
        {
          cwd: repositoryRoot,
          windowsHide: true,
          env: {
            ...p39WindowsTestEnvironment(),
            ARBOR_P6_LOCK_DIAGNOSTIC: join(
              fixture.directory,
              "lock-holder-diagnostic.txt",
            ),
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let holderOutput = "";
      holder.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        holderOutput += chunk;
      });
      holder.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        holderOutput += chunk;
      });
      const holderClosed = new Promise<number | null>((resolveClose) =>
        holder.once("close", resolveClose),
      );
      try {
        try {
          await waitForOutput(holder, "READY\n", 30_000);
        } catch (cause) {
          const diagnostic = join(
            fixture.directory,
            "lock-holder-diagnostic.txt",
          );
          const detail = existsSync(diagnostic)
            ? readFileSync(diagnostic, "utf8")
            : "no child diagnostic file";
          throw new Error(`${String(cause)} ${holderOutput} ${detail}`);
        }
        const beforeRefusal = logicalSqliteDigest(fixture.databaseFilename);
        const refusedManifest = join(
          fixture.directory,
          "p6-shared-refused.jsonl",
        );
        const refused = await runOperatorCli(
          cli,
          fixture.databaseFilename,
          fixture.p39ReportFilename,
          refusedManifest,
          false,
        );
        expect(refused.code, refused.output).not.toBe(0);
        expect(existsSync(refusedManifest)).toBe(false);
        expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(
          beforeRefusal,
        );
      } finally {
        if (holder.exitCode === null && holder.stdin.writable)
          holder.stdin.end("release\n");
      }
      expect(await holderClosed, holderOutput).toBe(0);
    } finally {
      if (fixtureDirectory !== undefined)
        removeP39PrivateTestDirectory(fixtureDirectory);
      rmSync(handoffDirectory, { recursive: true, force: true });
    }
  }, 1_200_000);
});

const runOperatorCli = async (
  cli: string,
  database: string,
  p39Sidecar: string,
  manifest: string,
  resume: boolean,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ readonly code: number | null; readonly output: string }> =>
  new Promise((resolveRun, reject) => {
    const startedAt = Date.now();
    const args = [
      cli,
      "--database",
      database,
      "--p39-sidecar",
      p39Sidecar,
      "--manifest",
      manifest,
    ];
    if (resume) args.push("--resume");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key.toLowerCase() !== "psmodulepath",
      ),
    ) as NodeJS.ProcessEnv;
    const systemRoot = env.WINDIR ?? env.SystemRoot ?? "C:\\Windows";
    env.PSModulePath = join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "Modules",
    );
    Object.assign(env, extraEnv);
    const processChild = spawn(process.execPath, args, {
      cwd: process.cwd(),
      windowsHide: true,
      env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    processChild.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    processChild.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const childClosed = new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolveClosed) =>
      processChild.once("close", (code, signal) =>
        resolveClosed({ code, signal }),
      ),
    );
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      const pid = processChild.pid;
      void (async () => {
        let attempt = 0;
        while (true) {
          attempt += 1;
          let treeKillExit: number | null = null;
          if (pid !== undefined && process.platform === "win32") {
            const treeKill = spawn(
              "taskkill.exe",
              ["/PID", String(pid), "/T", "/F"],
              { windowsHide: true, stdio: "ignore" },
            );
            await new Promise<void>((resolveTreeKill) => {
              let finished = false;
              treeKill.once("close", (code) => {
                if (finished) return;
                finished = true;
                treeKillExit = code;
                resolveTreeKill();
              });
              treeKill.once("error", (cause) => {
                if (finished) return;
                finished = true;
                void cause;
                resolveTreeKill();
              });
            });
          } else {
            processChild.kill("SIGTERM");
            treeKillExit = 0;
          }
          const directExited = await new Promise<boolean>((resolveExit) => {
            const closeTimeout = setTimeout(() => resolveExit(false), 15_000);
            void childClosed.then(() => {
              clearTimeout(closeTimeout);
              resolveExit(true);
            });
          });
          let rootAlive = pid === undefined;
          if (pid !== undefined) {
            try {
              process.kill(pid, 0);
              rootAlive = true;
            } catch (cause) {
              const code =
                typeof cause === "object" && cause !== null && "code" in cause
                  ? String((cause as { code?: unknown }).code)
                  : "unknown";
              rootAlive = code !== "ESRCH" && code !== "EINVAL";
            }
          }
          if (treeKillExit === 0 && directExited && !rootAlive) {
            settled = true;
            clearTimeout(timeout);
            reject(
              new Error(
                `P6 CLI timeout pid=${pid ?? "unknown"} elapsedMs=${Date.now() - startedAt} ` +
                  `cleanupConfirmed=true taskkillAttempt=${attempt} ` +
                  `stdout=${stdout.slice(-4000)} stderr=${stderr.slice(-4000)}`,
              ),
            );
            return;
          }
          await new Promise<void>((resolveRetry) =>
            setTimeout(resolveRetry, 250),
          );
        }
      })();
    }, 180_000);
    timeout.unref();
    processChild.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    void childClosed.then(({ code, signal }) => {
      if (settled || timedOut) return;
      settled = true;
      clearTimeout(timeout);
      resolveRun({
        code,
        output: `signal=${signal ?? "null"} stdout=${stdout} stderr=${stderr}`,
      });
    });
  });

const stopOperatorCliAtBoundary = async (
  cli: string,
  database: string,
  p39Sidecar: string,
  manifest: string,
  boundary: "created" | "prepared" | "database-committed",
): Promise<{ readonly code: number | null; readonly output: string }> => {
  const args = [
    cli,
    "--database",
    database,
    "--p39-sidecar",
    p39Sidecar,
    "--manifest",
    manifest,
  ];
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toLowerCase() !== "psmodulepath",
    ),
  ) as NodeJS.ProcessEnv;
  const systemRoot = env.WINDIR ?? env.SystemRoot ?? "C:\\Windows";
  env.PSModulePath = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules",
  );
  env.NODE_ENV = "test";
  env.ARBOR_P6_TEST_HOLD_BOUNDARY = boundary;
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    windowsHide: true,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  const closed = new Promise<number | null>((resolveClose) =>
    child.once("close", resolveClose),
  );
  try {
    await waitForOutput(
      child,
      `P6_REBUILD_TEST_BOUNDARY:${boundary}\n`,
      120_000,
    );
  } catch (cause) {
    throw new Error(`${String(cause)} ${output}`);
  }
  child.kill();
  return { code: await closed, output };
};

const startOperatorCliPausedAtP39 = async (
  repositoryRoot: string,
  cli: string,
  database: string,
  p39Sidecar: string,
  manifest: string,
): Promise<{
  readonly child: ChildProcessWithoutNullStreams;
  readonly close: Promise<number | null>;
  readonly getOutput: () => string;
}> => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toLowerCase() !== "psmodulepath",
    ),
  ) as NodeJS.ProcessEnv;
  const systemRoot = env.WINDIR ?? env.SystemRoot ?? "C:\\Windows";
  env.PSModulePath = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules",
  );
  env.NODE_ENV = "test";
  env.ARBOR_P6_TEST_HOLD_BOUNDARY = "before-p39";
  const child = spawn(
    process.execPath,
    [
      cli,
      "--database",
      database,
      "--p39-sidecar",
      p39Sidecar,
      "--manifest",
      manifest,
    ],
    {
      cwd: repositoryRoot,
      windowsHide: true,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  const close = new Promise<number | null>((resolveClose) =>
    child.once("close", resolveClose),
  );
  try {
    await waitForOutput(
      child,
      "P6_REBUILD_TEST_BOUNDARY:before-p39\n",
      120_000,
    );
  } catch (cause) {
    throw new Error(`${String(cause)} ${output}`);
  }
  return { child, close, getOutput: () => output };
};

const raceOperatorSidecar = async (
  repositoryRoot: string,
  cli: string,
  database: string,
  directory: string,
): Promise<void> => {
  const racedSidecar = join(directory, "p6-raced-report.sqlite");
  const racedManifest = join(directory, "p6-raced.jsonl");
  const racers = await Promise.all([
    startOperatorCliPausedAtP39(
      repositoryRoot,
      cli,
      database,
      racedSidecar,
      racedManifest,
    ),
    startOperatorCliPausedAtP39(
      repositoryRoot,
      cli,
      database,
      racedSidecar,
      racedManifest,
    ),
  ]);
  const racerOne = racers[0];
  const racerTwo = racers[1];
  if (racerOne === undefined || racerTwo === undefined)
    throw new Error("both P6 race processes must be started");
  racerOne.child.stdin.end("release\n");
  racerTwo.child.stdin.end("release\n");
  const raceResults = await Promise.all(
    racers.map(async ({ close, getOutput }) => ({
      code: await close,
      output: getOutput(),
    })),
  );
  expect(
    raceResults.filter(({ code }) => code === 0),
    JSON.stringify(raceResults),
  ).toHaveLength(1);
  expect(
    raceResults.filter(({ code }) => code !== 0),
    JSON.stringify(raceResults),
  ).toHaveLength(1);
  expect(
    validateP6InboxManifestText(readFileSync(racedManifest, "utf8")).map(
      ({ record }) => record.kind,
    ),
  ).toEqual(["Created", "Prepared", "Committed"]);
  const racedReport = new DatabaseSync(racedSidecar, { readOnly: true });
  try {
    expect(
      (
        racedReport.prepare("PRAGMA application_id").get() as {
          application_id: number;
        }
      ).application_id,
    ).toBe(P39_REPORT_APPLICATION_ID);
    expect(
      (
        racedReport.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    ).toBe(P39_REPORT_USER_VERSION);
    expect(
      (
        racedReport
          .prepare("SELECT COUNT(*) AS count FROM p39_migration_block_reports")
          .get() as { count: number }
      ).count,
    ).toBe(0);
  } finally {
    racedReport.close();
  }
};

const waitForOutput = (
  child: ChildProcessWithoutNullStreams,
  marker: string,
  timeoutMs: number,
): Promise<void> =>
  new Promise((resolveMarker, reject) => {
    let text = "";
    const timeout = setTimeout(
      () => reject(new Error("P39 lock holder did not become ready")),
      timeoutMs,
    );
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      text += chunk;
      if (text.includes(marker)) {
        clearTimeout(timeout);
        resolveMarker();
      }
    });
    child.once("error", (cause) => {
      clearTimeout(timeout);
      reject(cause);
    });
    child.once("close", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(
          new Error(
            `P39 lock holder exited before readiness (${code}): ${text}`,
          ),
        );
      }
    });
  });

const qualifySidecarCrashRestart = async (
  repositoryRoot: string,
  cli: string,
  database: string,
  existingP39Sidecar: string,
  directory: string,
): Promise<void> => {
  const cases = [
    ["writer-lock-initialized-before-permit", "initialized"],
    ["report-initial-file-identity", "empty"],
    ["report-profile-init-transaction-open", "pristine"],
    ["report-profile-init-before-commit", "pristine"],
    ["report-profile-init-commit-complete", "initialized"],
    ["report-final-path-and-identity", "initialized"],
  ] as const;
  for (const [phase, state] of cases) {
    const sidecar = join(directory, `p6-sidecar-${phase}.sqlite`);
    const manifest = join(directory, `p6-sidecar-${phase}.jsonl`);
    const primaryBefore = logicalSqliteDigest(database);
    const crashed = await crashOperatorCliAtP39Phase(
      repositoryRoot,
      cli,
      database,
      sidecar,
      manifest,
      phase,
    );
    expect(
      crashed.signal === "SIGTERM" ||
        (crashed.code === 1 &&
          crashed.output.includes(`P6_P39_TEST_CRASH_PHASE:${phase}\n`)),
      `${phase} code=${crashed.code} signal=${crashed.signal}: ${crashed.output}`,
    ).toBe(true);
    expect(existsSync(manifest)).toBe(false);
    expect(logicalSqliteDigest(database)).toBe(primaryBefore);
    if (state === "empty") {
      expect(statSync(sidecar).size).toBe(0);
    } else {
      const sidecarDb = new DatabaseSync(sidecar, { readOnly: true });
      try {
        const applicationId = (
          sidecarDb.prepare("PRAGMA application_id").get() as {
            application_id: number;
          }
        ).application_id;
        const userVersion = (
          sidecarDb.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version;
        if (state === "pristine") {
          expect(applicationId).toBe(0);
          expect(userVersion).toBe(0);
          expect(
            sidecarDb
              .prepare(
                "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
              )
              .all(),
          ).toEqual([]);
        } else {
          expect(applicationId).toBe(P39_REPORT_APPLICATION_ID);
          expect(userVersion).toBe(P39_REPORT_USER_VERSION);
          expect(
            (
              sidecarDb
                .prepare(
                  "SELECT COUNT(*) AS count FROM p39_migration_block_reports",
                )
                .get() as { count: number }
            ).count,
          ).toBe(0);
        }
      } finally {
        sidecarDb.close();
      }
    }
    if (phase === "writer-lock-initialized-before-permit") {
      const lockPath = p39WriterLockFilename(database);
      expect(typeof lockPath).toBe("string");
      if (typeof lockPath !== "string")
        throw new Error("P39 writer-lock path was unavailable after crash");
      const lockDb = new DatabaseSync(lockPath, { readOnly: true });
      try {
        expect(
          lockDb
            .prepare("SELECT lock_id FROM p39_writer_lock WHERE lock_id = 1")
            .all(),
        ).toEqual([{ lock_id: 1 }]);
      } finally {
        lockDb.close();
      }
    }
    const retry = await runOperatorCli(cli, database, sidecar, manifest, false);
    expect(retry.code, `${phase}: ${retry.output}`).toBe(0);
    expect(
      validateP6InboxManifestText(readFileSync(manifest, "utf8")).map(
        ({ record }) => record.kind,
      ),
    ).toEqual(["Created", "Prepared", "Committed"]);
  }
  expect(existsSync(existingP39Sidecar)).toBe(true);
};

const crashOperatorCliAtP39Phase = async (
  repositoryRoot: string,
  cli: string,
  database: string,
  sidecar: string,
  manifest: string,
  phase: string,
): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
}> => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toLowerCase() !== "psmodulepath",
    ),
  ) as NodeJS.ProcessEnv;
  const systemRoot = env.WINDIR ?? env.SystemRoot ?? "C:\\Windows";
  env.PSModulePath = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules",
  );
  env.NODE_ENV = "test";
  env.ARBOR_P6_TEST_CRASH_P39_PHASE = phase;
  const child = spawn(
    process.execPath,
    [
      cli,
      "--database",
      database,
      "--p39-sidecar",
      sidecar,
      "--manifest",
      manifest,
    ],
    {
      cwd: repositoryRoot,
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  const closed = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveClose) =>
    child.once("close", (code, signal) => resolveClose({ code, signal })),
  );
  const result = await closed;
  return { code: result.code, signal: result.signal, output };
};

const seedFailAfterFirstCandidate = (databaseFilename: string): void => {
  const db = new DatabaseSync(databaseFilename);
  try {
    db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
    db.prepare("DELETE FROM inbox_entries WHERE entry_key = ?").run(
      "retry-verification-unbound:cmd_018f2b3c-4d5e-7abc-8def-01234567a459",
    );
    db.prepare(
      `INSERT INTO works (
        work_id,project_id,workspace_id,objective,why,constraints,
        completion_expectation,verification_mission,provenance,lifecycle,
        revision,created_at,updated_at
      ) VALUES ('wrk_p6_operator_bad',?,'ws_018f2b3c-4d5e-7abc-8def-01234567a458',
        'legacy bad','legacy bad','[]','legacy','{}','{}','Open',0,'t0','t0')`,
    ).run("prj_p6_operator_fixture");
    db.prepare(
      `INSERT INTO verifications (
        verification_id,project_id,work_id,target_work_revision,owner_workspace_id,
        mission_snapshot,target_deliverables,target_artifact_versions,
        target_environment_revision,environment_snapshot_ref,
        verification_execution_ids,state,verdict,conclusion_reason,created_at,
        updated_at,summary_ref,criteria_results,snapshot_status
      ) VALUES ('ver_p6_operator_bad','prj_p6_operator_fixture','wrk_p6_operator_bad',
        0,'ws_018f2b3c-4d5e-7abc-8def-01234567a458','{}','[]','[]',NULL,NULL,
        '[]','Concluded','Unknown','Orphaned','t0','t0','blob:p6-operator-bad',
        '[]','NotApplicableOrphaned')`,
    ).run();
    db.prepare(
      `INSERT INTO commands (
        command_id,project_id,semantic_request_fingerprint,schema_version,
        fingerprint_algorithm_version,resolution,result_json,terminal_error_json,
        created_at,settled_at
      ) VALUES ('cmd_018f2b3c-4d5e-7abc-8def-01234567a460',
        'prj_p6_operator_fixture','fp:cmd_018f2b3c-4d5e-7abc-8def-01234567a460',
        '1',1,'Committed','{}',NULL,'2026-10-18T00:00:00.000Z',
        '2026-10-18T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO retry_verification_legacy_dispositions (
        command_id,project_id,source_work_id,source_verification_id,
        disposition,reason_code,created_at
      ) VALUES ('cmd_018f2b3c-4d5e-7abc-8def-01234567a460',
        'prj_p6_operator_fixture','wrk_p6_operator_fixture','ver_p6_operator_bad',
        'UnboundLegacy','OriginEvidenceIncomplete','2026-10-18T00:00:00.000Z')`,
    ).run();
    db.exec("COMMIT");
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
};

const assertUnboundLegacyReadSurface = async (
  databaseFilename: string,
): Promise<void> => {
  const parentWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-01234567a457";
  const ownerWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-01234567a458";
  const projectId = "prj_p6_operator_fixture";
  const commandId = "cmd_018f2b3c-4d5e-7abc-8def-01234567a459";
  const sqlite = sqliteLayer({ filename: databaseFilename });
  const services = Layer.mergeAll(
    sqlite,
    Layer.provide(TransactionPortLive, sqlite),
    Layer.provide(RetryVerificationOriginRepositoryLive, sqlite),
  );
  const listProjection = (workspaceId: string) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const tx = yield* TransactionPort;
            const origins = yield* RetryVerificationOriginRepository;
            return yield* tx.transact(
              origins.listCurrentUnboundLegacyInbox(workspaceId as never),
            );
          }),
          services,
        ),
      ),
    );
  const projections = await listProjection(parentWorkspaceId);
  expect(projections).toHaveLength(1);
  const projection = projections[0];
  if (projection === undefined) throw new Error("Inbox projection missing");
  const row = {
    entryKey: `retry-verification-unbound:${commandId}`,
    kind: "Governance" as const,
    summary:
      "A historical RetryVerification receipt has incomplete origin evidence.",
    watermark: 1,
    target: {
      kind: "RetryVerificationUnboundLegacy" as const,
      commandId: projection.commandId,
      projectId: projection.projectId,
      sourceWorkId: projection.sourceWorkId,
      sourceVerificationId: projection.sourceVerificationId,
      disposition: projection.disposition,
      reasonCode: projection.reasonCode,
      createdAt: projection.createdAt,
      revision: projection.revision,
      updatedAt: projection.updatedAt,
    },
  };
  const rawInboxPort = {
    query: () =>
      Effect.succeed({
        value: { unconsumed: [row] },
        watermark: 1,
        lag: 0,
      }),
  };
  const loadInputs = () =>
    Effect.succeed({
      canonicalFacts: {
        projectId,
        project: { rootWorkspaceId: "ws_018f2b3c-4d5e-7abc-8def-01234567a455" },
        work: {
          workId: projection.sourceWorkId,
          projectId,
          workspaceId: ownerWorkspaceId,
        },
        workspace: {
          workspaceId: ownerWorkspaceId,
          projectId,
          parentWorkspaceId,
        },
      },
      grants: [],
      governance: {
        authenticatedHumans: [],
        directParentOf: [
          { workspaceId: ownerWorkspaceId, parentPrincipal: "user:parent" },
        ],
      },
      policy: {},
    } as never);
  const face = viewQueryFaceWithRetryAvailability(
    rawInboxPort as never,
    {} as never,
    loadInputs as never,
    (workspaceId) => Effect.promise(() => listProjection(workspaceId)) as never,
  );
  const digestBefore = logicalSqliteDigest(databaseFilename);
  const query = (principal: string) =>
    Effect.runPromise(
      face.query(
        "inbox-view",
        { workspaceId: parentWorkspaceId as never },
        undefined,
        principal as never,
      ),
    );
  const parentRead = await query("user:parent");
  expect(parentRead.value.unconsumed).toHaveLength(1);
  const foreignHumanRead = await query("user:foreign");
  expect(foreignHumanRead.value.unconsumed).toEqual([]);
  const agentRead = await query("agent:parent");
  expect(agentRead.value.unconsumed).toEqual([]);
  const repeatedParentRead = await query("user:parent");
  expect(repeatedParentRead.value.unconsumed).toHaveLength(1);
  expect(logicalSqliteDigest(databaseFilename)).toBe(digestBefore);
  const after = new DatabaseSync(databaseFilename, { readOnly: true });
  try {
    expect(
      after
        .prepare(
          "SELECT consumed_at,revision FROM inbox_entries WHERE entry_key = ?",
        )
        .get(`retry-verification-unbound:${commandId}`),
    ).toEqual({ consumed_at: null, revision: 1 });
  } finally {
    after.close();
  }
};
