import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { P24_MIGRATIONS, P25_MIGRATIONS } from "../src/migrations.js";

describe("DID v1.28 migration 0025 legacy focus retirement", () => {
  it("physically removes focus columns and leaves foreign keys valid", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runMigrations(P24_MIGRATIONS);
        const applied = yield* runMigrations(P25_MIGRATIONS);
        const second = yield* runMigrations(P25_MIGRATIONS);
        const sql = yield* SqlClient;
        const columns = yield* sql.unsafe<{ name: string }>(
          "PRAGMA table_info(executions)",
        );
        const violations = yield* sql.unsafe("PRAGMA foreign_key_check");
        const version = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        expect(applied).toBe(1);
        expect(second).toBe(0);
        expect(version[0]?.user_version).toBe(25);
        expect(columns.map((column) => column.name)).toEqual(
          expect.arrayContaining([
            "episode_kind",
            "episode_ref",
            "episode_revision",
          ]),
        );
        expect(columns.map((column) => column.name)).not.toEqual(
          expect.arrayContaining(["focus_kind", "focus_work_id"]),
        );
        expect(violations).toEqual([]);
      }).pipe(Effect.provide(layer({ filename: ":memory:" }))),
    );
  });
});
