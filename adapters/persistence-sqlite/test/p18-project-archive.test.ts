import { HumanMessageStore, TransactionPort } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  HumanMessageStoreLive,
  layer,
  P17_MIGRATIONS,
  P18_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
} from "../src/index.js";

const withClient = <A>(program: Effect.Effect<A, unknown, SqlClient>) =>
  Effect.runPromise(Effect.provide(program, layer({ filename: ":memory:" })));

describe("P18 project archive migration", () => {
  it("preserves existing messages and admits the Declined terminal state", async () => {
    const result = await withClient(
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
        return { version: Number(version[0]?.user_version), row: rows[0] };
      }),
    );
    expect(result.version).toBe(18);
    expect(result.row).toEqual({ state: "Declined", body_ref: "body" });
  });

  it("atomically refuses Pending to Claimed when the owning Project is Closed", async () => {
    const base = layer({ filename: ":memory:" });
    const services = Layer.mergeAll(
      base,
      Layer.provide(HumanMessageStoreLive, base),
      Layer.provide(TransactionPortLive, base),
    );
    const outcome = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P18_MIGRATIONS);
          const sql = yield* SqlClient;
          yield* sql.unsafe("PRAGMA foreign_keys = OFF");
          yield* sql.unsafe(
            "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES ('prj_closed', 'p', 'ws_root', '{}', 0, '{}', 'local', 'Closed', 0, 't', 't')",
          );
          const messages = yield* HumanMessageStore;
          const tx = yield* TransactionPort;
          yield* tx.transact(
            messages.insertPending({
              messageId: "msg_closed",
              projectId: "prj_closed" as never,
              rootWorkspaceId: "ws_root" as never,
              humanPrincipal: "user:test" as never,
              bodyRef: "body",
              commandId: "cmd_closed" as never,
              fingerprint: "fp_closed",
              state: "Pending",
              claimedByExecutionId: null,
              createdAt: "t",
              settledAt: null,
              responseBody: null,
              providerReasoning: null,
              attemptNo: 0,
            }),
          );
          const claim = yield* tx.transact(
            messages.claim("msg_closed", "exe_closed"),
          );
          const found = yield* tx.transact(messages.findById("msg_closed"));
          return { claim, found };
        }),
        services,
      ),
    );
    expect(outcome.claim._tag).toBe("AlreadyClaimed");
    expect(outcome.found._tag).toBe("Some");
    if (outcome.found._tag === "Some") {
      expect(outcome.found.value.state).toBe("Pending");
    }
  });
});
