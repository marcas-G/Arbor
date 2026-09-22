import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assertRestoreIsolation,
  assessStorage,
  deriveEnvelopeMeasurements,
  STORAGE_OPERATING_ENVELOPE,
  type StorageAssessmentArtifact,
  type StorageMeasurementReport,
} from "@arbor/application";
import {
  layer,
  P12_MIGRATIONS,
  runMigrations,
} from "@arbor/persistence-sqlite";
import { Duration, Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

/**
 * B-5 — executable, evidence-producing storage-scale measurement harness.
 *
 * Runs a representative single-writer workload against a fresh SQLite store
 * (the v1 canonical store) and measures the values the `StorageScaleAssessment`
 * reports. The assessed envelope `measurements` are DERIVED from this report
 * (`deriveEnvelopeMeasurements`), so no `observed` value is a hand-written
 * literal.
 *
 *   pnpm assess:storage
 *     → planning/results/P12.storage-assessment.json
 *
 * The frozen operating envelope + `StorageVerdict` are unchanged; the harness
 * keeps `SQLiteSufficient` unless the measured representative workload violates
 * a declared v1-actionable dimension.
 */

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const OUT_PATH = join(
  repoRoot,
  "planning",
  "results",
  "P12.storage-assessment.json",
);

const PROJECT = "prj_018f2b3c-4d5e-7abc-8def-0123456789b5";
const CONSUMER = "storage-assessment-harness";

/** Representative workload shape (kept bounded so the harness is quick). */
const EVENT_COUNT = 20_000;
const EVENT_BATCH = 250;
const COMMAND_LATENCY_SAMPLES = 200;
const AUTOCOMMIT_WRITES = 500;
const BATCHED_WRITES = 5_000;
const BATCHED_TRANSACTION_SIZE = 500;
const REPRESENTATIVE_TARGET_WPS = 300;
const REPRESENTATIVE_LOAD_MS = 1_500;

const GIB = 1024 ** 3;

const nowIso = (): string => new Date().toISOString();

const percentile = (
  sorted: ReadonlyArray<number>,
  fraction: number,
): number => {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
};

const withDb = <A>(
  dbFile: string,
  program: Effect.Effect<A, unknown, SqlClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(program, layer({ filename: dbFile }))),
  );

const insertCommand = (
  sql: SqlClient,
  index: number,
): Effect.Effect<unknown, unknown> =>
  sql.unsafe(
    "INSERT INTO commands (command_id, project_id, semantic_request_fingerprint, schema_version, fingerprint_algorithm_version, resolution, result_json, terminal_error_json, created_at, settled_at) VALUES (?,?,?,?,?,'Committed',?,NULL,?,?)",
    [
      `cmd_b5_${index.toString().padStart(8, "0")}`,
      PROJECT,
      `fingerprint_${index}`,
      "1",
      1,
      "{}",
      nowIso(),
      nowIso(),
    ],
  );

const eventRow = (index: number): ReadonlyArray<unknown> => [
  `evt_b5_${index.toString().padStart(8, "0")}`,
  PROJECT,
  index,
  "StorageAssessmentSample",
  1,
  nowIso(),
  `aggregate_${index}`,
  "harness",
  JSON.stringify({ index, payload: "x".repeat(160) }),
];

const insertEvents = (
  sql: SqlClient,
  start: number,
  count: number,
): Effect.Effect<unknown, unknown> => {
  const placeholders = Array.from(
    { length: count },
    () => "(?,?,?,?,?,?,?,?,NULL,NULL,NULL,?)",
  ).join(",");
  const params = Array.from({ length: count }, (_, offset) =>
    eventRow(start + offset),
  ).flat();
  return sql.unsafe(
    `INSERT INTO domain_events (event_id, project_id, sequence, event_type, event_version, occurred_at, aggregate_ref, actor, caused_by_command_id, caused_by_event_id, correlation_ref, payload_json) VALUES ${placeholders}`,
    params,
  );
};

const measure = (
  dbFile: string,
  backupFile: string,
): Promise<StorageMeasurementReport> =>
  withDb(
    dbFile,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* runMigrations(P12_MIGRATIONS);

      // -- 1. command latency (one committed transaction per command) --------
      const commandLatencies: number[] = [];
      for (let index = 0; index < COMMAND_LATENCY_SAMPLES; index += 1) {
        const started = performance.now();
        yield* sql.withTransaction(insertCommand(sql, index));
        commandLatencies.push(performance.now() - started);
      }
      const commandSorted = [...commandLatencies].sort((a, b) => a - b);

      // -- 2. write/transaction contention (autocommit vs batched) -----------
      const autocommitStart = performance.now();
      for (let index = 0; index < AUTOCOMMIT_WRITES; index += 1) {
        yield* insertCommand(sql, 100_000 + index);
      }
      const autocommitElapsed = performance.now() - autocommitStart;

      const batchedStart = performance.now();
      for (
        let written = 0;
        written < BATCHED_WRITES;
        written += BATCHED_TRANSACTION_SIZE
      ) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const size = Math.min(
              BATCHED_TRANSACTION_SIZE,
              BATCHED_WRITES - written,
            );
            for (let offset = 0; offset < size; offset += 1) {
              yield* insertCommand(sql, 200_000 + written + offset);
            }
          }),
        );
      }
      const batchedElapsed = performance.now() - batchedStart;
      const autocommitWps = (AUTOCOMMIT_WRITES / autocommitElapsed) * 1000;
      const batchedWps = (BATCHED_WRITES / batchedElapsed) * 1000;

      // -- 3. event log population (feeds size + consumer + rebuild) ---------
      for (let index = 0; index < EVENT_COUNT; index += EVENT_BATCH) {
        yield* insertEvents(
          sql,
          index,
          Math.min(EVENT_BATCH, EVENT_COUNT - index),
        );
      }

      // -- 4. event / DB size ------------------------------------------------
      yield* sql.unsafe("PRAGMA wal_checkpoint(TRUNCATE)");
      let dbBytes = 0;
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          dbBytes += statSync(`${dbFile}${suffix}`).size;
        } catch {
          // Optional WAL sidecar files may be absent after a truncate.
        }
      }

      // -- 5. scheduler / consumer throughput --------------------------------
      yield* sql.unsafe(
        "INSERT INTO consumer_offsets (consumer_id, project_id, last_sequence, updated_at) VALUES (?,?,0,?) ON CONFLICT (consumer_id, project_id) DO UPDATE SET last_sequence = 0, updated_at = excluded.updated_at",
        [CONSUMER, PROJECT, nowIso()],
      );
      const consumerStart = performance.now();
      let cursor = 0;
      let processed = 0;
      for (;;) {
        const batch = yield* sql.unsafe<{ sequence: number }>(
          "SELECT sequence FROM domain_events WHERE sequence > ? ORDER BY sequence LIMIT ?",
          [cursor, EVENT_BATCH],
        );
        if (batch.length === 0) {
          break;
        }
        cursor = Number(batch[batch.length - 1]?.sequence ?? cursor);
        processed += batch.length;
        yield* sql.unsafe(
          "UPDATE consumer_offsets SET last_sequence = ?, updated_at = ? WHERE consumer_id = ? AND project_id = ?",
          [cursor, nowIso(), CONSUMER, PROJECT],
        );
      }
      const consumerElapsed = performance.now() - consumerStart;
      const consumerEventsPerSecond = (processed / consumerElapsed) * 1000;

      // -- 6. projection rebuild duration ------------------------------------
      yield* sql.unsafe(
        "CREATE TABLE IF NOT EXISTS bench_projection (event_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_type TEXT NOT NULL)",
      );
      const rebuildStart = performance.now();
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe("DELETE FROM bench_projection");
          yield* sql.unsafe(
            "INSERT INTO bench_projection (event_id, project_id, sequence, event_type) SELECT event_id, project_id, sequence, event_type FROM domain_events ORDER BY sequence",
          );
        }),
      );
      const rebuildMs = performance.now() - rebuildStart;

      // -- 7. backup duration (online, consistent) ---------------------------
      const backupStart = performance.now();
      yield* sql.unsafe(`VACUUM INTO '${backupFile.replaceAll("'", "''")}'`);
      const backupMs = performance.now() - backupStart;

      // -- 8. representative concurrent load (single canonical writer) -------
      // Concurrent work items are serialized through ONE canonical writer
      // (v1 single-writer control plane); the load is paced to a realistic
      // pilot arrival rate so the observed demand (not the capability) is
      // measured against the declared envelope.
      const intervalMs = 1000 / REPRESENTATIVE_TARGET_WPS;
      const loadStart = performance.now();
      const loadLatencies: number[] = [];
      let submitted = 0;
      let succeeded = 0;
      while (performance.now() - loadStart < REPRESENTATIVE_LOAD_MS) {
        const tick = performance.now();
        try {
          const started = performance.now();
          yield* sql.withTransaction(insertCommand(sql, 300_000 + submitted));
          loadLatencies.push(performance.now() - started);
          succeeded += 1;
        } catch {
          // Availability counts successful operations over submitted ones.
        }
        submitted += 1;
        const wait = intervalMs - (performance.now() - tick);
        if (wait > 0) {
          yield* Effect.sleep(Duration.millis(wait));
        }
      }
      const loadElapsed = performance.now() - loadStart;
      const loadSorted = [...loadLatencies].sort((a, b) => a - b);
      const meanLatency =
        loadLatencies.reduce((sum, value) => sum + value, 0) /
        Math.max(1, loadLatencies.length);

      // -- restore duration (isolated path; measured after the load) ---------
      const restoredFile = `${dbFile}.restored`;
      const restoreStart = performance.now();
      assertRestoreIsolation(dbFile, restoredFile);
      copyFileSync(backupFile, restoredFile);
      const restoredDb = new DatabaseSync(restoredFile, { readOnly: true });
      try {
        restoredDb.prepare("PRAGMA user_version").all();
      } finally {
        restoredDb.close();
      }
      const restoreMs = performance.now() - restoreStart;

      const report: StorageMeasurementReport = {
        generatedAt: nowIso(),
        host: hostname(),
        commandLatency: {
          meanMs:
            commandLatencies.reduce((sum, value) => sum + value, 0) /
            commandLatencies.length,
          p95Ms: percentile(commandSorted, 0.95),
          samples: commandLatencies.length,
          method:
            "one committed transaction per command; wall-clock per command (performance.now)",
          workload: "sequential representative command writes",
        },
        writeTransactionContention: {
          achievedWritesPerSecond: autocommitWps,
          writers: 1,
          serializationFactor: batchedWps / autocommitWps,
          method:
            "single canonical writer: autocommit writes/s vs batched-transaction writes/s (serialization factor = batched / autocommit)",
          workload: `${AUTOCOMMIT_WRITES} autocommit + ${BATCHED_WRITES} batched command writes`,
        },
        eventDbSize: {
          value: dbBytes / GIB,
          unit: "GiB",
          method:
            "sum of the database file and its WAL/SHM sidecars after wal_checkpoint(TRUNCATE)",
          workload: `${EVENT_COUNT} representative domain events`,
        },
        schedulerConsumerThroughput: {
          value: consumerEventsPerSecond,
          unit: "events/s",
          method:
            "consumer catch-up: batched SELECT over domain_events with a durable consumer_offsets advance per batch",
          workload: `${EVENT_COUNT} domain events (batch ${EVENT_BATCH})`,
        },
        projectionRebuildDuration: {
          value: rebuildMs,
          unit: "ms",
          method:
            "full rebuild: clear and re-materialize a projection table from the event log in one transaction",
          workload: `${EVENT_COUNT} domain events`,
        },
        backupDuration: {
          value: backupMs,
          unit: "ms",
          method: "SQLite online backup via VACUUM INTO",
          workload: `${EVENT_COUNT} events + representative command writes`,
        },
        restoreDuration: {
          value: restoreMs,
          unit: "ms",
          method:
            "restore the backup into an isolated path (copyFileSync; never the canonical writer)",
          workload: "isolated drill restore",
        },
        representativeConcurrentLoad: {
          maxConcurrentWriters: 1,
          achievedWritesPerSecond: (submitted / loadElapsed) * 1000,
          availability: succeeded / Math.max(1, submitted),
          meanLatencyMs: meanLatency,
          p95LatencyMs: percentile(loadSorted, 0.95),
          totalOperations: submitted,
          method:
            "paced representative load; concurrent work items serialized through one canonical writer",
          workload: `target ${REPRESENTATIVE_TARGET_WPS} writes/s for ${REPRESENTATIVE_LOAD_MS}ms`,
        },
      };

      return report;
    }),
  );

export const runStorageAssessment =
  async (): Promise<StorageAssessmentArtifact> => {
    const workDir = mkdtempSync(join(tmpdir(), "arbor-storage-assessment-"));
    const dbFile = join(workDir, "assessment.db");
    const backupFile = join(workDir, "assessment-backup.db");
    try {
      const harness = await measure(dbFile, backupFile);
      const measurements = deriveEnvelopeMeasurements(harness);
      const assessed = assessStorage(STORAGE_OPERATING_ENVELOPE, measurements);
      const artifact: StorageAssessmentArtifact = {
        operatingEnvelope: assessed.operatingEnvelope,
        measurements: assessed.measurements,
        verdict: assessed.verdict,
        postgresTrigger: assessed.postgresTrigger,
        governanceGatedTriggers: assessed.governanceGatedTriggers,
        harness,
      };
      mkdirSync(dirname(OUT_PATH), { recursive: true });
      writeFileSync(OUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
      return artifact;
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  };

if (import.meta.url === `file://${process.argv[1]}`) {
  runStorageAssessment()
    .then((artifact) => {
      process.stdout.write(
        `storage assessment complete: verdict=${artifact.verdict} measurements=${artifact.measurements.length}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`storage assessment failed: ${String(error)}\n`);
      process.exitCode = 1;
    });
}
