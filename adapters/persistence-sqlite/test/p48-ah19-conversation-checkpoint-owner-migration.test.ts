import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSchema44TestDatabaseFactory,
  type Schema44TestDatabase,
  type Schema44TestDatabaseFactory,
} from "../../../tests/support/schema44-database.js";
import {
  CURRENT_MIGRATIONS,
  layer,
  P45_RETRY_VERIFICATION_ORIGIN_MIGRATION,
  P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION,
  P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION,
  P48_AH19_CONVERSATION_CHECKPOINT_OWNER_MIGRATION,
  runMigrations,
} from "../src/index.js";

const run = (
  filename: string,
  migrations: Parameters<typeof runMigrations>[0] = [
    P48_AH19_CONVERSATION_CHECKPOINT_OWNER_MIGRATION,
  ],
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        runMigrations(migrations, { allowOfflineOnly: true }),
        layer({ filename }),
      ),
    ),
  );

const columns = (db: DatabaseSync, table: string) =>
  (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map(({ name }) => name);

let schema44Factory: Schema44TestDatabaseFactory | undefined;

beforeAll(async () => {
  schema44Factory = await createSchema44TestDatabaseFactory({
    prefix: ".p48-ah19-migration-schema44-template-",
  });
}, 120_000);

const createSchema44Clone = (): Schema44TestDatabase => {
  if (schema44Factory === undefined)
    throw new Error("Schema-44 migration template is not ready.");
  return schema44Factory.create();
};

const createSchema47Clone = async (): Promise<Schema44TestDatabase> => {
  const fixture = createSchema44Clone();
  try {
    const applied = await run(fixture.databaseFilename, [
      P45_RETRY_VERIFICATION_ORIGIN_MIGRATION,
      P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION,
      P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION,
    ]);
    if (applied !== 3) {
      throw new Error(
        `Schema-47 clone applied ${applied} migrations; expected 3.`,
      );
    }
    return fixture;
  } catch (cause) {
    fixture.cleanup();
    throw cause;
  }
};

afterAll(() => {
  schema44Factory?.cleanup();
  schema44Factory = undefined;
}, 120_000);

describe("P48 AH19 Root Workspace Conversation checkpoint owner migration", () => {
  it("requires exact schema 47 and appends after the F23/VCS/AH14 prefixes", async () => {
    expect(P48_AH19_CONVERSATION_CHECKPOINT_OWNER_MIGRATION).toMatchObject({
      id: 48,
      name: "conversation_checkpoint_owner",
      requiresUserVersion: 47,
      offlineOnly: true,
    });
    expect(CURRENT_MIGRATIONS.map(({ id }) => id).slice(-4)).toEqual([
      47, 48, 49, 50,
    ]);

    const from47 = await createSchema47Clone();
    const from44 = createSchema44Clone();
    try {
      expect(await run(from47.databaseFilename)).toBe(1);
      expect(await run(from47.databaseFilename)).toBe(0);
      expect(
        await run(from44.databaseFilename, [
          P45_RETRY_VERIFICATION_ORIGIN_MIGRATION,
          P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION,
          P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION,
          P48_AH19_CONVERSATION_CHECKPOINT_OWNER_MIGRATION,
        ]),
      ).toBe(4);
      for (const filename of [
        from47.databaseFilename,
        from44.databaseFilename,
      ]) {
        const db = new DatabaseSync(filename, { readOnly: true });
        try {
          expect(
            (
              db.prepare("PRAGMA user_version").get() as {
                user_version: number;
              }
            ).user_version,
          ).toBe(48);
          expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally {
          db.close();
        }
      }
    } finally {
      from47.cleanup();
      from44.cleanup();
    }
  });

  it("creates the exact separate owner table and ordered message index without backfill", async () => {
    const fixture = await createSchema47Clone();
    try {
      const before = new DatabaseSync(fixture.databaseFilename);
      try {
        before.exec("BEGIN IMMEDIATE");
        before
          .prepare(
            `INSERT INTO human_messages (
             message_id, project_id, root_workspace_id, human_principal,
             body_ref, command_id, fingerprint, state, claimed_by_execution_id,
             created_at, settled_at, response_body, attempt_no, provider_reasoning_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "msg_p48_preserved",
            "prj_p48_preserved",
            "ws_p48_preserved",
            "user:p48",
            "immutable legacy body",
            "cmd_p48_preserved",
            "fingerprint-p48-preserved",
            "Claimed",
            "exe_legacy_p48_claim",
            "2026-10-17T01:02:03.000Z",
            null,
            "legacy response evidence",
            3,
            JSON.stringify({ reasoning: "retain byte-for-byte" }),
          );
        before
          .prepare(
            `INSERT INTO sessions (
             session_id, binding_kind, workspace_id, execution_id,
             context_epoch, created_at
           ) VALUES (?, 'ExecutionScoped', NULL, ?, 7, ?)`,
          )
          .run(
            "ses_p48_unowned_checkpoint",
            "exe_p48_historical",
            "2026-10-17T01:02:03.000Z",
          );
        before
          .prepare(
            `INSERT INTO session_entries (
             session_id, sequence, entry_kind, item_type, schema_version,
             context_epoch, payload_json, created_at, source_kind, source_ref,
             content_hash
           ) VALUES (?, 9, 'CheckpointReference', 'LegacyCheckpointReference',
                     1, NULL, ?, ?, ?, ?, ?)`,
          )
          .run(
            "ses_p48_unowned_checkpoint",
            JSON.stringify({
              _tag: "CompactionCheckpoint",
              implementation: "Summary",
              fromEpoch: 6,
              toEpoch: 7,
              retainedFrontierRef: "frontier:legacy-session:6",
              summaryRef: "summary:legacy-session",
              summaryText: "preserve historical checkpoint",
            }),
            "2026-10-17T01:02:04.000Z",
            "CompactionTurn",
            "ptn_legacy_session_checkpoint",
            "legacy-session-checkpoint-hash",
          );
        before.exec("COMMIT");
      } catch (cause) {
        if (before.isTransaction) before.exec("ROLLBACK");
        throw cause;
      } finally {
        before.close();
      }
      const beforeRows = new DatabaseSync(fixture.databaseFilename, {
        readOnly: true,
      });
      let preservedMessages: unknown[];
      let preservedSession: unknown[];
      try {
        preservedMessages = beforeRows
          .prepare("SELECT * FROM human_messages WHERE message_id = ?")
          .all("msg_p48_preserved");
        preservedSession = beforeRows
          .prepare("SELECT * FROM session_entries WHERE session_id = ?")
          .all("ses_p48_unowned_checkpoint");
      } finally {
        beforeRows.close();
      }
      await run(fixture.databaseFilename);
      const db = new DatabaseSync(fixture.databaseFilename, { readOnly: true });
      try {
        expect(
          db
            .prepare("SELECT * FROM human_messages WHERE message_id = ?")
            .all("msg_p48_preserved"),
        ).toEqual(preservedMessages);
        expect(
          db
            .prepare("SELECT * FROM session_entries WHERE session_id = ?")
            .all("ses_p48_unowned_checkpoint"),
        ).toEqual(preservedSession);
        expect(columns(db, "conversation_checkpoint_owners")).toEqual([
          "root_workspace_id",
          "context_epoch",
          "covered_through_created_at",
          "covered_through_message_id",
          "checkpoint_kind",
          "checkpoint_ref",
          "binding_fingerprint",
          "source_manifest_json",
          "producer_execution_id",
          "producer_provider_turn_id",
          "updated_at",
        ]);
        expect(
          db
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_human_messages_conversation_order'",
            )
            .get(),
        ).toEqual({
          sql: "CREATE INDEX idx_human_messages_conversation_order\n  ON human_messages(root_workspace_id, created_at, message_id)",
        });
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM conversation_checkpoint_owners",
            )
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });
});
