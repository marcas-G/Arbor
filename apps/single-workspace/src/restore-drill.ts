import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  assertRestoreIsolation,
  isPreRestoreIncarnationMatch,
  type RestoreDrillArtifact,
  type RestoredLease,
  reconcileRestoredLeases,
  toIsoDuration,
} from "@arbor/application";
import {
  layer,
  P12_MIGRATIONS,
  runMigrations,
} from "@arbor/persistence-sqlite";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

/**
 * P12 `05` §4.1 (E-11) — `pnpm drill:restore`.
 *
 * Restores a backup of the canonical SQLite store into an ISOLATED drill
 * environment (a separate path, never the canonical writer), measures actual
 * RPO/RTO against the declared `DurabilityEnvelope`, reconciles leases
 * post-restore (RG-07) so a pre-restore worker incarnation cannot commit, and
 * emits `planning/results/P12.restore-drill.json`.
 */

const repoRoot = join(import.meta.dirname, "..", "..", "..");

const PROJECT = "prj_018f2b3c-4d5e-7abc-8def-0123456789d1";
const WS = "ws_018f2b3c-4d5e-7abc-8def-0123456789d1";
const SES = "ses_018f2b3c-4d5e-7abc-8def-0123456789d1";
const EXE = "exe_018f2b3c-4d5e-7abc-8def-0123456789d1";
const WORKER = "wrk_restore_drill";
const INCARNATION = "wic_018f2b3c-4d5e-7abc-8def-0123456789d1";

interface LeaseRow {
  readonly execution_id: string;
  readonly worker_id: string;
  readonly worker_incarnation_id: string;
  readonly generation: number;
}

const withDb = <A>(
  dbFile: string,
  program: Effect.Effect<A, unknown, SqlClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(program, layer({ filename: dbFile }))),
  );

const seedProgram = Effect.gen(function* () {
  yield* runMigrations(P12_MIGRATIONS);
  const sql = yield* SqlClient;
  // The P1 relational FKs are DEFERRABLE INITIALLY DEFERRED, so the seed rows
  // must be written in ONE transaction (the deferred checks resolve at COMMIT).
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,'WorkspacePrimary',?,NULL,0,'t')",
        [SES, WS],
      );
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,'p',?,'{}',0,'{}','local','Open',0,'t','t')",
        [PROJECT, WS],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'root','{}',1,'{}',1,'{}',?,'{}',0,0,'Active','t','t')",
        [WS, PROJECT, SES],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,'workspace',?,'coordination',NULL,NULL,NULL,?,'t',NULL,NULL,NULL,NULL)",
        [EXE, PROJECT, WS, SES],
      );
      yield* sql.unsafe(
        "INSERT INTO execution_leases (execution_id, worker_id, worker_incarnation_id, generation, expires_at, updated_at) VALUES (?,?,?,0,'2999-01-01T00:00:00Z','t')",
        [EXE, WORKER, INCARNATION],
      );
    }),
  );
});

const readLeases = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<LeaseRow>(
    "SELECT execution_id, worker_id, worker_incarnation_id, generation FROM execution_leases",
  );
  return rows.map(
    (row): RestoredLease => ({
      executionId: row.execution_id,
      workerId: row.worker_id,
      workerIncarnationId: row.worker_incarnation_id,
      generation: Number(row.generation),
    }),
  );
});

export const runRestoreDrill = async (): Promise<RestoreDrillArtifact> => {
  const workDir = mkdtempSync(join(tmpdir(), "arbor-restore-drill-"));
  const canonicalDb = join(workDir, "canonical.db");
  const backupDb = join(workDir, "backup.db");
  const restoredDb = join(workDir, "restored.db");
  try {
    // -- 1. canonical store + seed -----------------------------------------
    await withDb(canonicalDb, seedProgram);
    const lastWriteAt = Date.now();

    // -- 2. backup (online, consistent) ------------------------------------
    const backupAt = Date.now();
    await withDb(
      canonicalDb,
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql.unsafe(`VACUUM INTO '${backupDb.replaceAll("'", "''")}'`);
      }),
    );
    const measuredRpoMs = Math.max(0, backupAt - lastWriteAt);

    // -- 3. restore into an ISOLATED path (never the canonical writer) -----
    const restoreStart = Date.now();
    assertRestoreIsolation(canonicalDb, restoredDb);
    copyFileSync(backupDb, restoredDb);
    const restoredDbHash = `sha256:${createHash("sha256")
      .update(readFileSync(restoredDb))
      .digest("hex")}`;

    const migrationUserVersion = await withDb(
      restoredDb,
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        return Number(rows[0]?.user_version ?? 0);
      }),
    );

    // -- 4. post-restore fencing reconciliation (RG-07) --------------------
    const restoredLeases = await withDb(restoredDb, readLeases);
    const reconciliation = reconcileRestoredLeases(restoredLeases);
    await withDb(
      restoredDb,
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        for (const lease of reconciliation.reconciled) {
          yield* sql.unsafe(
            "UPDATE execution_leases SET worker_incarnation_id = ?, generation = ? WHERE execution_id = ?",
            [lease.workerIncarnationId, lease.generation, lease.executionId],
          );
        }
      }),
    );
    const postRestoreLeases = await withDb(restoredDb, readLeases);
    const staleMatches = postRestoreLeases.filter((row) =>
      restoredLeases.some((original) =>
        isPreRestoreIncarnationMatch(
          row,
          original.workerId,
          original.workerIncarnationId,
          original.generation,
        ),
      ),
    ).length;
    if (staleMatches !== 0) {
      throw new Error(
        `restore drill: ${staleMatches} pre-restore lease incarnation(s) survived reconciliation`,
      );
    }
    const measuredRtoMs = Date.now() - restoreStart;

    const artifact: RestoreDrillArtifact = {
      timestamp: new Date().toISOString(),
      backupRef: `backup://${basename(backupDb)}`,
      restoredDbHash,
      migrationUserVersion,
      measuredRpo: toIsoDuration(measuredRpoMs),
      measuredRto: toIsoDuration(measuredRtoMs),
    };
    const outPath = join(
      repoRoot,
      "planning",
      "results",
      "P12.restore-drill.json",
    );
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
    return artifact;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runRestoreDrill()
    .then((artifact) => {
      process.stdout.write(
        `restore drill complete: ${JSON.stringify(artifact)}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`restore drill failed: ${String(error)}\n`);
      process.exitCode = 1;
    });
}
