import { it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vitest";
import { layer } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { P23_MIGRATIONS } from "../src/migrations.js";

describe("verification evidence identity migration", () => {
  it.effect("adds the three exact ToolObservation source columns", () =>
    Effect.gen(function* () {
      yield* runMigrations(P23_MIGRATIONS);
      const sql = yield* SqlClient;
      const columns = yield* sql.unsafe<{ name: string }>(
        "PRAGMA table_info(verification_evidence)",
      );
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          "tool_invocation_id",
          "observation_ref",
          "call_ref",
        ]),
      );
      const version = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      expect(version[0]?.user_version).toBe(23);
    }).pipe(Effect.provide(layer({ filename: ":memory:" }))),
  );
});
