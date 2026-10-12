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
  readonly userVersion: 36 | 37 | 38 | 39;
  readonly databaseFingerprint: string;
  readonly activeNotAdmittedInvocations: ReadonlyArray<{
    readonly invocationId: string;
    readonly executionId: string;
    readonly sideEffectSemantics: string;
    readonly effectAdmissionState: "NotAdmitted";
    readonly unsettled: true;
    readonly approvalId: string | null;
  }>;
}

export interface P39MigrationBlockReport {
  readonly reportKey: string;
  readonly contentHash: string;
  readonly reportJson: string;
  readonly observedUserVersion: number;
  readonly targetUserVersion: 39;
  readonly databaseFingerprint: string;
  readonly blockedInvocationIds: ReadonlyArray<string>;
  readonly blockerStateFingerprint: string;
}

export interface P39StoredMigrationBlockReport {
  readonly reportKey: string;
  readonly contentHash: string;
  readonly reportJson: string;
}

/** Opaque proof that the adapter owns the dedicated lock database's exclusive
 * VFS lock. This waits for live daemon shared permits and blocks new permits. */
export interface P39WriterExclusionLease {
  readonly token: string;
}

export interface P39PrimarySnapshotReservation {
  readonly reservation: string;
  readonly snapshot: P39PreflightSnapshot;
}

export interface P39MaintenancePort {
  /** Waits for live daemon writer permits and blocks new permits across OS
   * processes. The primary BEGIN IMMEDIATE reservation fences direct writers. */
  readonly acquireWriterExclusion: () => Effect.Effect<
    P39WriterExclusionLease,
    P39MaintenanceFailure
  >;
  /** Releases writer exclusion only after the ordered chain succeeds/fails. */
  readonly releaseWriterExclusion: (
    lease: P39WriterExclusionLease,
  ) => Effect.Effect<void, P39MaintenanceFailure>;
  /** Takes the read-only blocker snapshot inside the held SQLite writer lock. */
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
  /** Executes the exact migration suffix inside the reservation transaction
   * and commits it. Any failure leaves rollback to releasePrimarySnapshot. */
  readonly applyOrderedMigrations: (
    lease: P39WriterExclusionLease,
    reservation: P39PrimarySnapshotReservation,
  ) => Effect.Effect<
    void,
    SqlError | SqliteAdapterError | P39MaintenanceFailure
  >;
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
    | "P39_MIGRATION_PREFIX_INVALID"
    | "P39_RUNTIME_START_REFUSED"
    | "P39_WRITER_LOCK_PATH_INVALID"
    | "P39_UNSUPPORTED_DEPLOYMENT"
    | "P39_WRITER_LOCK_SCHEMA_INVALID"
    | "P39_WRITER_LOCK_ACQUIRE_FAILED"
    | "P39_WRITER_LOCK_RELEASE_FAILED"
    | "P39_LEGACY_DB_ISOLATED";
  readonly cause?: unknown;
}

/** Public deployment failures carry only a bounded diagnostic code. Raw paths,
 * ACL text and OS exception messages are intentionally not exposed. */
export const p39UnsupportedDeployment = (
  reasonCode: string,
): P39MaintenanceFailure => ({
  _tag: "P39MaintenanceFailure",
  code: "P39_UNSUPPORTED_DEPLOYMENT",
  cause: {
    _tag: "P39UnsupportedDeploymentDiagnostic",
    reasonCode,
  },
});

const canonicalJson = (value: unknown): string => JSON.stringify(value);

const makeReport = (
  snapshot: P39PreflightSnapshot,
): P39MigrationBlockReport => {
  const blockers = [...snapshot.activeNotAdmittedInvocations].sort((a, b) =>
    a.invocationId < b.invocationId
      ? -1
      : a.invocationId > b.invocationId
        ? 1
        : 0,
  );
  const blockedInvocationIds = blockers.map(({ invocationId }) => invocationId);
  const blockerStateFingerprint = sha256Hex(
    canonicalJson({
      observedUserVersion: snapshot.userVersion,
      invocations: blockers,
    }),
  );
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
    databaseFingerprint: snapshot.databaseFingerprint,
    blockerStateFingerprint,
    blockedInvocationIds,
  };
  const reportJson = canonicalJson(body);
  return {
    reportKey,
    contentHash: sha256Hex(reportJson),
    reportJson,
    observedUserVersion: snapshot.userVersion,
    targetUserVersion: 39,
    databaseFingerprint: snapshot.databaseFingerprint,
    blockedInvocationIds,
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
    const expectedReportJson = canonicalJson({
      schema: "p39-migration-block-report/v1",
      kind: "LegacyActiveNotAdmitted",
      observedUserVersion: report.observedUserVersion,
      targetUserVersion: 39,
      databaseFingerprint: report.databaseFingerprint,
      blockerStateFingerprint: report.blockerStateFingerprint,
      blockedInvocationIds: report.blockedInvocationIds,
    });
    if (
      report.reportKey !== expectedReportKey ||
      report.contentHash !== sha256Hex(report.reportJson) ||
      report.reportJson !== expectedReportJson ||
      (report.observedUserVersion !== 36 &&
        report.observedUserVersion !== 37 &&
        report.observedUserVersion !== 38) ||
      !/^[0-9a-f]{64}$/u.test(report.databaseFingerprint) ||
      !/^[0-9a-f]{64}$/u.test(report.blockerStateFingerprint) ||
      report.blockedInvocationIds.length === 0 ||
      report.blockedInvocationIds.some((id, index) => {
        const previous =
          index > 0 ? report.blockedInvocationIds[index - 1] : undefined;
        return (
          id.trim().length === 0 || (previous !== undefined && previous >= id)
        );
      })
    ) {
      return yield* Effect.fail<P39MaintenanceFailure>({
        _tag: "P39MaintenanceFailure",
        code: "P39_REPORT_KEY_CONFLICT",
      });
    }
    const writeAttempt = sql
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
              return yield* Effect.fail<P39MaintenanceFailure>({
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
            return yield* Effect.fail<P39MaintenanceFailure>({
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
    const committed = yield* Effect.result(writeAttempt);
    if (committed._tag === "Success") return committed.success;
    return yield* Effect.fail({
      _tag: "P39MaintenanceFailure" as const,
      code: "P39_REPORT_COMMIT_UNRESOLVED" as const,
      cause: committed.failure,
    });
  });

/** Operator-facing read path for immutable blocker reports. It deliberately
 * returns the stored JSON only after verifying both its key and content hash,
 * so the report remains useful after the primary snapshot has been rolled
 * back and the migration command has exited. */
export const readP39BlockReports = (): Effect.Effect<
  ReadonlyArray<P39StoredMigrationBlockReport>,
  P39MaintenanceFailure,
  SqlClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql
      .unsafe<SidecarReportRow>(
        `SELECT report_key, content_hash, report_json
         FROM p39_migration_block_reports ORDER BY report_key`,
      )
      .pipe(
        Effect.mapError(
          (cause): P39MaintenanceFailure => ({
            _tag: "P39MaintenanceFailure" as const,
            code: "P39_REPORT_DB_IO_FAILURE" as const,
            cause,
          }),
        ),
      );
    const reports: P39StoredMigrationBlockReport[] = [];
    for (const row of rows) {
      let body: unknown;
      try {
        body = JSON.parse(row.report_json);
      } catch (cause) {
        return yield* Effect.fail<P39MaintenanceFailure>({
          _tag: "P39MaintenanceFailure",
          code: "P39_REPORT_KEY_CONFLICT",
          cause,
        });
      }
      if (
        row.content_hash !== sha256Hex(row.report_json) ||
        typeof body !== "object" ||
        body === null ||
        canonicalJson(body) !== row.report_json ||
        !("schema" in body) ||
        body.schema !== "p39-migration-block-report/v1" ||
        !("targetUserVersion" in body) ||
        body.targetUserVersion !== 39 ||
        !("kind" in body) ||
        body.kind !== "LegacyActiveNotAdmitted" ||
        !("observedUserVersion" in body) ||
        (body.observedUserVersion !== 36 &&
          body.observedUserVersion !== 37 &&
          body.observedUserVersion !== 38) ||
        !("databaseFingerprint" in body) ||
        typeof body.databaseFingerprint !== "string" ||
        !/^[0-9a-f]{64}$/u.test(body.databaseFingerprint) ||
        !("blockerStateFingerprint" in body) ||
        typeof body.blockerStateFingerprint !== "string" ||
        !/^[0-9a-f]{64}$/u.test(body.blockerStateFingerprint) ||
        !Array.isArray(
          (body as { blockedInvocationIds?: unknown }).blockedInvocationIds,
        )
      ) {
        return yield* Effect.fail<P39MaintenanceFailure>({
          _tag: "P39MaintenanceFailure",
          code: "P39_REPORT_KEY_CONFLICT",
        });
      }
      const blockedIds = (
        body as unknown as { blockedInvocationIds: unknown[] }
      ).blockedInvocationIds;
      const blockedIdStrings = blockedIds.filter(
        (id): id is string => typeof id === "string",
      );
      if (
        blockedIds.length === 0 ||
        blockedIdStrings.length !== blockedIds.length ||
        blockedIdStrings.some((id) => id.trim().length === 0) ||
        blockedIdStrings.some((id, index) => {
          const previous = index > 0 ? blockedIdStrings[index - 1] : undefined;
          return previous !== undefined && previous >= id;
        })
      ) {
        return yield* Effect.fail<P39MaintenanceFailure>({
          _tag: "P39MaintenanceFailure",
          code: "P39_REPORT_KEY_CONFLICT",
        });
      }
      const expectedReportKey = sha256Hex(
        canonicalJson({
          schema: "p39-migration-block-report/v1",
          targetUserVersion: 39,
          databaseFingerprint: body.databaseFingerprint,
        }),
      );
      if (row.report_key !== expectedReportKey) {
        return yield* Effect.fail<P39MaintenanceFailure>({
          _tag: "P39MaintenanceFailure",
          code: "P39_REPORT_KEY_CONFLICT",
        });
      }
      reports.push({
        reportKey: row.report_key,
        contentHash: row.content_hash,
        reportJson: row.report_json,
      });
    }
    return reports;
  });

/** Returns the exact suffix permitted by the P36→P37→P38→P39 prefix. This is
 * intentionally strict: a direct [0039] call or a missing predecessor fails
 * before any migration SQL is executed. */
export const validateP39MigrationPrefix = (
  currentVersion: number,
  orderedMigrations: ReadonlyArray<{ readonly id: number }>,
): Effect.Effect<
  ReadonlyArray<{ readonly id: number }>,
  P39MaintenanceFailure
> => {
  const expected =
    currentVersion >= 36 && currentVersion <= 38
      ? Array.from(
          { length: 39 - currentVersion },
          (_, index) => currentVersion + index + 1,
        )
      : [];
  const actual = orderedMigrations.map(({ id }) => id);
  if (
    expected.length === 0 ||
    actual.length !== expected.length ||
    actual.some((id, index) => id !== expected[index])
  ) {
    return Effect.fail({
      _tag: "P39MaintenanceFailure",
      code: "P39_MIGRATION_PREFIX_INVALID",
    });
  }
  return Effect.succeed(orderedMigrations);
};

/** Runtime entry points call this before creating any Agent/P4 service layer.
 * A P39-only database is maintenance-only until P40 has committed. */
export const requireP39RuntimeSchema = (
  userVersion: number,
): Effect.Effect<void, P39MaintenanceFailure> =>
  userVersion >= 39
    ? Effect.fail({
        _tag: "P39MaintenanceFailure",
        code: "P39_RUNTIME_START_REFUSED",
      })
    : Effect.void;

/** The process-independent SQLite writer lock and reserved primary snapshot
 * enclose the entire 0036→0039 migration chain. A 39 database is outside this
 * one-way maintenance entrypoint and is refused before any sidecar report or
 * migration attempt. A blocker is reported/read back while both primary lock
 * and snapshot remain open, then the unchanged primary is rolled back. */
export const runP39MaintenanceGate = (
  port: P39MaintenancePort,
): Effect.Effect<void, P39MaintenanceFailure | SqlError | SqliteAdapterError> =>
  Effect.acquireUseRelease(
    port.acquireWriterExclusion(),
    (lease) =>
      Effect.gen(function* () {
        const preflight = yield* Effect.acquireUseRelease(
          port.reservePrimarySnapshot(lease),
          (reservation) =>
            Effect.gen(function* () {
              const snapshot = reservation.snapshot;
              if (snapshot.userVersion === 39) {
                return yield* Effect.fail<P39MaintenanceFailure>({
                  _tag: "P39MaintenanceFailure",
                  code: "P39_MIGRATION_PREFIX_INVALID",
                });
              }
              if (snapshot.activeNotAdmittedInvocations.length === 0) {
                yield* port.applyOrderedMigrations(lease, reservation);
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
                return yield* Effect.fail<P39MaintenanceFailure>({
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
          return yield* Effect.fail<P39MaintenanceFailure>({
            _tag: "P39MaintenanceFailure",
            code: "P39_LEGACY_DB_ISOLATED",
          });
        }
      }),
    (lease) => port.releaseWriterExclusion(lease).pipe(Effect.orDie),
  );
