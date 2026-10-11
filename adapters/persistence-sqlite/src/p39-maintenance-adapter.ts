import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { sha256Hex } from "@arbor/ports";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { SqliteAdapterError } from "./errors.js";
import { splitStatements } from "./migrate.js";
import {
  P39_MAINTENANCE_MIGRATION_MANIFEST,
  P39_MAINTENANCE_MIGRATIONS,
} from "./migrations.js";
import {
  type P39MaintenanceFailure,
  type P39MaintenancePort,
  type P39MigrationBlockReport,
  type P39PreflightSnapshot,
  type P39WriterExclusionLease,
  readP39BlockReports,
  runP39MaintenanceGate,
  validateP39MigrationPrefix,
  writeP39BlockReportAndReadBack,
} from "./p39-maintenance.js";
import {
  validateP39ReportSidecarDatabase,
  validateP39ReportSidecarPath,
} from "./p39-report-database.js";
import type {
  P39DatabaseWriterPermit,
  P39WriterLockClientService,
  P39WriterLockFailure,
} from "./p39-writer-lock.js";
import {
  P39WriterLockClient,
  p39WriterLockFilename,
  p39WriterLockLayer,
} from "./p39-writer-lock.js";

/** The subset of Effect SQL used by the maintenance adapter. Concrete
 * SqlClient services from the primary and operator-selected sidecar databases
 * satisfy this interface. */
export interface P39MaintenanceSqlClient {
  readonly unsafe: <A = unknown>(
    statement: string,
    params?: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<A>, SqlError>;
  readonly withTransaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError, R>;
}

interface P39SqliteMaintenanceAdapterOptions {
  readonly primary: P39MaintenanceSqlClient;
  readonly writerLock: P39WriterLockClientService;
  readonly primaryFilename: string;
  readonly writerLockFilename: string;
  readonly writeAndReadBackSidecarReport: (
    report: P39MigrationBlockReport,
  ) => Effect.Effect<
    { readonly reportKey: string; readonly contentHash: string },
    P39MaintenanceFailure | SqlError
  >;
}

class P39PrimarySqlClient extends Context.Service<
  P39PrimarySqlClient,
  P39MaintenanceSqlClient
>()("arbor/P39PrimarySqlClient") {}

export interface P39SqliteMaintenanceCommandOptions {
  readonly primaryFilename: string;
  readonly sidecarFilename: string;
  /** Other canonical databases owned by the application, used to reject an
   * audit path that aliases a different store. */
  readonly protectedStoreFilenames: ReadonlyArray<string>;
  readonly writerLockBusyTimeoutMs?: number;
}

/** Operator maintenance entry point. It validates/initializes the selected
 * audit sidecar before opening the primary, then holds the cross-process
 * maintenance lock and one primary BEGIN IMMEDIATE reservation across the
 * complete 0037→0038→0039 suffix. It exits in maintenance-only mode at version
 * 39 and never constructs Agent/P4 Runtime services. */
export const runP39SqliteMaintenance = (
  options: P39SqliteMaintenanceCommandOptions,
): Effect.Effect<void, P39MaintenanceFailure | SqliteAdapterError | SqlError> =>
  Effect.gen(function* () {
    if (options.primaryFilename === ":memory:") {
      return yield* Effect.fail({
        _tag: "P39MaintenanceFailure" as const,
        code: "P39_UNSUPPORTED_DEPLOYMENT" as const,
      });
    }
    const resolvedPrimaryPath = resolve(options.primaryFilename);
    if (!existsSync(resolvedPrimaryPath)) {
      return yield* Effect.fail({
        _tag: "P39MaintenanceFailure" as const,
        code: "P39_MIGRATION_PREFIX_INVALID" as const,
      });
    }
    const primaryPath = realpathSync.native(resolvedPrimaryPath);
    const lockPath = p39WriterLockFilename(primaryPath);
    if (typeof lockPath !== "string") {
      return yield* Effect.fail(
        failure(
          lockPath.code === "P39_WRITER_LOCK_UNSUPPORTED_DEPLOYMENT"
            ? "P39_UNSUPPORTED_DEPLOYMENT"
            : "P39_WRITER_LOCK_PATH_INVALID",
          lockPath,
        ),
      );
    }
    const sidecarPath = yield* validateP39ReportSidecarPath(
      resolvedPrimaryPath,
      options.sidecarFilename,
      options.protectedStoreFilenames,
    );
    yield* validateP39ReportSidecarDatabase(
      primaryPath,
      sidecarPath,
      options.protectedStoreFilenames,
    );
    const primaryService = Layer.provide(
      Layer.effect(
        P39PrimarySqlClient,
        Effect.map(
          SqlClient,
          (service) => service as unknown as P39MaintenanceSqlClient,
        ),
      ),
      SqliteClient.layer({ filename: primaryPath, disableWAL: true }),
    );
    const maintenance = Effect.gen(function* () {
      const primary = yield* P39PrimarySqlClient;
      const writerLock = yield* P39WriterLockClient;
      const reportSidecarLayer = Layer.provideMerge(
        Layer.effectDiscard(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            yield* sql.unsafe("PRAGMA foreign_keys = ON");
            yield* sql.unsafe("PRAGMA busy_timeout = 5000");
            yield* sql.unsafe("PRAGMA synchronous = FULL");
          }),
        ),
        SqliteClient.layer({ filename: sidecarPath, disableWAL: true }),
      );
      const writeReport = (report: P39MigrationBlockReport) =>
        Effect.scoped(
          Effect.provide(
            writeP39BlockReportAndReadBack(report),
            reportSidecarLayer,
          ),
        ).pipe(
          Effect.mapError((cause) =>
            typeof cause === "object" &&
            cause !== null &&
            "_tag" in cause &&
            cause._tag === "P39MaintenanceFailure"
              ? (cause as P39MaintenanceFailure)
              : failure("P39_REPORT_COMMIT_UNRESOLVED", cause),
          ),
        );
      const readReports = () =>
        Effect.scoped(
          Effect.provide(readP39BlockReports(), reportSidecarLayer),
        );
      const port = makeP39SqliteMaintenancePort({
        primary,
        writerLock,
        primaryFilename: primaryPath,
        writerLockFilename: lockPath,
        writeAndReadBackSidecarReport: (report) =>
          Effect.gen(function* () {
            const attempted = yield* Effect.result(writeReport(report));
            if (attempted._tag === "Success") return attempted.success;
            if (attempted.failure.code !== "P39_REPORT_COMMIT_UNRESOLVED") {
              return yield* Effect.fail(attempted.failure);
            }

            // The write connection's scope is closed before this fresh
            // connection resolves an uncertain COMMIT acknowledgement.
            yield* validateP39ReportSidecarDatabase(
              primaryPath,
              sidecarPath,
              options.protectedStoreFilenames,
            );
            const reports = yield* readReports().pipe(
              Effect.mapError((cause) =>
                failure("P39_REPORT_COMMIT_UNRESOLVED", cause),
              ),
            );
            const winner = reports.find(
              ({ reportKey }) => reportKey === report.reportKey,
            );
            if (
              winner !== undefined &&
              winner.contentHash === report.contentHash &&
              winner.reportJson === report.reportJson
            ) {
              return {
                reportKey: winner.reportKey,
                contentHash: winner.contentHash,
              };
            }
            if (
              reports.some(
                ({ reportKey, contentHash }) =>
                  reportKey === report.reportKey ||
                  contentHash === report.contentHash,
              )
            ) {
              return yield* Effect.fail(failure("P39_REPORT_KEY_CONFLICT"));
            }
            return yield* Effect.fail(
              failure("P39_REPORT_COMMIT_UNRESOLVED", attempted.failure),
            );
          }).pipe(
            Effect.mapError((cause) =>
              typeof cause === "object" &&
              cause !== null &&
              "_tag" in cause &&
              cause._tag === "P39MaintenanceFailure"
                ? (cause as P39MaintenanceFailure)
                : failure("P39_REPORT_COMMIT_UNRESOLVED", cause),
            ),
          ),
      });
      yield* runP39MaintenanceGate(port);
    });
    yield* Effect.scoped(
      Effect.provide(
        maintenance,
        Layer.mergeAll(
          primaryService,
          p39WriterLockLayer(
            lockPath,
            options.writerLockBusyTimeoutMs ?? 30_000,
          ),
        ),
      ),
    ).pipe(
      Effect.mapError((cause) => {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "_tag" in cause &&
          cause._tag === "P39WriterLockFailure"
        ) {
          const lockFailure = cause as P39WriterLockFailure;
          const { code, ...detail } = lockFailure;
          return failure(
            code === "P39_WRITER_LOCK_UNSUPPORTED_DEPLOYMENT"
              ? "P39_UNSUPPORTED_DEPLOYMENT"
              : code,
            detail,
          );
        }
        return cause;
      }),
    );
  });

interface LegacyBlockedInvocationRow {
  readonly invocation_id: string;
  readonly execution_id: string;
  readonly side_effect_semantics: string;
  readonly effect_admission_state: "NotAdmitted";
  readonly settled_at: null;
  readonly approval_id: string | null;
}

interface UserVersionRow {
  readonly user_version: number;
}

interface SnapshotState {
  readonly reservation: string;
  committed: boolean;
  released: boolean;
}

const failure = (
  code: P39MaintenanceFailure["code"],
  cause?: unknown,
): P39MaintenanceFailure => ({
  _tag: "P39MaintenanceFailure",
  code,
  ...(cause === undefined ? {} : { cause }),
});

const toBlocker = (row: LegacyBlockedInvocationRow) => ({
  invocationId: row.invocation_id,
  executionId: row.execution_id,
  sideEffectSemantics: row.side_effect_semantics,
  effectAdmissionState: row.effect_admission_state,
  unsettled: true as const,
  approvalId: row.approval_id,
});

/** Concrete SQLite maintenance adapter. The P1 preflight holds BEGIN IMMEDIATE
 * on the primary connection; this VFS reservation blocks all competing
 * primary writers across processes and remains open through the exact ordered
 * suffix. A blocker report commits/readbacks on the already validated sidecar
 * before the primary transaction is rolled back. */
const makeP39SqliteMaintenancePort = (
  options: P39SqliteMaintenanceAdapterOptions,
): P39MaintenancePort => {
  let snapshotState: SnapshotState | undefined;
  let writerLockPermit: P39DatabaseWriterPermit | undefined;
  const sql = options.primary;
  return {
    acquireWriterExclusion: () =>
      options.writerLock.acquire("MaintenanceExclusive").pipe(
        Effect.mapError((cause) =>
          failure("P39_WRITER_LOCK_ACQUIRE_FAILED", cause),
        ),
        Effect.map((permit) => {
          writerLockPermit = permit;
          return { token: permit.token };
        }),
      ),
    releaseWriterExclusion: (lease: P39WriterExclusionLease) => {
      const permit = writerLockPermit;
      if (permit === undefined || permit.token !== lease.token) {
        return Effect.fail(failure("P39_WRITER_LOCK_RELEASE_FAILED"));
      }
      writerLockPermit = undefined;
      return options.writerLock
        .release(permit)
        .pipe(
          Effect.mapError((cause) =>
            failure("P39_WRITER_LOCK_RELEASE_FAILED", cause),
          ),
        );
    },
    reservePrimarySnapshot: (lease) =>
      Effect.gen(function* () {
        if (lease.token !== writerLockPermit?.token) {
          return yield* Effect.fail(failure("P39_WRITER_LOCK_ACQUIRE_FAILED"));
        }
        const currentLockPath = p39WriterLockFilename(options.primaryFilename);
        if (
          typeof currentLockPath !== "string" ||
          currentLockPath !== options.writerLockFilename
        ) {
          return yield* Effect.fail(
            failure("P39_UNSUPPORTED_DEPLOYMENT", currentLockPath),
          );
        }
        const acquireSnapshot = Effect.gen(function* () {
          const journal = yield* sql.unsafe<{ journal_mode: string }>(
            "PRAGMA journal_mode",
          );
          if (journal[0]?.journal_mode?.toLowerCase() !== "wal") {
            return yield* Effect.fail(
              failure("P39_PRIMARY_JOURNAL_MODE_UNSUPPORTED"),
            );
          }
          yield* sql.unsafe("PRAGMA foreign_keys = OFF");
          yield* sql.unsafe("PRAGMA legacy_alter_table = ON");
          yield* sql.unsafe("BEGIN IMMEDIATE");
          const versions = yield* sql.unsafe<UserVersionRow>(
            "PRAGMA user_version",
          );
          const userVersion = Number(versions[0]?.user_version);
          if (
            userVersion !== 36 &&
            userVersion !== 37 &&
            userVersion !== 38 &&
            userVersion !== 39
          ) {
            return yield* Effect.fail(failure("P39_MIGRATION_PREFIX_INVALID"));
          }
          const blockedRows =
            userVersion === 39
              ? []
              : yield* sql.unsafe<LegacyBlockedInvocationRow>(
                  `SELECT invocation_id, execution_id, side_effect_semantics,
                    effect_admission_state, settled_at, approval_id
               FROM tool_invocations
              WHERE settled_at IS NULL AND effect_admission_state = 'NotAdmitted'
              ORDER BY invocation_id`,
                );
          const snapshot: P39PreflightSnapshot = {
            userVersion,
            databaseFingerprint: sha256Hex(resolve(options.primaryFilename)),
            activeNotAdmittedInvocations: blockedRows.map(toBlocker),
          };
          const reservation = `p39-primary-${userVersion}-${snapshot.databaseFingerprint}`;
          snapshotState = { reservation, committed: false, released: false };
          return { reservation, snapshot };
        });
        const acquired = yield* Effect.exit(acquireSnapshot);
        if (acquired._tag === "Failure") {
          yield* sql.unsafe("ROLLBACK").pipe(Effect.ignore);
          yield* sql
            .unsafe("PRAGMA legacy_alter_table = OFF")
            .pipe(Effect.ignore);
          yield* sql.unsafe("PRAGMA foreign_keys = ON").pipe(Effect.ignore);
          return yield* Effect.failCause(acquired.cause);
        }
        return acquired.value;
      }).pipe(
        Effect.mapError((cause: SqlError | P39MaintenanceFailure) =>
          typeof cause === "object" &&
          cause !== null &&
          "_tag" in cause &&
          cause._tag === "P39MaintenanceFailure"
            ? (cause as P39MaintenanceFailure)
            : failure("P39_REPORT_DB_IO_FAILURE", cause),
        ),
      ),
    releasePrimarySnapshot: (_lease, reservation) => {
      const state = snapshotState;
      if (
        state === undefined ||
        state.reservation !== reservation.reservation
      ) {
        return Effect.fail(failure("P39_REPORT_DB_IO_FAILURE"));
      }
      if (state.released) return Effect.void;
      state.released = true;
      const rollback = state.committed
        ? Effect.void
        : sql.unsafe("ROLLBACK").pipe(Effect.asVoid);
      return rollback.pipe(
        Effect.flatMap(() => sql.unsafe("PRAGMA legacy_alter_table = OFF")),
        Effect.flatMap(() => sql.unsafe("PRAGMA foreign_keys = ON")),
        Effect.asVoid,
        Effect.mapError((cause) => failure("P39_REPORT_DB_IO_FAILURE", cause)),
      );
    },
    writeAndReadBackSidecarReport: (_lease, reservation, report) => {
      if (snapshotState?.reservation !== reservation.reservation) {
        return Effect.fail(failure("P39_REPORT_COMMIT_UNRESOLVED"));
      }
      return options
        .writeAndReadBackSidecarReport(report)
        .pipe(
          Effect.mapError((cause) =>
            typeof cause === "object" &&
            cause !== null &&
            "_tag" in cause &&
            cause._tag === "P39MaintenanceFailure"
              ? (cause as P39MaintenanceFailure)
              : failure("P39_REPORT_COMMIT_UNRESOLVED", cause),
          ),
        );
    },
    applyOrderedMigrations: (_lease, reservation) => {
      const state = snapshotState;
      if (
        state === undefined ||
        state.reservation !== reservation.reservation ||
        state.released
      ) {
        return Effect.fail(failure("P39_MIGRATION_PREFIX_INVALID"));
      }
      return Effect.gen(function* () {
        const versions = yield* sql.unsafe<UserVersionRow>(
          "PRAGMA user_version",
        );
        const currentVersion = Number(versions[0]?.user_version);
        const suffix = P39_MAINTENANCE_MIGRATIONS.filter(
          ({ id }) => id > currentVersion,
        );
        yield* validateP39MigrationPrefix(currentVersion, suffix);
        for (const migration of suffix) {
          const approved = P39_MAINTENANCE_MIGRATION_MANIFEST[migration.id];
          if (
            approved === undefined ||
            approved.name !== migration.name ||
            approved.sha256 !== sha256Hex(migration.sql)
          ) {
            return yield* Effect.fail(failure("P39_MIGRATION_PREFIX_INVALID"));
          }
          for (const statement of splitStatements(migration.sql)) {
            yield* sql.unsafe(statement);
          }
          yield* sql.unsafe(`PRAGMA user_version = ${migration.id}`);
        }
        const violations = yield* sql.unsafe("PRAGMA foreign_key_check");
        if (violations.length > 0) {
          return yield* Effect.fail(
            failure("P39_MIGRATION_PREFIX_INVALID", violations),
          );
        }
        yield* sql.unsafe("COMMIT");
        state.committed = true;
      }).pipe(
        Effect.mapError(
          (cause: SqlError | SqliteAdapterError | P39MaintenanceFailure) =>
            typeof cause === "object" &&
            cause !== null &&
            "_tag" in cause &&
            cause._tag === "P39MaintenanceFailure"
              ? (cause as P39MaintenanceFailure)
              : failure("P39_MIGRATION_PREFIX_INVALID", cause),
        ),
      );
    },
  };
};
