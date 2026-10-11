import { sha256Hex } from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

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

export interface P39MaintenancePort {
  /** Holds the primary BEGIN IMMEDIATE reservation until releasePrimary. */
  readonly reservePrimary: () => Effect.Effect<P39PreflightSnapshot, P39MaintenanceFailure>;
  /** Writes using the separate, operator-selected sidecar and reads back the
   * exact immutable report key/hash before returning. */
  readonly writeAndReadBackSidecarReport: (
    report: P39MigrationBlockReport,
  ) => Effect.Effect<
    { readonly reportKey: string; readonly contentHash: string },
    P39MaintenanceFailure
  >;
  readonly releasePrimary: () => Effect.Effect<void, P39MaintenanceFailure>;
  /** Must be the ordered P36→P37→P38→P39 maintenance migration chain. */
  readonly applyOrderedMigrations: () => Effect.Effect<void, P39MaintenanceFailure>;
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

/** Side-effect ordering for the P39 maintenance gate. A blocker must be
 * durably reported and read back while the primary reservation is held; only
 * then is the reservation released and the typed isolation failure returned.
 * No Runtime startup path calls this helper. */
export const runP39MaintenanceGate = (
  port: P39MaintenancePort,
): Effect.Effect<void, P39MaintenanceFailure> =>
  Effect.gen(function* () {
    const snapshot = yield* port.reservePrimary();
    if (snapshot.activeNotAdmittedInvocationIds.length > 0) {
      const report = makeReport(snapshot);
      const saved = yield* port
        .writeAndReadBackSidecarReport(report)
        .pipe(Effect.ensuring(port.releasePrimary().pipe(Effect.orDie)));
      if (
        saved.reportKey !== report.reportKey ||
        saved.contentHash !== report.contentHash
      ) {
        return yield* Effect.fail({
          _tag: "P39MaintenanceFailure",
          code: "P39_REPORT_COMMIT_UNRESOLVED",
        });
      }
      return yield* Effect.fail({
        _tag: "P39MaintenanceFailure",
        code: "P39_LEGACY_DB_ISOLATED",
      });
    }

    yield* port.releasePrimary();
    yield* port.applyOrderedMigrations();
  });
