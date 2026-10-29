import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  P39_REPORT_APPLICATION_ID,
  P39_REPORT_DATABASE_DDL,
  P39_REPORT_USER_VERSION,
  layer as sqliteLayer,
} from "@arbor/persistence-sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  P6InboxRebuildRefusal,
  parseP6InboxRebuildArguments,
  runP6InboxRebuild,
} from "../dist/p6-inbox-rebuild.js";

const sha256 = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** The public production CLI has already qualified this database's protected
 * Windows path in the sibling smoke.  Matrix children use the same stable
 * lock filename but deliberately do not repeat the unrelated PowerShell ACL
 * probe for every crash boundary. */
const qualifiedWriterLockFilename = (primaryFilename) => {
  const primary = resolve(primaryFilename);
  const stat = statSync(primary, { bigint: true });
  const lock = join(
    dirname(primary),
    `.arbor-p39-writer-${sha256(`${stat.dev}:${stat.ino}`)}.sqlite`,
  );
  if (!existsSync(lock)) {
    const descriptor = openSync(lock, "wx", 0o600);
    closeSync(descriptor);
  }
  return lock;
};

const failure = (code, cause) => ({
  _tag: "P39MaintenanceFailure",
  code,
  ...(cause === undefined ? {} : { cause }),
});

/** Real SQLite cross-process exclusion plus the production P6 callback and
 * transaction code.  This is a process qualification adapter, not a product
 * fallback: the production default remains runP39SqliteMaintenanceWithPermit. */
const runQualifiedSqliteMaintenance = (
  options,
  continuation,
  settings = {},
) => {
  const lockFilename = qualifiedWriterLockFilename(options.primaryFilename);
  const configuredBusyTimeout = Number.parseInt(
    process.env.ARBOR_P6_TEST_LOCK_BUSY_TIMEOUT_MS ?? "60000",
    10,
  );
  const busyTimeoutMs = Number.isSafeInteger(configuredBusyTimeout)
    ? Math.min(60_000, Math.max(1, configuredBusyTimeout))
    : 60_000;
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        if (!existsSync(options.sidecarFilename)) {
          const sidecar = new DatabaseSync(options.sidecarFilename);
          try {
            sidecar.exec(
              `PRAGMA application_id = ${P39_REPORT_APPLICATION_ID}; PRAGMA user_version = ${P39_REPORT_USER_VERSION}; ${P39_REPORT_DATABASE_DDL}`,
            );
          } finally {
            sidecar.close();
          }
        }
        const lock = new DatabaseSync(lockFilename);
        lock.exec(
          `PRAGMA busy_timeout = ${busyTimeoutMs}; CREATE TABLE IF NOT EXISTS p39_writer_lock (lock_id INTEGER PRIMARY KEY CHECK (lock_id = 1)); INSERT OR IGNORE INTO p39_writer_lock(lock_id) VALUES (1); BEGIN IMMEDIATE;`,
        );
        process.stdout.write("P6_TEST_LOCK_ACQUIRED\n");
        return lock;
      },
      catch: (cause) => failure("P39_WRITER_LOCK_ACQUIRE_FAILED", cause),
    }),
    () =>
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const client = yield* SqlClient;
            const primary = {
              unsafe: client.unsafe,
              withTransaction: client.withTransaction,
            };
            const permit = {
              token: `p6-test-permit:${process.pid}`,
              mode: "MaintenanceExclusive",
            };
            settings.onPhase?.("manifest-validation");
            process.stdout.write("P6_TEST_BEFORE_MAINTENANCE\n");
            const proceed = settings.beforeMaintenance
              ? yield* settings.beforeMaintenance(primary, permit)
              : true;
            process.stdout.write("P6_TEST_AFTER_MAINTENANCE\n");
            if (proceed) {
              settings.onPhase?.("p40-p52-continuation");
              yield* continuation(primary, permit);
              process.stdout.write("P6_TEST_AFTER_CONTINUATION\n");
            }
          }),
          sqliteLayer({
            filename: options.primaryFilename,
            disableWAL: false,
          }),
        ),
      ),
    (lock) =>
      Effect.sync(() => {
        try {
          if (lock.isTransaction) lock.exec("ROLLBACK");
        } finally {
          lock.close();
          process.stdout.write("P6_TEST_LOCK_RELEASED\n");
        }
      }),
  );
};

const dependencies = {
  writerLockFilename: qualifiedWriterLockFilename,
  runMaintenanceWithPermit: runQualifiedSqliteMaintenance,
};

const runWithHardDeadline = async (args) => {
  const hardDeadline = setTimeout(() => {
    process.stderr.write("P6_TEST_CHILD_HARD_DEADLINE\n");
    process.exit(124);
  }, 90_000);
  hardDeadline.unref();
  try {
    await runP6InboxRebuild(parseP6InboxRebuildArguments(args), dependencies);
    return { code: 0, output: "P6 Inbox projection rebuild committed." };
  } catch (cause) {
    return {
      code: 1,
      output:
        cause instanceof P6InboxRebuildRefusal
          ? cause.message
          : `P6 test child failed (${String(cause)}).`,
    };
  } finally {
    clearTimeout(hardDeadline);
  }
};

const result = await runWithHardDeadline(process.argv.slice(2));
if (result.code === 0) process.stdout.write(`${result.output}\n`);
else process.stderr.write(`${result.output}\n`);
process.exitCode = result.code;
