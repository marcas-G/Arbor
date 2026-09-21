import type { InboxEntry, MessageId, WorkspaceId } from "@arbor/domain";
import {
  InboxProjectionStore,
  type InboxProjectionStoreError,
  type MessageRecord,
  MessageStore,
  type MessageStoreError,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

interface MessageRow {
  readonly message_id: string;
  readonly sender_workspace_id: string;
  readonly recipient_workspace_id: string;
  readonly kind: string;
  readonly body_ref: string;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly sent_at: string;
}

interface InboxRow {
  readonly workspace_id: string;
  readonly entry_key: string;
  readonly kind: string;
  readonly summary: string;
  readonly correlation_id: string | null;
  readonly admitted_at: string;
}

const toMessageRecord = (row: MessageRow): MessageRecord => ({
  messageId: row.message_id as MessageId,
  senderWorkspaceId: row.sender_workspace_id as WorkspaceId,
  message: {
    kind: row.kind as MessageRecord["message"]["kind"],
    recipientWorkspaceId: row.recipient_workspace_id as WorkspaceId,
    bodyRef: row.body_ref,
    correlationId: row.correlation_id ?? undefined,
    causationId: row.causation_id ?? undefined,
    urgency: "Normal",
  },
  sentAt: row.sent_at,
});

const toInboxEntry = (row: InboxRow): InboxEntry => ({
  recipientWorkspaceId: row.workspace_id as WorkspaceId,
  entryKey: row.entry_key,
  kind: row.kind as InboxEntry["kind"],
  summary: row.summary,
  correlationId: row.correlation_id ?? undefined,
  admittedAt: row.admitted_at,
});

/** P6 `02` §3/§4 (D2): durable communication facts + deterministic
 * correlation close. */
export const MessageStoreLive: Layer.Layer<MessageStore, never, SqlClient> =
  Layer.effect(
    MessageStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const failure = (cause: unknown): MessageStoreError => ({
        _tag: "MessageStoreFailure",
        cause,
      });
      const run = <A>(effect: Effect.Effect<A, SqlError>) =>
        effect.pipe(Effect.mapError(failure));
      return MessageStore.of({
        append: (record) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            yield* run(
              sql.unsafe(
                "INSERT INTO messages (message_id, sender_workspace_id, recipient_workspace_id, kind, body_ref, correlation_id, causation_id, sent_at) VALUES (?,?,?,?,?,?,?,?)",
                [
                  record.messageId,
                  record.senderWorkspaceId,
                  record.message.recipientWorkspaceId,
                  record.message.kind,
                  record.message.bodyRef,
                  record.message.correlationId ?? null,
                  record.message.causationId ?? null,
                  record.sentAt,
                ],
              ),
            );
          }),
        findById: (messageId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* run(
              sql.unsafe<MessageRow>(
                "SELECT message_id, sender_workspace_id, recipient_workspace_id, kind, body_ref, correlation_id, causation_id, sent_at FROM messages WHERE message_id = ?",
                [messageId],
              ),
            );
            return rows.length > 0
              ? Option.some(toMessageRecord(rows[0] as MessageRow))
              : Option.none();
          }),
        closeCorrelation: (correlationId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            yield* run(
              sql.unsafe(
                "INSERT INTO message_correlations (correlation_id, closed_at) VALUES (?,?) ON CONFLICT(correlation_id) DO NOTHING",
                [correlationId, new Date().toISOString()],
              ),
            );
          }),
        isCorrelationClosed: (correlationId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* run(
              sql.unsafe<{ correlation_id: string }>(
                "SELECT correlation_id FROM message_correlations WHERE correlation_id = ?",
                [correlationId],
              ),
            );
            return rows.length > 0;
          }),
      });
    }),
  );

/** P6 `02` §4 / `01` §3 (D3): upsert-by-entryKey admission makes at-least-once
 * replay a no-op; the Inbox is a projection of unconsumed input (SD §7.4). */
export const InboxProjectionStoreLive: Layer.Layer<
  InboxProjectionStore,
  never,
  SqlClient
> = Layer.effect(
  InboxProjectionStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = (cause: unknown): InboxProjectionStoreError => ({
      _tag: "InboxProjectionStoreFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    return InboxProjectionStore.of({
      admitUpsert: (entry) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              "INSERT INTO inbox_entries (workspace_id, entry_key, kind, summary, correlation_id, admitted_at, consumed_at) VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(workspace_id, entry_key) DO NOTHING",
              [
                entry.recipientWorkspaceId,
                entry.entryKey,
                entry.kind,
                entry.summary,
                entry.correlationId ?? null,
                entry.admittedAt,
              ],
            ),
          );
        }),
      listUnconsumed: (workspaceId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<InboxRow>(
              "SELECT workspace_id, entry_key, kind, summary, correlation_id, admitted_at FROM inbox_entries WHERE workspace_id = ? AND consumed_at IS NULL ORDER BY admitted_at",
              [workspaceId],
            ),
          );
          return rows.map(toInboxEntry);
        }),
      markConsumed: (workspaceId, entryKey) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              "UPDATE inbox_entries SET consumed_at = ? WHERE workspace_id = ? AND entry_key = ?",
              [new Date().toISOString(), workspaceId, entryKey],
            ),
          );
        }),
      countByKey: (workspaceId, entryKey) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ count: number }>(
              "SELECT COUNT(*) AS count FROM inbox_entries WHERE workspace_id = ? AND entry_key = ?",
              [workspaceId, entryKey],
            ),
          );
          return Number(rows[0]?.count ?? 0);
        }),
    });
  }),
);
