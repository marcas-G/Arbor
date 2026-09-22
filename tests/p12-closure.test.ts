import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import {
  layer,
  P11B_MIGRATIONS,
  P12_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import { P12_MIGRATION_BASELINE } from "../packages/ports/src/index.js";

/**
 * B-11 remediation (`planning/final-system-closure.md` §B-11):
 *  - the P11(10) -> P12(13) upgrade path was verified ad hoc, never persisted;
 *  - `P12_MIGRATION_BASELINE` was a hand-maintained literal decoupled from
 *    `P12_MIGRATIONS`.
 *
 * This suite is the authoritative binding:
 *  - `P11B_BASELINE` / `P12_BASELINE` are DERIVED from the migration arrays
 *    (never an independent magic literal), so drift fails mechanically;
 *  - `P12_MIGRATION_BASELINE` must equal the derived `max(P12_MIGRATIONS id)`;
 *  - a real on-disk DB migrated to the P11 baseline is reopened (fresh
 *    connection) and upgraded to P12, proving persistence and the three P12
 *    schema additions (`execution_leases.worker_incarnation_id`,
 *    `permission_grants`, `project_tool_registry`).
 */

const maxId = (migrations: ReadonlyArray<{ readonly id: number }>): number =>
  migrations.reduce((max, migration) => Math.max(max, migration.id), 0);

const P11B_BASELINE = maxId(P11B_MIGRATIONS);
const P12_BASELINE = maxId(P12_MIGRATIONS);

const suiteTmp = mkdtempSync(join(tmpdir(), "arbor-p12-closure-"));
afterAll(() => {
  rmSync(suiteTmp, { recursive: true, force: true });
});

const columnNames = (sql: SqlClient, table: string) =>
  sql
    .unsafe<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
    .pipe(Effect.map((rows) => rows.map((row) => row.name)));

const tableNames = (sql: SqlClient, names: ReadonlyArray<string>) =>
  sql
    .unsafe<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${names
        .map((name) => `'${name}'`)
        .join(",")})`,
    )
    .pipe(Effect.map((rows) => rows.map((row) => row.name)));

describe("p12-closure migration/version baseline binding (B-11)", () => {
  it("P12_MIGRATION_BASELINE is mechanically bound to max(P12_MIGRATIONS id)", () => {
    // Authoritative binding: the literal must equal the derived max id.
    expect(P12_MIGRATION_BASELINE).toBe(P12_BASELINE);
    // Frozen baselines: the derivation is the source of truth; these pins
    // catch a missing/corrupted migration in either ordered array.
    expect(P11B_BASELINE).toBe(10);
    expect(P12_BASELINE).toBe(13);
  });
});

describe("p12-closure P11(10) -> P12(13) persisted upgrade path (B-11)", () => {
  it("reopens a persisted P11-baseline DB, applies P12 migrations, and lands user_version 13 with the P12 schema objects", async () => {
    const filename = join(suiteTmp, "upgrade.db");

    // Phase 1: persist a DB at the P11 baseline and prove the P12 schema
    // objects are not yet present.
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const applied = yield* runMigrations(P11B_MIGRATIONS);
            expect(applied).toBe(P11B_BASELINE);

            const sql = yield* SqlClient;
            const version = yield* sql.unsafe<{ user_version: number }>(
              "PRAGMA user_version",
            );
            expect(Number(version[0]?.user_version)).toBe(P11B_BASELINE);

            expect(yield* columnNames(sql, "execution_leases")).not.toContain(
              "worker_incarnation_id",
            );
            expect(
              yield* tableNames(sql, [
                "permission_grants",
                "project_tool_registry",
              ]),
            ).toEqual([]);
          }),
          layer({ filename }),
        ),
      ),
    );

    // Phase 2: reopen the SAME persisted file with a fresh connection and
    // apply the P12 migrations (forward-only, id > current).
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            const before = yield* sql.unsafe<{ user_version: number }>(
              "PRAGMA user_version",
            );
            expect(Number(before[0]?.user_version)).toBe(P11B_BASELINE);

            const applied = yield* runMigrations(P12_MIGRATIONS);
            expect(applied).toBe(P12_BASELINE - P11B_BASELINE);

            const after = yield* sql.unsafe<{ user_version: number }>(
              "PRAGMA user_version",
            );
            expect(Number(after[0]?.user_version)).toBe(P12_BASELINE);
            expect(Number(after[0]?.user_version)).toBe(P12_MIGRATION_BASELINE);
            expect(Number(after[0]?.user_version)).toBe(13);

            expect(yield* columnNames(sql, "execution_leases")).toContain(
              "worker_incarnation_id",
            );
            expect(
              (yield* tableNames(sql, [
                "permission_grants",
                "project_tool_registry",
              ])).sort(),
            ).toEqual(["permission_grants", "project_tool_registry"]);
          }),
          layer({ filename }),
        ),
      ),
    );
  });
});
