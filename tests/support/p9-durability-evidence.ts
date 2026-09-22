import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { layer } from "../../adapters/persistence-sqlite/src/index.js";

/** P9 `02` §12 (GQ5) — the frozen durability-asserted evidence protocol.
 * Power loss (DA1) and WAL-checkpoint crash (DA2) are NOT reproducible
 * in-process and are never simulated here (no fault-injecting SQLite
 * adapter); the evidence is collected by REOPENING the durable file with
 * a fresh connection and checking the SQLite durability contract:
 *
 *   1. synchronous = FULL + WAL active (P1 `04` §1; invariant 60)
 *   2. reopen succeeds; PRAGMA integrity_check = ok
 *   3. PRAGMA user_version == frozen migration baseline (P1 `06` §5)
 *   4. count reconciliation across the core tables
 *   5. the result is labeled "durability-asserted" — never crash-injected
 */

export interface DurabilityEvidenceCounts {
  readonly works: number;
  readonly executions: number;
  readonly execution_leases: number;
  readonly domain_events: number;
  readonly commands: number;
  readonly consumer_offsets: number;
}

export interface DurabilityEvidence {
  readonly guarantee: "durability-asserted";
  readonly filename: string;
  readonly synchronous: number;
  readonly journalMode: string;
  readonly integrity: string;
  readonly version: number;
  readonly counts: DurabilityEvidenceCounts;
}

const collect = (filename: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const synchronous = yield* sql.unsafe<{ synchronous: number }>(
      "PRAGMA synchronous",
    );
    const journalMode = yield* sql.unsafe<{ journal_mode: string }>(
      "PRAGMA journal_mode",
    );
    const integrity = yield* sql.unsafe<{ integrity_check: string }>(
      "PRAGMA integrity_check",
    );
    const version = yield* sql.unsafe<{ user_version: number }>(
      "PRAGMA user_version",
    );
    const countOf = (table: string) =>
      sql
        .unsafe<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)
        .pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));
    const counts: DurabilityEvidenceCounts = {
      works: yield* countOf("works"),
      executions: yield* countOf("executions"),
      execution_leases: yield* countOf("execution_leases"),
      domain_events: yield* countOf("domain_events"),
      commands: yield* countOf("commands"),
      consumer_offsets: yield* countOf("consumer_offsets"),
    };
    return {
      guarantee: "durability-asserted" as const,
      filename,
      synchronous: Number(synchronous[0]?.synchronous ?? 0),
      journalMode: String(journalMode[0]?.journal_mode ?? ""),
      integrity: String(integrity[0]?.integrity_check ?? ""),
      version: Number(version[0]?.user_version ?? 0),
      counts,
    } satisfies DurabilityEvidence;
  });

/** Reopen the durable DB file with a fresh connection (per daemon restart
 * / suite run) and collect the five-step evidence record. */
export const collectDurabilityEvidence = async (
  filename: string,
): Promise<DurabilityEvidence> =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(collect(filename), layer({ filename }))),
  );
