import { it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vitest";
import {
  layer,
  P17_MIGRATIONS,
  P18_MIGRATIONS,
  runMigrations,
} from "../src/index.js";

describe("P18 project archive migration", () => {
  it.effect(
    "preserves existing messages and admits the Declined terminal state",
    () =>
      Effect.gen(function* () {
        yield* runMigrations(P17_MIGRATIONS);
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "INSERT INTO human_messages (message_id, project_id, root_workspace_id, human_principal, body_ref, command_id, fingerprint, state, created_at, attempt_no) VALUES ('msg_1','prj_1','ws_1','user:test','body','cmd_1','fp','Pending','t',0)",
        );
        yield* runMigrations(P18_MIGRATIONS);
        yield* sql.unsafe(
          "UPDATE human_messages SET state = 'Declined', settled_at = 't2' WHERE message_id = 'msg_1'",
        );
        const version = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        const rows = yield* sql.unsafe<{ state: string; body_ref: string }>(
          "SELECT state, body_ref FROM human_messages WHERE message_id = 'msg_1'",
        );
        expect(Number(version[0]?.user_version)).toBe(18);
        expect(rows[0]).toEqual({ state: "Declined", body_ref: "body" });
      }).pipe(Effect.provide(layer({ filename: ":memory:" }))),
  );
});
