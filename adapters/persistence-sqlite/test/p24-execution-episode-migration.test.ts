import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";
import { P24_MIGRATIONS } from "../src/migrations.js";

describe("DID v1.28 migration 0024 exact execution episode binding", () => {
  it("adds exact episode columns and the lookup index re-entrantly", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* runMigrations(P24_MIGRATIONS);
        const second = yield* runMigrations(P24_MIGRATIONS);
        const sql = yield* SqlClient;
        const columns = yield* sql.unsafe<{ name: string }>(
          "PRAGMA table_info(executions)",
        );
        const indexes = yield* sql.unsafe<{ name: string }>(
          "PRAGMA index_list(executions)",
        );
        const planColumns = yield* sql.unsafe<{ name: string }>(
          "PRAGMA table_info(work_plans)",
        );
        const decisionColumns = yield* sql.unsafe<{ name: string }>(
          "PRAGMA table_info(work_selection_decision_requests)",
        );
        const version = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        expect(first).toBe(24);
        expect(second).toBe(0);
        expect(version[0]?.user_version).toBe(24);
        expect(columns.map((column) => column.name)).toEqual(
          expect.arrayContaining([
            "episode_kind",
            "episode_ref",
            "episode_revision",
          ]),
        );
        expect(indexes.map((index) => index.name)).toContain(
          "idx_executions_episode",
        );
        expect(planColumns.map((column) => column.name)).toEqual(
          expect.arrayContaining([
            "work_id",
            "target_work_revision",
            "plan_revision",
            "items_json",
          ]),
        );
        expect(decisionColumns.map((column) => column.name)).toEqual(
          expect.arrayContaining([
            "decision_id",
            "candidate_work_ids_json",
            "workspace_revision",
            "selected_work_id",
          ]),
        );
      }).pipe(Effect.provide(layer({ filename: ":memory:" }))),
    );
  });
});
