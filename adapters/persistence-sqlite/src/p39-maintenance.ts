import { sha256Hex } from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { SqliteAdapterError } from "./errors.js";

export const P39_REPORT_APPLICATION_ID = 0x41523739;
export const P39_REPORT_USER_VERSION = 1;

export const P39_REPORT_DATABASE_DDL = `
CREATE TABLE p39_migration_block_reports (
  report_key TEXT PRIMARY KEY CHECK
    (length(report_key) = 64 AND report_key NOT GLOB '*[^0-9a-f]*'),
  content_hash TEXT NOT NULL UNIQUE CHECK
    (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  report_json TEXT NOT NULL
);
CREATE TRIGGER p39_report_no_update BEFORE UPDATE ON p39_migration_block_reports
BEGIN SELECT RAISE(ABORT, 'P39 audit report is immutable'); END;
CREATE TRIGGER p39_report_no_delete BEFORE DELETE ON p39_migration_block_reports
BEGIN SELECT RAISE(ABORT, 'P39 audit report is retained'); END;
`;

export interface P39PreflightSnapshot {
  readonly userVersion: 36 | 37 | 38;
  readonly databaseFingerprint: string;
  readonly activeNotAdmittedInvocationIds: ReadonlyArray<string>;
}

export interface P39MigrationBlockReport {
  readonly reportKey: string;
  readonly contentHash: string;
  readonly reportJson: string;
  readonly observedUserVersion: number;
  readonly targetUserVersion: 39;
  readonly databaseFingerprint: string;
  readonly invocationIds: ReadonlyArray<string>;
  readonly blockerStateFingerprint: string;
}

/** Opaque proof that the maintenance adapter holds a process-independent
 * writer-quiescence primitive for this token's lifetime. It must cover every
 * primary-database writer across the ordered migration chain; an expiring
 * process-local lease or the short SQLite snapshot reservation is insufficient. */
export interface P39WriterExclusionLease {
  readonly token: string;
}

export interface P39PrimarySnapshotReservation {
  readonly reservation: string;
  readonly snapshot: P39PreflightSnapshot;
}

export interface P39MaintenancePort {
  /** Stops/quiesces all primary writers, including other OS processes. */
  readonly acquireWriterExclusion: () => Effect.Effect<
    P39WriterExclusionLease,
    P39MaintenanceFailure
  >;
  /** Releases writer exclusion only after the ordered chain succeeds/fails. */
  readonly releaseWriterExclusion: (
    lease: P39WriterExclusionLease,
  ) => Effect.Effect<void, P39MaintenanceFailure>;
  /** Takes the short, read-only P1 snapshot while writer exclusion is held. */
  readonly reservePrimarySnapshot: (
    lease: P39WriterExclusionLease,
  ) => Effect.Effect<P39PrimarySnapshotReservation, P39MaintenanceFailure>;
  readonly releasePrimarySnapshot: (
    lease: P39WriterExclusionLease,
    reservation: P39PrimarySnapshotReservation,
  ) => Effect.Effect<void, P39MaintenanceFailure>;
  /** Writes using the separate, operator-selected sidecar and reads back the
   * exact immutable report key/hash before returning, while both the primary
   * snapshot reservation and writer-exclusion lease remain held. */
  readonly writeAndReadBackSidecarReport: (
    lease: P39WriterExclusionLease,
    reservation: P39PrimarySnapshotReservation,
    report: P39MigrationBlockReport,
  ) => Effect.Effect<
    { readonly reportKey: string; readonly contentHash: string },
    P39MaintenanceFailure
  >;
  /** Must run while the same writer-exclusion lease is still held. */
  readonly applyOrderedMigrations: (
    lease: P39WriterExclusionLease,
  ) => Effect.Effect<void, SqlError | SqliteAdapterError | P39MaintenanceFailure>;
}

export interface P39MaintenanceFailure {
  readonly _tag: "P39MaintenanceFailure";
  readonly code:
    | "P39_REPORT_COMMIT_UNRESOLVED"
    | "P39_REPORT_KEY_CONFLICT"
    | "P39_REPORT_DB_REQUIRED"
    | "P39_REPORT_DB_PATH_INVALID"
    | "P39_REPORT_DB_SCHEMA_UNSUPPORTED"
    | "P39_REPORT_DB_PRAGMA_MISMATCH"
    | "P39_REPORT_DB_IO_FAILURE"
    | "P39_PRIMARY_JOURNAL_MODE_UNSUPPORTED"
    | "P39_REPORT_DURABILITY_UNSUPPORTED"
    | "P39_LEGACY_DB_ISOLATED";
  readonly cause?: unknown;
}

const canonicalJson = (value: unknown): string => JSON.stringify(value);

const makeReport = (
  snapshot: P39PreflightSnapshot,
): P39MigrationBlockReport => {
  const invocationIds = [...snapshot.activeNotAdmittedInvocationIds].sort();
  const blockerStateFingerprint = sha256Hex(invocationIds.join("\n"));
  const keyJson = canonicalJson({
    schema: "p39-migration-block-report/v1",
    targetUserVersion: 39,
    databaseFingerprint: snapshot.databaseFingerprint,
  });
  const reportKey = sha256Hex(keyJson);
  const body = {
    schema: "p39-migration-block-report/v1",
    kind: "LegacyActiveNotAdmitted",
    observedUserVersion: snapshot.userVersion,
    targetUserVersion: 39,
    blockerStateFingerprint,
    invocationIds,
  };
  const reportJson = canonicalJson(body);
  return {
    reportKey,
    contentHash: sha256Hex(reportJson),
    reportJson,
    observedUserVersion: snapshot.userVersion,
    targetUserVersion: 39,
    databaseFingerprint: snapshot.databaseFingerprint,
    invocationIds,
    blockerStateFingerprint,
  };
};

interface SidecarReportRow {
  readonly report_key: string;
  readonly content_hash: string;
  readonly report_json: string;
}

/** Writes through the SqlClient supplied by the operator-selected sidecar
 * connection. The caller must validate its path, application_id, user_version,
 * exact schema and durability settings before providing this connection. */
export const writeP39BlockReportAndReadBack = (
  report: P39MigrationBlockReport,
): Effect.Effect<
  { readonly reportKey: string; readonly contentHash: string },
  P39MaintenanceFailure,
  SqlClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const expectedReportKey = sha256Hex(
      canonicalJson({
        schema: "p39-migration-block-report/v1",
        targetUserVersion: 39,
        databaseFingerprint: report.databaseFingerprint,
      }),
    );
    if (
      report.reportKey !== expectedReportKey ||
      report.contentHash !== sha256Hex(report.reportJson)
    ) {
      return yield* Effect.fail({
        _tag: "P39MaintenanceFailure",
        code: "P39_REPORT_KEY_CONFLICT",
      });
    }
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* sql.unsafe<SidecarReportRow>(
            `SELECT report_key, content_hash, report_json
               FROM p39_migration_block_reports WHERE report_key = ?`,
            [report.reportKey],
          );
          const row = existing[0];
          if (row !== undefined) {
            if (
              row.content_hash !== report.contentHash ||
              row.report_json !== report.reportJson
            ) {
              return yield* Effect.fail({
                _tag: "P39MaintenanceFailure",
                code: "P39_REPORT_KEY_CONFLICT",
              });
            }
            return {
              reportKey: row.report_key,
              contentHash: row.content_hash,
            };
          }
          yield* sql.unsafe(
            `INSERT INTO p39_migration_block_reports
              (report_key, content_hash, report_json) VALUES (?,?,?)`,
            [report.reportKey, report.contentHash, report.reportJson],
          );
          const confirmed = yield* sql.unsafe<SidecarReportRow>(
            `SELECT report_key, content_hash, report_json
               FROM p39_migration_block_reports WHERE report_key = ?`,
            [report.reportKey],
          );
          const saved = confirmed[0];
          if (
            saved === undefined ||
            saved.content_hash !== report.contentHash ||
            saved.report_json !== report.reportJson
          ) {
            return yield* Effect.fail({
              _tag: "P39MaintenanceFailure",
              code: "P39_REPORT_COMMIT_UNRESOLVED",
            });
          }
          return {
            reportKey: saved.report_key,
            contentHash: saved.content_hash,
          };
        }),
      )
      .pipe(
        Effect.mapError((cause: SqlError | P39MaintenanceFailure) => {
          if (
            typeof cause === "object" &&
            cause !== null &&
            "_tag" in cause &&
            cause._tag === "P39MaintenanceFailure"
          ) {
            return cause as P39MaintenanceFailure;
          }
          return {
            _tag: "P39MaintenanceFailure" as const,
            code: "P39_REPORT_COMMIT_UNRESOLVED" as const,
            cause,
          };
        }),
      );
  });

/** Side-effect ordering for the P39 maintenance gate. The cross-process writer
 * exclusion lease covers the preflight and complete 0037→0038→0039 chain. The
 * shorter primary snapshot reservation is released before migration, but the
 * lease remains held until migration succeeds or fails. A blocker is reported
 * and read back while both lease and primary reservation are held, then the
 * snapshot is released and a typed isolation failure returned. No Runtime
 * startup path calls this helper. */
export const runP39MaintenanceGate = (
  port: P39MaintenancePort,
): Effect.Effect<
  void,
  P39MaintenanceFailure | SqlError | SqliteAdapterError
> =>
  Effect.acquireUseRelease(
    port.acquireWriterExclusion(),
    (lease) =>
      Effect.gen(function* () {
        const preflight = yield* Effect.acquireUseRelease(
          port.reservePrimarySnapshot(lease),
          (reservation) =>
            Effect.gen(function* () {
              const snapshot = reservation.snapshot;
              if (snapshot.activeNotAdmittedInvocationIds.length === 0) {
                return { blocked: false as const };
              }
              const report = makeReport(snapshot);
              const saved = yield* port.writeAndReadBackSidecarReport(
                lease,
                reservation,
                report,
              );
              if (
                saved.reportKey !== report.reportKey ||
                saved.contentHash !== report.contentHash
              ) {
                return yield* Effect.fail({
                  _tag: "P39MaintenanceFailure" as const,
                  code: "P39_REPORT_COMMIT_UNRESOLVED" as const,
                });
              }
              return { blocked: true as const };
            }),
          (reservation) =>
            port.releasePrimarySnapshot(lease, reservation).pipe(Effect.orDie),
        );

        if (preflight.blocked) {
          return yield* Effect.fail({
            _tag: "P39MaintenanceFailure",
            code: "P39_LEGACY_DB_ISOLATED",
          });
        }
        yield* port.applyOrderedMigrations(lease);
      }),
    (lease) => port.releaseWriterExclusion(lease).pipe(Effect.orDie),
  );
