import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  P7_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";

const freshDb = () => layer({ filename: ":memory:" });

describe("P7-007 messages kind CHECK: four → five (governance-approved deviation)", () => {
  it("fresh schema accepts Deliver and still rejects illegal kinds", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* runMigrations(P7_MIGRATIONS);
            const sql = yield* SqlClient;
            yield* sql.unsafe(
              "INSERT INTO messages (message_id, sender_workspace_id, recipient_workspace_id, kind, body_ref, sent_at) VALUES ('m1','ws_a','ws_b','Deliver','ref','t')",
            );
            const rows = yield* sql.unsafe<{ kind: string }>(
              "SELECT kind FROM messages WHERE message_id = 'm1'",
            );
            expect(rows[0]!.kind).toBe("Deliver");
            for (const kind of ["Broadcast", "deliver", ""]) {
              const rejected = yield* sql
                .unsafe(
                  "INSERT INTO messages (message_id, sender_workspace_id, recipient_workspace_id, kind, body_ref, sent_at) VALUES (?,?,?,?,?,'t')",
                  [`bad_${kind || "empty"}`, "ws_a", "ws_b", kind, "ref"],
                )
                .pipe(Effect.flip);
              expect(String(rejected)).toContain("SqlError");
            }
          }),
          freshDb(),
        ),
      ),
    );
  });

  it("v6 → v7 upgrade preserves existing rows and rejections keep working", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            // migrate to 6 first (pre-Deliver schema), seed legacy data
            const toV6 = P7_MIGRATIONS.filter((migration) => migration.id <= 6);
            yield* runMigrations(toV6);
            yield* sql.unsafe(
              "INSERT INTO messages (message_id, sender_workspace_id, recipient_workspace_id, kind, body_ref, correlation_id, causation_id, sent_at) VALUES ('old1','ws_a','ws_b','Report','ref1','cor1','cau1','t1'),('old2','ws_a','ws_c','Query','ref2',NULL,NULL,'t2')",
            );
            // Deliver is not yet legal at v6
            const pre = yield* sql
              .unsafe(
                "INSERT INTO messages (message_id, sender_workspace_id, recipient_workspace_id, kind, body_ref, sent_at) VALUES ('d1','ws_a','ws_b','Deliver','ref','t')",
              )
              .pipe(Effect.flip);
            expect(String(pre)).toContain("SqlError");
            // upgrade to 7
            yield* runMigrations(P7_MIGRATIONS);
            const legacy = yield* sql.unsafe<{
              message_id: string;
              kind: string;
              correlation_id: string | null;
            }>(
              "SELECT message_id, kind, correlation_id FROM messages ORDER BY message_id",
            );
            expect(legacy).toEqual([
              { message_id: "old1", kind: "Report", correlation_id: "cor1" },
              { message_id: "old2", kind: "Query", correlation_id: null },
            ]);
            // Deliver becomes legal after upgrade
            yield* sql.unsafe(
              "INSERT INTO messages (message_id, sender_workspace_id, recipient_workspace_id, kind, body_ref, sent_at) VALUES ('d1','ws_a','ws_b','Deliver','ref','t')",
            );
            const count = yield* sql.unsafe<{ count: number }>(
              "SELECT COUNT(*) AS count FROM messages",
            );
            expect(Number(count[0]!.count)).toBe(3);
            // index rebuilt and functional
            const viaIndex = yield* sql.unsafe<{ message_id: string }>(
              "SELECT message_id FROM messages WHERE correlation_id = 'cor1'",
            );
            expect(viaIndex[0]!.message_id).toBe("old1");
            // illegal kinds still rejected after upgrade
            const post = yield* sql
              .unsafe(
                "INSERT INTO messages (message_id, sender_workspace_id, recipient_workspace_id, kind, body_ref, sent_at) VALUES ('bad','ws_a','ws_b','Broadcast','ref','t')",
              )
              .pipe(Effect.flip);
            expect(String(post)).toContain("SqlError");
          }),
          freshDb(),
        ),
      ),
    );
  });

  it("schema shape is equivalent apart from the CHECK", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            yield* runMigrations(P7_MIGRATIONS);
            const columns = yield* sql.unsafe(
              "SELECT name, type, [notnull], pk FROM pragma_table_info('messages') ORDER BY cid",
            );
            expect(columns).toEqual([
              { name: "message_id", type: "TEXT", notnull: 0, pk: 1 },
              { name: "sender_workspace_id", type: "TEXT", notnull: 1, pk: 0 },
              {
                name: "recipient_workspace_id",
                type: "TEXT",
                notnull: 1,
                pk: 0,
              },
              { name: "kind", type: "TEXT", notnull: 1, pk: 0 },
              { name: "body_ref", type: "TEXT", notnull: 1, pk: 0 },
              { name: "correlation_id", type: "TEXT", notnull: 0, pk: 0 },
              { name: "causation_id", type: "TEXT", notnull: 0, pk: 0 },
              { name: "sent_at", type: "TEXT", notnull: 1, pk: 0 },
            ]);
            const indexes = yield* sql.unsafe<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' AND name NOT LIKE 'sqlite_%'",
            );
            expect(indexes.map((row) => row.name)).toEqual([
              "idx_messages_correlation",
            ]);
          }),
          freshDb(),
        ),
      ),
    );
  });
});
