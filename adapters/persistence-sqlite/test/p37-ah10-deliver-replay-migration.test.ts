import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer } from "../src/index.js";
import { runMigrations } from "../src/migrate.js";
import {
  P33_MIGRATIONS,
  P34_MIGRATIONS,
  P35_MIGRATIONS,
  P36_MIGRATIONS,
  P37_MIGRATIONS,
} from "../src/migrations.js";

const runDb = <A>(program: Effect.Effect<A, unknown, SqlClient>) =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(program, layer({ filename: ":memory:" }))),
  );

const prefixes = [
  { label: "v33", migrations: P33_MIGRATIONS, expectedApplied: 4 },
  { label: "v34", migrations: P34_MIGRATIONS, expectedApplied: 3 },
  { label: "v35", migrations: P35_MIGRATIONS, expectedApplied: 2 },
  { label: "v36", migrations: P36_MIGRATIONS, expectedApplied: 1 },
];

describe("P37 AH10 DeliverReplay migration", () => {
  it.each(prefixes)(
    "upgrades $label through the ordered prefix to v37",
    ({ migrations, expectedApplied }) =>
      runDb(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* runMigrations(migrations);
          const applied = yield* runMigrations(P37_MIGRATIONS);
          const version = yield* sql.unsafe<{ user_version: number }>(
            "PRAGMA user_version",
          );
          const tables = yield* sql.unsafe<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?, ?)",
            [
              "deliver_replay_attention_facts",
              "deliver_replay_attention_pending",
              "deliver_replay_attention_rows",
            ],
          );
          expect(applied).toBe(expectedApplied);
          expect(Number(version[0]?.user_version)).toBe(37);
          expect(tables.map(({ name }) => name).sort()).toEqual([
            "deliver_replay_attention_facts",
            "deliver_replay_attention_pending",
            "deliver_replay_attention_rows",
          ]);
        }),
      ),
  );

  it("keeps the audit event prunable while protecting queue provenance and ACK order", () =>
    runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* runMigrations(P37_MIGRATIONS);
        const facts = yield* sql.unsafe<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='deliver_replay_attention_facts'",
        );
        const pending = yield* sql.unsafe<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='deliver_replay_attention_pending'",
        );
        const trigger = yield* sql.unsafe<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name='deliver_replay_pending_delete_requires_marker'",
        );
        expect(facts[0]?.sql).toContain(
          "event_id                TEXT NOT NULL UNIQUE",
        );
        expect(facts[0]?.sql).not.toMatch(/FOREIGN KEY\s*\(event_id\)/i);
        expect(pending[0]?.sql).toContain(
          "queue_sequence     INTEGER PRIMARY KEY AUTOINCREMENT",
        );
        expect(pending[0]?.sql).toContain(
          "REFERENCES deliver_replay_attention_facts(attention_fact_id, project_id)",
        );
        expect(trigger).toHaveLength(1);
      }),
    ));
});
