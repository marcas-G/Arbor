import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer, P3_MIGRATIONS, runMigrations } from "../src/index.js";

const withClient = <A>(program: Effect.Effect<A, unknown, SqlClient>) =>
  Effect.runPromise(Effect.provide(program, layer({ filename: ":memory:" })));

describe("P3 DDL", () => {
  it("migrates to user_version 3 with the provider/model-context tables", async () => {
    const result = await withClient(
      Effect.gen(function* () {
        yield* runMigrations(P3_MIGRATIONS);
        const sql = yield* SqlClient;
        const version = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        const tables = yield* sql.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('provider_turns','provider_attempts','model_context_manifests')",
        );
        return {
          version: Number(version[0]?.user_version),
          tables: tables.map((t) => t.name).sort(),
        };
      }),
    );
    expect(result.version).toBe(3);
    expect(result.tables).toEqual([
      "model_context_manifests",
      "provider_attempts",
      "provider_turns",
    ]);
  });

  it("enforces the provider_turns settled/finish consistency check", async () => {
    const result = await withClient(
      Effect.gen(function* () {
        yield* runMigrations(P3_MIGRATIONS);
        const sql = yield* SqlClient;
        const bad = yield* sql
          .unsafe(
            "INSERT INTO provider_turns (provider_turn_id, execution_id, session_id, context_epoch, model_ref, output_contract_ref, manifest_id, started_at, settled_at, finish_reason, usage_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,?)",
            [
              "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
              "exe_x",
              "ses_x",
              0,
              "m",
              "oc",
              "man",
              "t",
              "t",
              "t",
            ],
          )
          .pipe(Effect.exit);
        return bad;
      }),
    );
    expect(result._tag).toBe("Failure");
  });
});
