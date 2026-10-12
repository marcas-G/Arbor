import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer } from "../src/client.js";
import { runMigrations, splitStatements } from "../src/migrate.js";
import * as migrations from "../src/migrations.js";
import {
  P39_REPORT_DATABASE_DDL,
  readP39BlockReports,
  requireP39RuntimeSchema,
  runP39MaintenanceGate,
  validateP39MigrationPrefix,
  writeP39BlockReportAndReadBack,
} from "../src/p39-maintenance.js";
import {
  validateP39ReportSidecarDatabase,
  validateP39ReportSidecarPath,
} from "../src/p39-report-database.js";
import {
  p39SameOperatingSystemIdentity,
  p39WriterLockFilename,
  prepareP39PrimaryDatabasePath,
  validateP39ProtectedDirectory,
} from "../src/p39-writer-lock.js";

const withClient = <A>(program: Effect.Effect<A, unknown, SqlClient>) =>
  Effect.runPromise(Effect.provide(program, layer({ filename: ":memory:" })));

const getP39Migration = () =>
  (
    migrations as typeof migrations & {
      readonly P39_RECONCILIATION_MIGRATION?: {
        readonly id: number;
        readonly name: string;
        readonly sql: string;
        readonly foreignKeysOff?: boolean;
      };
    }
  ).P39_RECONCILIATION_MIGRATION;

describe("AH7-DG-02 P39 migration module boundary", () => {
  it("defines one isolated 0039 migration without registering a P39-only runtime", async () => {
    const migration = getP39Migration();
    expect(migration, "P39 migration module is missing").toBeDefined();
    if (!migration) return;
    expect(migration.id).toBe(39);
    expect(migration.name).toBe("ah7_reconciliation_attempts");
    expect(migrations.P36_MIGRATIONS.map(({ id }) => id).at(-1)).toBe(36);
    const maintenanceMigrations = migrations.P39_MAINTENANCE_MIGRATIONS;
    expect(maintenanceMigrations.map(({ id }) => id)).toEqual([37, 38, 39]);
    expect(Object.isFrozen(maintenanceMigrations)).toBe(true);
    expect(Object.isFrozen(migration)).toBe(true);
    for (const approved of maintenanceMigrations) {
      const pin = migrations.P39_MAINTENANCE_MIGRATION_MANIFEST[approved.id];
      expect(Object.isFrozen(pin)).toBe(true);
      expect(pin).toEqual({
        name: approved.name,
        sha256: sha256Hex(approved.sql),
      });
    }
  });

  it("keeps the operator sidecar report immutable and rejects replacement", async () => {
    const result = await withClient(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        for (const statement of splitStatements(P39_REPORT_DATABASE_DDL)) {
          yield* sql.unsafe(statement);
        }
        const databaseFingerprint = "f".repeat(64);
        const body = JSON.stringify({
          schema: "p39-migration-block-report/v1",
          kind: "LegacyActiveNotAdmitted",
          observedUserVersion: 36,
          targetUserVersion: 39,
          databaseFingerprint,
          blockerStateFingerprint: "a".repeat(64),
          blockedInvocationIds: ["tin_legacy"],
        });
        const report = {
          reportKey: sha256Hex(
            JSON.stringify({
              schema: "p39-migration-block-report/v1",
              targetUserVersion: 39,
              databaseFingerprint,
            }),
          ),
          contentHash: sha256Hex(body),
          reportJson: body,
          observedUserVersion: 36,
          targetUserVersion: 39 as const,
          databaseFingerprint,
          blockedInvocationIds: ["tin_legacy"],
          blockerStateFingerprint: "a".repeat(64),
        };
        const stored = yield* writeP39BlockReportAndReadBack(report);
        const duplicate = yield* writeP39BlockReportAndReadBack(report);
        const update = yield* Effect.exit(
          sql.unsafe(
            "UPDATE p39_migration_block_reports SET report_json = '{}' WHERE report_key = ?",
            [report.reportKey],
          ),
        );
        const remove = yield* Effect.exit(
          sql.unsafe(
            "DELETE FROM p39_migration_block_reports WHERE report_key = ?",
            [report.reportKey],
          ),
        );
        const rows = yield* sql.unsafe<{ report_key: string }>(
          "SELECT report_key FROM p39_migration_block_reports",
        );
        return {
          stored,
          duplicate,
          update,
          remove,
          rows,
          reportKey: report.reportKey,
        };
      }),
    );
    expect(result.stored).toEqual({
      reportKey: result.reportKey,
      contentHash: expect.any(String),
    });
    expect(result.duplicate).toEqual(result.stored);
    expect(result.update._tag).toBe("Failure");
    expect(result.remove._tag).toBe("Failure");
    expect(result.rows.map(({ report_key }) => report_key)).toEqual([
      result.reportKey,
    ]);
  });

  it("reads back verified blocker report JSON for the operator", async () => {
    const result = await withClient(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        for (const statement of splitStatements(P39_REPORT_DATABASE_DDL)) {
          yield* sql.unsafe(statement);
        }
        const databaseFingerprint = "f".repeat(64);
        const body = JSON.stringify({
          schema: "p39-migration-block-report/v1",
          kind: "LegacyActiveNotAdmitted",
          observedUserVersion: 38,
          targetUserVersion: 39,
          databaseFingerprint,
          blockerStateFingerprint: "a".repeat(64),
          blockedInvocationIds: ["tin_legacy"],
        });
        const report = {
          reportKey: sha256Hex(
            JSON.stringify({
              schema: "p39-migration-block-report/v1",
              targetUserVersion: 39,
              databaseFingerprint,
            }),
          ),
          contentHash: sha256Hex(body),
          reportJson: body,
          observedUserVersion: 38,
          targetUserVersion: 39 as const,
          databaseFingerprint,
          blockedInvocationIds: ["tin_legacy"],
          blockerStateFingerprint: "a".repeat(64),
        };
        yield* writeP39BlockReportAndReadBack(report);
        return yield* readP39BlockReports();
      }),
    );

    expect(result).toHaveLength(1);
    expect(JSON.parse(result[0]?.reportJson ?? "{}")).toMatchObject({
      kind: "LegacyActiveNotAdmitted",
      observedUserVersion: 38,
      blockedInvocationIds: ["tin_legacy"],
    });
    expect(result[0]?.contentHash).toBe(sha256Hex(result[0]?.reportJson ?? ""));
  });

  it("initializes and revalidates only the exact reserved sidecar schema", async () => {
    const directory = mkdtempSync(join(process.cwd(), ".p39-sidecar-test-"));
    const primary = join(directory, "primary.sqlite");
    const sidecar = join(directory, "reports.sqlite");
    try {
      writeFileSync(primary, "");
      const normalized = await Effect.runPromise(
        validateP39ReportSidecarPath(primary, sidecar),
      );
      expect(normalized.endsWith("reports.sqlite")).toBe(true);
      await Effect.runPromise(
        validateP39ReportSidecarDatabase(primary, sidecar),
      );
      const sidecarIdentityBefore = statSync(sidecar, { bigint: true });
      await Effect.runPromise(
        validateP39ReportSidecarDatabase(primary, sidecar),
      );
      const sidecarIdentityAfter = statSync(sidecar, { bigint: true });
      expect(sidecarIdentityAfter.dev).toBe(sidecarIdentityBefore.dev);
      expect(sidecarIdentityAfter.ino).toBe(sidecarIdentityBefore.ino);
      const samePath = await Effect.runPromise(
        Effect.flip(validateP39ReportSidecarPath(primary, primary)),
      );
      expect(samePath.code).toBe("P39_REPORT_DB_PATH_INVALID");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects temporary sidecars and hard-linked database identities", async () => {
    const directory = mkdtempSync(join(process.cwd(), ".p39-alias-test-"));
    const primary = join(directory, "primary.sqlite");
    const localReport = join(directory, "reports.sqlite");
    const hardLink = join(directory, "primary-hardlink.sqlite");
    try {
      writeFileSync(primary, "");
      linkSync(primary, hardLink);
      const hardLinkDenied = await Effect.runPromise(
        Effect.flip(validateP39ReportSidecarPath(primary, localReport)),
      );
      const tempDenied = await Effect.runPromise(
        Effect.flip(
          validateP39ReportSidecarPath(
            primary,
            join(tmpdir(), "p39-report-sidecar.sqlite"),
          ),
        ),
      );
      const otherStore = join(directory, "other-store.sqlite");
      writeFileSync(otherStore, "");
      const otherStoreAliasDenied = await Effect.runPromise(
        Effect.flip(
          validateP39ReportSidecarPath(primary, otherStore, [otherStore]),
        ),
      );

      expect(hardLinkDenied.code).toBe("P39_REPORT_DB_PATH_INVALID");
      expect(tempDenied.code).toBe("P39_REPORT_DB_PATH_INVALID");
      expect(otherStoreAliasDenied.code).toBe("P39_REPORT_DB_PATH_INVALID");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("derives one shared writer-lock identity and rejects primary hard links", () => {
    const directory = mkdtempSync(
      join(process.cwd(), ".p39-writer-lock-test-"),
    );
    const primary = join(directory, "primary.sqlite");
    const hardLink = join(directory, "primary-hardlink.sqlite");
    try {
      const prepared = prepareP39PrimaryDatabasePath(primary);
      expect("databaseFilename" in prepared).toBe(true);
      if (!("databaseFilename" in prepared)) return;
      expect(p39WriterLockFilename(primary)).toBe(prepared.writerLockFilename);
      linkSync(primary, hardLink);
      expect(typeof p39WriterLockFilename(hardLink)).not.toBe("string");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses a primary-shared lock path across user-root settings and rejects symlink aliases", () => {
    const directory = mkdtempSync(
      join(process.cwd(), ".p39-writer-alias-test-"),
    );
    const primary = join(directory, "primary.sqlite");
    const alias = join(directory, "primary-alias.sqlite");
    const savedLocalAppData = process.env.LOCALAPPDATA;
    const savedXdgStateHome = process.env.XDG_STATE_HOME;
    try {
      const prepared = prepareP39PrimaryDatabasePath(primary);
      expect("databaseFilename" in prepared).toBe(true);
      if (!("databaseFilename" in prepared)) return;
      process.env.LOCALAPPDATA = join(directory, "account-a-state");
      process.env.XDG_STATE_HOME = join(directory, "account-a-state");
      const accountAPath = p39WriterLockFilename(primary);
      process.env.LOCALAPPDATA = join(directory, "account-b-state");
      process.env.XDG_STATE_HOME = join(directory, "account-b-state");
      const accountBPath = p39WriterLockFilename(primary);
      expect(accountBPath).toBe(accountAPath);
      expect(accountAPath).toBe(prepared.writerLockFilename);

      if (process.platform === "win32") linkSync(primary, alias);
      else symlinkSync(primary, alias);
      expect(typeof p39WriterLockFilename(alias)).not.toBe("string");
    } finally {
      if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = savedLocalAppData;
      if (savedXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = savedXdgStateHome;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a lock or sidecar parent is world-writable", () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(
      join(process.cwd(), ".p39-unprotected-parent-test-"),
    );
    try {
      chmodSync(directory, 0o777);
      expect(validateP39ProtectedDirectory(directory)).toBe(false);
    } finally {
      chmodSync(directory, 0o700);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("checks a primary parent before creating a missing database file", () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(
      join(process.cwd(), ".p39-primary-parent-preflight-test-"),
    );
    const primary = join(directory, "primary.sqlite");
    try {
      chmodSync(directory, 0o777);
      const prepared = prepareP39PrimaryDatabasePath(primary);
      expect("databaseFilename" in prepared).toBe(false);
      expect(existsSync(primary)).toBe(false);
    } finally {
      chmodSync(directory, 0o700);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts same-owner deployment identity and rejects another OS account", () => {
    expect(
      p39SameOperatingSystemIdentity("sid:S-1-5-21-100", "sid:S-1-5-21-100"),
    ).toBe(true);
    expect(
      p39SameOperatingSystemIdentity("sid:S-1-5-21-100", "sid:S-1-5-21-200"),
    ).toBe(false);
    expect(p39SameOperatingSystemIdentity("uid:1000", "uid:1001")).toBe(false);
  });

  it("requires the exact 0037→0038→0039 suffix and refuses service at user_version 39", async () => {
    const exact = await Effect.runPromise(
      validateP39MigrationPrefix(36, [{ id: 37 }, { id: 38 }, { id: 39 }]),
    );
    const skipped = await Effect.runPromise(
      Effect.flip(validateP39MigrationPrefix(36, [{ id: 39 }])),
    );
    const service = await Effect.runPromise(
      Effect.flip(requireP39RuntimeSchema(39)),
    );
    const p40ServiceOnP39Runtime = await Effect.runPromise(
      Effect.flip(requireP39RuntimeSchema(40)),
    );

    expect(exact.map(({ id }) => id)).toEqual([37, 38, 39]);
    expect(skipped.code).toBe("P39_MIGRATION_PREFIX_INVALID");
    expect(service.code).toBe("P39_RUNTIME_START_REFUSED");
    expect(p40ServiceOnP39Runtime.code).toBe("P39_RUNTIME_START_REFUSED");
  });

  it("creates the immutable fact ledger and defers selected-fact provenance to COMMIT", async () => {
    const migration = getP39Migration();
    expect(migration, "P39 migration module is missing").toBeDefined();
    if (!migration) return;

    const result = await withClient(
      Effect.gen(function* () {
        yield* runMigrations(migrations.P36_MIGRATIONS);
        yield* runMigrations([...migrations.P36_MIGRATIONS, migration]);
        const sql = yield* SqlClient;
        const version = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        const tables = yield* sql.unsafe<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name IN ('tool_invocation_recovery_bindings',
                        'tool_invocation_effect_attempts',
                        'tool_reconciliation_facts') ORDER BY name`,
        );
        const columns = yield* sql.unsafe<{ name: string }>(
          'PRAGMA table_info("tool_invocations")',
        );
        const foreignKeys = yield* sql.unsafe<{
          readonly table: string;
          readonly from: string;
          readonly to: string;
        }>('PRAGMA foreign_key_list("tool_invocations")');
        return {
          version: Number(version[0]?.user_version),
          tables: tables.map(({ name }) => name),
          columns: columns.map(({ name }) => name),
          selectedFactForeignKey: foreignKeys.filter(
            ({ table }) => table === "tool_reconciliation_facts",
          ),
        };
      }),
    );

    expect(result.version).toBe(39);
    expect(result.tables).toEqual([
      "tool_invocation_effect_attempts",
      "tool_invocation_recovery_bindings",
      "tool_reconciliation_facts",
    ]);
    expect(result.columns).toEqual(
      expect.arrayContaining([
        "recovery_binding_state",
        "recovery_binding_sha256",
        "settlement_provenance",
        "selected_attempt_no",
        "selected_fact_id",
      ]),
    );
    expect(result.selectedFactForeignKey).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "tool_reconciliation_facts",
          from: "invocation_id",
          to: "invocation_id",
        }),
        expect.objectContaining({
          table: "tool_reconciliation_facts",
          from: "selected_attempt_no",
          to: "attempt_no",
        }),
        expect.objectContaining({
          table: "tool_reconciliation_facts",
          from: "selected_fact_id",
          to: "fact_id",
        }),
      ]),
    );
  });

  it("enforces the DeniedUnbound row shape and only the two allowed projection exits", async () => {
    const migration = getP39Migration();
    expect(migration, "P39 migration module is missing").toBeDefined();
    if (!migration) return;

    const result = await withClient(
      Effect.gen(function* () {
        yield* runMigrations(migrations.P36_MIGRATIONS);
        yield* runMigrations([...migrations.P36_MIGRATIONS, migration]);
        const sql = yield* SqlClient;
        yield* sql.unsafe("PRAGMA foreign_keys = OFF");

        const insertLegacy = (invocationId: string) =>
          sql.unsafe(
            `INSERT INTO tool_invocations (
               invocation_id, execution_id, workspace_id, tool_name, tool_version,
               side_effect_semantics, arguments_json, resolved_regions_json,
               approval_id, effect_admission_state, recovery_binding_state,
               recovery_binding_sha256, settlement_provenance,
               selected_attempt_no, selected_fact_id, intent_at, settled_at,
               settlement_kind, settlement_json, result_ref
             ) VALUES (?, 'exe_test', 'ws_test', 'read', '1', 'ReadOnly',
                       '{}', '[]', NULL, 'NotAdmitted', 'LegacyBindingUnproven',
                       NULL, NULL, NULL, NULL, 't1', NULL, NULL, NULL, NULL)`,
            [invocationId],
          );
        const deniedJson = JSON.stringify({
          _tag: "Denied",
          reasonCode: "ResourceAdmissionDenied",
          projectionVersion: 1,
        });
        const insertDeniedUnbound = (invocationId: string) =>
          sql.unsafe(
            `INSERT INTO tool_invocations (
               invocation_id, execution_id, workspace_id, tool_name, tool_version,
               side_effect_semantics, arguments_json, resolved_regions_json,
               approval_id, effect_admission_state, recovery_binding_state,
               recovery_binding_sha256, settlement_provenance,
               selected_attempt_no, selected_fact_id, intent_at, settled_at,
               settlement_kind, settlement_json, result_ref
             ) VALUES (?, 'exe_test', 'ws_test', 'read', '1', 'ReadOnly',
                       '{}', '[]', NULL, 'NotAdmitted', 'DeniedUnbound',
                       NULL, 'Ordinary', NULL, NULL, 't1', 't2', 'Denied', ?, NULL)`,
            [invocationId, deniedJson],
          );

        yield* insertDeniedUnbound("tin_denied_unbound_valid");
        yield* insertLegacy("tin_denied_unbound_transition");
        const legacyTransition = yield* sql.withTransaction(
          sql.unsafe(
            `UPDATE tool_invocations
                SET recovery_binding_state='DeniedUnbound', settled_at='t2',
                    settlement_kind='Denied', settlement_json=?,
                    settlement_provenance='Ordinary'
              WHERE invocation_id='tin_denied_unbound_transition'
              RETURNING invocation_id`,
            [deniedJson],
          ),
        );

        yield* insertLegacy("tin_bound_transition");
        const bindingSha = "a".repeat(64);
        yield* sql.unsafe(
          `INSERT INTO tool_invocation_recovery_bindings (
             invocation_id, binding_version, canonical_binding_json,
             binding_sha256, created_at
           ) VALUES ('tin_bound_transition',1,'{}',?,'t1')`,
          [bindingSha],
        );
        const claimTransition = yield* sql.withTransaction(
          sql.unsafe(
            `UPDATE tool_invocations
                SET recovery_binding_state='Bound', recovery_binding_sha256=?
              WHERE invocation_id='tin_bound_transition'
              RETURNING invocation_id`,
            [bindingSha],
          ),
        );

        const invalidMayHaveStarted = yield* Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* insertDeniedUnbound(
                "tin_denied_unbound_invalid_admission",
              );
              yield* sql.unsafe(
                `UPDATE tool_invocations SET effect_admission_state='MayHaveStarted'
                  WHERE invocation_id='tin_denied_unbound_invalid_admission'`,
              );
              return true;
            }),
          ),
        );
        const invalidResultRef = yield* Effect.exit(
          sql.withTransaction(
            sql.unsafe(
              `INSERT INTO tool_invocations (
                 invocation_id, execution_id, workspace_id, tool_name, tool_version,
                 side_effect_semantics, arguments_json, resolved_regions_json,
                 approval_id, effect_admission_state, recovery_binding_state,
                 recovery_binding_sha256, settlement_provenance,
                 selected_attempt_no, selected_fact_id, intent_at, settled_at,
                 settlement_kind, settlement_json, result_ref
               ) VALUES ('tin_denied_unbound_invalid_result','exe_test','ws_test','read','1',
                         'ReadOnly','{}','[]',NULL,'NotAdmitted','DeniedUnbound',NULL,
                         'Ordinary',NULL,NULL,'t1','t2','Denied',?,'art_missing')`,
              [deniedJson],
            ),
          ),
        );
        const deniedCannotAcquireBinding = yield* Effect.exit(
          sql.withTransaction(
            sql.unsafe(
              `INSERT INTO tool_invocation_recovery_bindings (
                 invocation_id,binding_version,canonical_binding_json,binding_sha256,created_at
               ) VALUES ('tin_denied_unbound_valid',1,'{}',?,'t3')`,
              ["b".repeat(64)],
            ),
          ),
        );
        const deniedCannotAcquireAttempt = yield* Effect.exit(
          sql.withTransaction(
            sql.unsafe(
              `INSERT INTO tool_invocation_effect_attempts (
                 invocation_id,attempt_no,admission_state,tool_definition_hash,
                 side_effect_semantics,profile_id,profile_version,profile_hash,
                 profile_protocol,effect_key,binding_sha256,admitted_at,
                 admission_source,admission_time_precision
               ) VALUES ('tin_denied_unbound_valid',0,'NotAdmitted',NULL,'ReadOnly',
                         NULL,NULL,NULL,NULL,NULL,NULL,NULL,'P39Claim','NotAdmitted')`,
            ),
          ),
        );
        const deniedCannotBecomeBound = yield* Effect.exit(
          sql.withTransaction(
            sql.unsafe(
              `UPDATE tool_invocations
                  SET recovery_binding_state='Bound', recovery_binding_sha256=?
                WHERE invocation_id='tin_denied_unbound_valid'`,
              ["c".repeat(64)],
            ),
          ),
        );
        const rows = yield* sql.unsafe<{
          readonly invocation_id: string;
          readonly recovery_binding_state: string;
          readonly settlement_kind: string | null;
          readonly settlement_provenance: string | null;
        }>(
          `SELECT invocation_id, recovery_binding_state, settlement_kind,
                  settlement_provenance
             FROM tool_invocations
            WHERE invocation_id IN ('tin_denied_unbound_valid',
                                     'tin_denied_unbound_transition',
                                     'tin_bound_transition')
            ORDER BY invocation_id`,
        );
        return {
          legacyTransition: legacyTransition.length,
          claimTransition: claimTransition.length,
          invalidMayHaveStarted,
          invalidResultRef,
          deniedCannotAcquireBinding,
          deniedCannotAcquireAttempt,
          deniedCannotBecomeBound,
          rows,
        };
      }),
    );
    expect(result.legacyTransition).toBe(1);
    expect(result.claimTransition).toBe(1);
    expect(result.invalidMayHaveStarted._tag).toBe("Failure");
    expect(result.invalidResultRef._tag).toBe("Failure");
    expect(result.deniedCannotAcquireBinding._tag).toBe("Failure");
    expect(result.deniedCannotAcquireAttempt._tag).toBe("Failure");
    expect(result.deniedCannotBecomeBound._tag).toBe("Failure");
    expect(result.rows).toEqual([
      {
        invocation_id: "tin_bound_transition",
        recovery_binding_state: "Bound",
        settlement_kind: null,
        settlement_provenance: null,
      },
      {
        invocation_id: "tin_denied_unbound_transition",
        recovery_binding_state: "DeniedUnbound",
        settlement_kind: "Denied",
        settlement_provenance: "Ordinary",
      },
      {
        invocation_id: "tin_denied_unbound_valid",
        recovery_binding_state: "DeniedUnbound",
        settlement_kind: "Denied",
        settlement_provenance: "Ordinary",
      },
    ]);
  });

  it("rejects Success from NotOccurred, allows ExpectedFailure with a distinct external result Artifact, and rejects cross-attempt selection", async () => {
    const migration = getP39Migration();
    expect(migration, "P39 migration module is missing").toBeDefined();
    if (!migration) return;
    const result = await withClient(
      Effect.gen(function* () {
        yield* runMigrations(migrations.P36_MIGRATIONS);
        yield* runMigrations([...migrations.P36_MIGRATIONS, migration]);
        const sql = yield* SqlClient;
        yield* sql.unsafe("PRAGMA foreign_keys = OFF");
        const invocationId = "tin_p39_selected_fact";
        const bindingSha256 = "a".repeat(64);
        const profileHash = "b".repeat(64);
        const evidenceHash = "c".repeat(64);
        yield* sql.unsafe(
          `INSERT INTO tool_invocations (
            invocation_id, execution_id, workspace_id, tool_name, tool_version,
            side_effect_semantics, arguments_json, resolved_regions_json,
            approval_id, effect_admission_state, recovery_binding_state,
            recovery_binding_sha256, settlement_provenance, selected_attempt_no,
            selected_fact_id, intent_at, settled_at, settlement_kind,
            settlement_json, result_ref
          ) VALUES (?,?,?,?,?,?,?,?,?,'MayHaveStarted','Bound',?,NULL,NULL,NULL,
                    't0',NULL,NULL,NULL,NULL)`,
          [
            invocationId,
            "exe_fake",
            "ws_fake",
            "shell",
            "3",
            "Reconcilable",
            "{}",
            "[]",
            null,
            bindingSha256,
          ],
        );
        yield* sql.unsafe(
          `INSERT INTO tool_invocation_recovery_bindings
            (invocation_id,binding_version,canonical_binding_json,binding_sha256,created_at)
           VALUES (?,1,?,?,?)`,
          [invocationId, '{"bindingVersion":1}', bindingSha256, "t0"],
        );
        yield* sql.unsafe(
          `INSERT INTO tool_invocation_effect_attempts (
            invocation_id,attempt_no,admission_state,tool_definition_hash,
            side_effect_semantics,profile_id,profile_version,profile_hash,
            profile_protocol,effect_key,binding_sha256,admitted_at,
            admission_source,admission_time_precision
          ) VALUES (?,0,'MayHaveStarted',?,'Reconcilable','profile','1',?,'v1',?,?,'t1',
                    'P39Admission','TransactionTimestamp')`,
          [
            invocationId,
            "d".repeat(64),
            profileHash,
            "effect-1",
            bindingSha256,
          ],
        );
        yield* sql.unsafe(
          `INSERT INTO artifacts (artifact_id,kind,blob_ref,byte_size,content_hash,
                                  invocation_id,execution_id,created_at)
           VALUES ('art_p39_evidence','Proof','blob:evidence',10,?,NULL,NULL,'t1'),
                  ('art_p39_result','Result','blob:result',10,?,NULL,NULL,'t1')`,
          [evidenceHash, "e".repeat(64)],
        );
        yield* sql.unsafe(
          `INSERT INTO tool_reconciliation_facts (
            fact_id,invocation_id,attempt_no,binding_sha256,profile_hash,effect_key,
            fact_origin,legacy_reason,fact_disposition,outcome,reason_code,
            evidence_ref,evidence_sha256,result_ref,observed_at
          ) VALUES (?,?,0,?,?,?,'ProfileReconciliation',NULL,'RecoveryInput',
                    'NotOccurred',NULL,'art_p39_evidence',?,NULL,'t2')`,
          [
            "f".repeat(64),
            invocationId,
            bindingSha256,
            profileHash,
            "effect-1",
            evidenceHash,
          ],
        );
        yield* sql.unsafe("PRAGMA foreign_keys = ON");

        const fabricatedSuccess = yield* Effect.exit(
          sql.withTransaction(
            sql.unsafe(
              `UPDATE tool_invocations SET settled_at='t3', settlement_kind='Success',
                 settlement_json='{}', result_ref='art_p39_result',
                 settlement_provenance='Reconciliation', selected_attempt_no=0,
                 selected_fact_id=? WHERE invocation_id=?`,
              ["f".repeat(64), invocationId],
            ),
          ),
        );
        const crossAttemptSelection = yield* Effect.exit(
          sql.withTransaction(
            sql.unsafe(
              `UPDATE tool_invocations SET settled_at='t3', settlement_kind='ReconciledNoEffect',
                 settlement_json='{"reasonCode":"StopRequested"}', result_ref='art_p39_result',
                 settlement_provenance='Reconciliation', selected_attempt_no=1,
                 selected_fact_id=? WHERE invocation_id=?`,
              ["f".repeat(64), invocationId],
            ),
          ),
        );
        const afterRejected = yield* sql.unsafe<{
          readonly settled_at: string | null;
          readonly settlement_kind: string | null;
        }>(
          "SELECT settled_at, settlement_kind FROM tool_invocations WHERE invocation_id = ?",
          [invocationId],
        );
        yield* sql.unsafe(
          `INSERT INTO tool_reconciliation_facts (
            fact_id,invocation_id,attempt_no,binding_sha256,profile_hash,effect_key,
            fact_origin,legacy_reason,fact_disposition,outcome,reason_code,
            evidence_ref,evidence_sha256,result_ref,observed_at
          ) VALUES (?,?,0,?,?,?,'ProfileReconciliation',NULL,'RecoveryInput',
                    'Occurred',NULL,'art_p39_evidence',?, 'art_p39_result','t4')`,
          [
            "9".repeat(64),
            invocationId,
            bindingSha256,
            profileHash,
            "effect-1",
            evidenceHash,
          ],
        );
        const expectedFailure = yield* Effect.exit(
          sql.withTransaction(
            sql.unsafe(
              `UPDATE tool_invocations SET settled_at='t5', settlement_kind='ExpectedFailure',
                 settlement_json='{}', result_ref=NULL,
                 settlement_provenance='Reconciliation', selected_attempt_no=0,
                 selected_fact_id=? WHERE invocation_id=?`,
              ["9".repeat(64), invocationId],
            ),
          ),
        );
        const final = yield* sql.unsafe<{
          readonly settled_at: string | null;
          readonly settlement_kind: string | null;
        }>(
          "SELECT settled_at, settlement_kind FROM tool_invocations WHERE invocation_id = ?",
          [invocationId],
        );
        return {
          fabricatedSuccess,
          crossAttemptSelection,
          afterRejected: afterRejected[0],
          expectedFailure,
          final: final[0],
        };
      }),
    );
    expect(result.fabricatedSuccess._tag).toBe("Failure");
    expect(result.crossAttemptSelection._tag).toBe("Failure");
    expect(result.expectedFailure._tag).toBe("Success");
    expect(result.afterRejected).toEqual({
      settled_at: null,
      settlement_kind: null,
    });
    expect(result.final).toEqual({
      settled_at: "t5",
      settlement_kind: "ExpectedFailure",
    });
  });

  it("keeps writer exclusion through migration and releases it after success", async () => {
    const order: string[] = [];
    let writerLockHeld = false;
    const result = await withClient(
      runP39MaintenanceGate({
        acquireWriterExclusion: () =>
          Effect.sync(() => {
            order.push("acquire-writer-exclusion");
            writerLockHeld = true;
            return { token: "lease-1" };
          }),
        releaseWriterExclusion: (lease) =>
          Effect.sync(() => {
            expect(lease.token).toBe("lease-1");
            order.push("release-writer-exclusion");
            writerLockHeld = false;
          }),
        reservePrimarySnapshot: (lease) =>
          Effect.sync(() => {
            expect(lease.token).toBe("lease-1");
            order.push("reserve-primary-snapshot");
            return {
              reservation: "snapshot-1",
              snapshot: {
                userVersion: 38,
                databaseFingerprint: "db-fingerprint",
                activeNotAdmittedInvocations: [],
              },
            };
          }),
        releasePrimarySnapshot: (lease, reservation) =>
          Effect.sync(() => {
            expect(lease.token).toBe("lease-1");
            expect(reservation.reservation).toBe("snapshot-1");
            order.push("release-primary-snapshot");
          }),
        writeAndReadBackSidecarReport: () =>
          Effect.die(new Error("no blockers means no sidecar write")),
        applyOrderedMigrations: (lease) =>
          Effect.sync(() => {
            expect(writerLockHeld).toBe(true);
            expect(lease.token).toBe("lease-1");
            order.push("apply-ordered-migrations");
          }),
      }),
    );

    expect(result).toBeUndefined();
    expect(order).toEqual([
      "acquire-writer-exclusion",
      "reserve-primary-snapshot",
      "apply-ordered-migrations",
      "release-primary-snapshot",
      "release-writer-exclusion",
    ]);
    expect(writerLockHeld).toBe(false);
  });

  it("fails closed at user_version 39 before any sidecar write or migration", async () => {
    const order: string[] = [];
    const result = await withClient(
      Effect.flip(
        runP39MaintenanceGate({
          acquireWriterExclusion: () =>
            Effect.sync(() => {
              order.push("acquire-lock");
              return { token: "version-39-lease" };
            }),
          releaseWriterExclusion: () =>
            Effect.sync(() => {
              order.push("release-lock");
            }),
          reservePrimarySnapshot: () =>
            Effect.sync(() => {
              order.push("reserve-primary");
              return {
                reservation: "old-version-39",
                snapshot: {
                  userVersion: 39,
                  databaseFingerprint: "f".repeat(64),
                  activeNotAdmittedInvocations: [],
                },
              };
            }),
          releasePrimarySnapshot: () =>
            Effect.sync(() => {
              order.push("release-primary");
            }),
          writeAndReadBackSidecarReport: () =>
            Effect.sync(() => {
              order.push("sidecar-write");
              return { reportKey: "unexpected", contentHash: "unexpected" };
            }),
          applyOrderedMigrations: () =>
            Effect.sync(() => {
              order.push("migration");
            }),
        }),
      ),
    );

    expect(result._tag).toBe("P39MaintenanceFailure");
    if (result._tag === "P39MaintenanceFailure") {
      expect(result.code).toBe("P39_MIGRATION_PREFIX_INVALID");
    }
    expect(order).toEqual([
      "acquire-lock",
      "reserve-primary",
      "release-primary",
      "release-lock",
    ]);
  });

  it("retains writer exclusion through migration failure and then releases both reservations", async () => {
    const order: string[] = [];
    let writerLockHeld = false;
    const outcome = await withClient(
      Effect.flip(
        runP39MaintenanceGate({
          acquireWriterExclusion: () =>
            Effect.sync(() => {
              order.push("acquire-writer-exclusion");
              writerLockHeld = true;
              return { token: "lease-failure" };
            }),
          releaseWriterExclusion: () =>
            Effect.sync(() => {
              order.push("release-writer-exclusion");
              writerLockHeld = false;
            }),
          reservePrimarySnapshot: () =>
            Effect.sync(() => {
              order.push("reserve-primary-snapshot");
              return {
                reservation: "snapshot-failure",
                snapshot: {
                  userVersion: 38,
                  databaseFingerprint: "db-fingerprint",
                  activeNotAdmittedInvocations: [],
                },
              };
            }),
          releasePrimarySnapshot: () =>
            Effect.sync(() => {
              order.push("release-primary-snapshot");
            }),
          writeAndReadBackSidecarReport: () =>
            Effect.die(new Error("no blockers means no sidecar write")),
          applyOrderedMigrations: () =>
            Effect.gen(function* () {
              expect(writerLockHeld).toBe(true);
              order.push("migration-failed");
              return yield* Effect.fail({
                _tag: "SqliteAdapterError" as const,
                message: "migration failure",
              });
            }),
        }),
      ),
    );

    expect(outcome._tag).toBe("SqliteAdapterError");
    expect(order).toEqual([
      "acquire-writer-exclusion",
      "reserve-primary-snapshot",
      "migration-failed",
      "release-primary-snapshot",
      "release-writer-exclusion",
    ]);
    expect(writerLockHeld).toBe(false);
  });

  it("fails closed for active legacy rows after exact sidecar readback under the same lease", async () => {
    const order: string[] = [];
    let writerLockHeld = false;
    let savedReport:
      | {
          readonly blockedInvocationIds: ReadonlyArray<string>;
          readonly targetUserVersion: 39;
        }
      | undefined;
    const outcome = await withClient(
      Effect.flip(
        runP39MaintenanceGate({
          acquireWriterExclusion: () =>
            Effect.sync(() => {
              order.push("acquire-writer-exclusion");
              writerLockHeld = true;
              return { token: "lease-1" };
            }),
          releaseWriterExclusion: (lease) =>
            Effect.sync(() => {
              expect(lease.token).toBe("lease-1");
              order.push("release-writer-exclusion");
              writerLockHeld = false;
            }),
          reservePrimarySnapshot: (lease) =>
            Effect.sync(() => {
              expect(lease.token).toBe("lease-1");
              order.push("reserve-primary-snapshot");
              return {
                reservation: "snapshot-1",
                snapshot: {
                  userVersion: 36,
                  databaseFingerprint: "db-fingerprint",
                  activeNotAdmittedInvocations: [
                    {
                      invocationId: "tin_b",
                      executionId: "exe_b",
                      sideEffectSemantics: "Reconcilable",
                      effectAdmissionState: "NotAdmitted",
                      unsettled: true,
                      approvalId: null,
                    },
                    {
                      invocationId: "tin_a",
                      executionId: "exe_a",
                      sideEffectSemantics: "NonIdempotent",
                      effectAdmissionState: "NotAdmitted",
                      unsettled: true,
                      approvalId: "approval_a",
                    },
                  ],
                },
              };
            }),
          releasePrimarySnapshot: (lease, reservation) =>
            Effect.sync(() => {
              expect(lease.token).toBe("lease-1");
              expect(reservation.reservation).toBe("snapshot-1");
              order.push("release-primary-snapshot");
            }),
          writeAndReadBackSidecarReport: (lease, reservation, report) =>
            Effect.sync(() => {
              expect(writerLockHeld).toBe(true);
              expect(lease.token).toBe("lease-1");
              expect(reservation.reservation).toBe("snapshot-1");
              order.push("sidecar-write-readback");
              savedReport = report;
              return {
                reportKey: report.reportKey,
                contentHash: report.contentHash,
              };
            }),
          applyOrderedMigrations: () =>
            Effect.sync(() => {
              order.push("apply-migrations");
            }),
        }),
      ),
    );

    if (!("code" in outcome))
      throw new Error("maintenance gate unexpectedly succeeded");
    expect(outcome.code).toBe("P39_LEGACY_DB_ISOLATED");
    expect(order).toEqual([
      "acquire-writer-exclusion",
      "reserve-primary-snapshot",
      "sidecar-write-readback",
      "release-primary-snapshot",
      "release-writer-exclusion",
    ]);
    expect(writerLockHeld).toBe(false);
    expect(savedReport?.blockedInvocationIds).toEqual(["tin_a", "tin_b"]);
    expect(savedReport?.targetUserVersion).toBe(39);
  });
});
