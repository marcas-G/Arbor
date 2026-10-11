import { mkdtempSync, rmSync } from "node:fs";
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
    const directory = mkdtempSync(join(tmpdir(), "arbor-p39-sidecar-"));
    const primary = join(directory, "primary.sqlite");
    const sidecar = join(directory, "reports.sqlite");
    try {
      const normalized = await Effect.runPromise(
        validateP39ReportSidecarPath(primary, sidecar),
      );
      expect(normalized.endsWith("reports.sqlite")).toBe(true);
      await Effect.runPromise(
        validateP39ReportSidecarDatabase(primary, sidecar),
      );
      await Effect.runPromise(
        validateP39ReportSidecarDatabase(primary, sidecar),
      );
      const samePath = await Effect.runPromise(
        Effect.flip(validateP39ReportSidecarPath(primary, primary)),
      );
      expect(samePath.code).toBe("P39_REPORT_DB_PATH_INVALID");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

    expect(exact.map(({ id }) => id)).toEqual([37, 38, 39]);
    expect(skipped.code).toBe("P39_MIGRATION_PREFIX_INVALID");
    expect(service.code).toBe("P39_RUNTIME_START_REFUSED");
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
        {
          table: "tool_reconciliation_facts",
          from: "invocation_id",
          to: "invocation_id",
        },
        {
          table: "tool_reconciliation_facts",
          from: "selected_attempt_no",
          to: "attempt_no",
        },
        {
          table: "tool_reconciliation_facts",
          from: "selected_fact_id",
          to: "fact_id",
        },
      ]),
    );
  });

  it("rejects a fabricated Success and a selected fact from another attempt", async () => {
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
            "g".repeat(64),
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
              ["g".repeat(64), invocationId],
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

  it("treats a repeated P39 maintenance invocation at user_version 39 as a no-op", async () => {
    const order: string[] = [];
    const result = await withClient(
      runP39MaintenanceGate({
        acquireWriterExclusion: () =>
          Effect.sync(() => {
            order.push("acquire-lock");
            return { token: "repeat-lease" };
          }),
        releaseWriterExclusion: () =>
          Effect.sync(() => {
            order.push("release-lock");
          }),
        reservePrimarySnapshot: () =>
          Effect.sync(() => ({
            reservation: "already-p39",
            snapshot: {
              userVersion: 39,
              databaseFingerprint: "f".repeat(64),
              activeNotAdmittedInvocations: [],
            },
          })),
        releasePrimarySnapshot: () =>
          Effect.sync(() => {
            order.push("release-primary");
          }),
        writeAndReadBackSidecarReport: () =>
          Effect.die(new Error("P39 no-op must not write a blocker report")),
        applyOrderedMigrations: () =>
          Effect.die(new Error("P39 no-op must not rerun migration SQL")),
      }),
    );

    expect(result).toBeUndefined();
    expect(order).toEqual(["acquire-lock", "release-primary", "release-lock"]);
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
