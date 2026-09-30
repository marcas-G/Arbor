import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer, P17_MIGRATIONS, runMigrations } from "../src/index.js";

const withClient = <A>(program: Effect.Effect<A, unknown, SqlClient>) =>
  Effect.runPromise(Effect.provide(program, layer({ filename: ":memory:" })));

describe("P17 AgentLoopStep migration", () => {
  it("adds the step/action tables and sourced-session evidence at version 17", async () => {
    const result = await withClient(
      Effect.gen(function* () {
        yield* runMigrations(P17_MIGRATIONS);
        const sql = yield* SqlClient;
        const version = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        const tables = yield* sql.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_loop_steps','agent_loop_step_actions') ORDER BY name",
        );
        const sessionColumns = yield* sql.unsafe<{ name: string }>(
          "PRAGMA table_info(session_entries)",
        );
        const attemptColumns = yield* sql.unsafe<{ name: string }>(
          "PRAGMA table_info(provider_attempts)",
        );
        const sourceIndex = yield* sql.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_session_entries_source'",
        );
        const sessionTable = yield* sql.unsafe<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_entries'",
        );
        return {
          version: Number(version[0]?.user_version),
          tables: tables.map((row) => row.name),
          sessionColumns: sessionColumns.map((row) => row.name),
          attemptColumns: attemptColumns.map((row) => row.name),
          sourceIndex: sourceIndex.map((row) => row.name),
          sessionTableSql: sessionTable[0]?.sql ?? "",
        };
      }),
    );

    expect(result.version).toBe(17);
    expect(result.tables).toEqual([
      "agent_loop_step_actions",
      "agent_loop_steps",
    ]);
    expect(result.sessionColumns).toEqual(
      expect.arrayContaining(["source_kind", "source_ref", "content_hash"]),
    );
    expect(result.attemptColumns).toContain("success_evidence_version");
    expect(result.sourceIndex).toEqual(["idx_session_entries_source"]);
    expect(result.sessionTableSql).toContain(
      "source_kind IS NULL AND source_ref IS NULL AND content_hash IS NULL",
    );
  });

  it("rejects partially populated source identity", async () => {
    const exit = await withClient(
      Effect.gen(function* () {
        yield* runMigrations(P17_MIGRATIONS);
        const sql = yield* SqlClient;
        yield* sql.unsafe("PRAGMA foreign_keys = OFF");
        return yield* sql
          .unsafe(
            "INSERT INTO session_entries (session_id, sequence, entry_kind, payload_json, created_at, source_kind) VALUES ('ses_missing', 0, 'ModelOutput', '{}', 't', 'ProviderTurn')",
          )
          .pipe(Effect.exit);
      }),
    );
    expect(exit._tag).toBe("Failure");
  });
});
