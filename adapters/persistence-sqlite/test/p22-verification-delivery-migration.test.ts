import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { P22_MIGRATIONS } from "../src/migrations.js";

describe("P22 verification delivery migration", () => {
  it("adds the durable summary_ref column and advances user_version", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runMigrations(P22_MIGRATIONS);
        const sql = yield* SqlClient;
        const columns = yield* sql.unsafe<{ name: string }>(
          "PRAGMA table_info(verifications)",
        );
        expect(columns.some((column) => column.name === "summary_ref")).toBe(
          true,
        );

        const version = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        expect(version[0]?.user_version).toBe(22);

        const triggers = yield* sql.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'verifications_conclusion_summary_%' ORDER BY name",
        );
        expect(triggers.map((trigger) => trigger.name)).toEqual([
          "verifications_conclusion_summary_insert",
          "verifications_conclusion_summary_update",
        ]);
      }).pipe(Effect.provide(layer({ filename: ":memory:" }))),
    );
  });
});
