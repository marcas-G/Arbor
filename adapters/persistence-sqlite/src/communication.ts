import type { InboxEntry, MessageId, WorkspaceId } from "@arbor/domain";
import {
  InboxProjectionStore,
  type MessageRecord,
  MessageStore,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  persistenceCorruption,
  repositoryFailure,
} from "./repository-error.js";

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
  readonly revision?: number;
  readonly updated_at?: string;
  readonly consumed_at?: string | null;
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
  revision: row.revision === undefined ? undefined : Number(row.revision),
  updatedAt: row.updated_at,
});

/** P6 `02` §3/§4 (D2): durable communication facts + deterministic
 * correlation close. */
export const MessageStoreLive: Layer.Layer<MessageStore, never, SqlClient> =
  Layer.effect(
    MessageStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const failure = repositoryFailure("MessageStore", "message");
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
        listByRecipient: (recipientWorkspaceId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* run(
              sql.unsafe<MessageRow>(
                "SELECT message_id, sender_workspace_id, recipient_workspace_id, kind, body_ref, correlation_id, causation_id, sent_at FROM messages WHERE recipient_workspace_id = ? ORDER BY message_id",
                [recipientWorkspaceId],
              ),
            );
            return rows.map(toMessageRecord);
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
    const failure = repositoryFailure("InboxProjectionStore", "inbox");
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    const inboxColumns = yield* run(
      sql.unsafe<{ name: string }>("PRAGMA table_info(inbox_entries)"),
    ).pipe(Effect.orDie);
    const hasRouteRevision =
      inboxColumns.some((column) => column.name === "revision") &&
      inboxColumns.some((column) => column.name === "updated_at");
    return InboxProjectionStore.of({
      admitUpsert: (entry) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              hasRouteRevision
                ? "INSERT INTO inbox_entries (workspace_id, entry_key, kind, summary, correlation_id, admitted_at, consumed_at, revision, updated_at) VALUES (?,?,?,?,?,?,NULL,1,?) ON CONFLICT(workspace_id, entry_key) DO NOTHING"
                : "INSERT INTO inbox_entries (workspace_id, entry_key, kind, summary, correlation_id, admitted_at, consumed_at) VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(workspace_id, entry_key) DO NOTHING",
              [
                entry.recipientWorkspaceId,
                entry.entryKey,
                entry.kind,
                entry.summary,
                entry.correlationId ?? null,
                entry.admittedAt,
                ...(hasRouteRevision ? [entry.admittedAt] : []),
              ],
            ),
          );
        }),
      admitUpsertSequenced: (entry) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const inserted = yield* run(
            sql.unsafe<{ entry_key: string }>(
              hasRouteRevision
                ? "INSERT INTO inbox_entries (workspace_id, entry_key, kind, summary, correlation_id, admitted_at, consumed_at, revision, updated_at) VALUES (?,?,?,?,?,?,NULL,1,?) ON CONFLICT(workspace_id, entry_key) DO NOTHING RETURNING entry_key"
                : "INSERT INTO inbox_entries (workspace_id, entry_key, kind, summary, correlation_id, admitted_at, consumed_at) VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(workspace_id, entry_key) DO NOTHING RETURNING entry_key",
              [
                entry.recipientWorkspaceId,
                entry.entryKey,
                entry.kind,
                entry.summary,
                entry.correlationId ?? null,
                entry.admittedAt,
                ...(hasRouteRevision ? [entry.admittedAt] : []),
              ],
            ),
          );
          // Duplicate delivery is a no-op for both the entry and high-water mark.
          if (inserted.length > 0) {
            yield* run(
              sql.unsafe(
                "INSERT INTO inbox_workspace_sequences (workspace_id, last_sequence) VALUES (?,1) ON CONFLICT(workspace_id) DO UPDATE SET last_sequence = last_sequence + 1",
                [entry.recipientWorkspaceId],
              ),
            );
          }
        }),
      reconcileRetryVerificationUnboundLegacy: (entry, updatedAt) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          if (!hasRouteRevision) {
            return yield* Effect.fail(
              persistenceCorruption(
                "InboxProjectionStore",
                "reconcile-unbound-schema",
                "RetryVerification UnboundLegacy route reconciliation requires schema 45",
              ),
            );
          }
          const commandId = entry.entryKey.startsWith(
            "retry-verification-unbound:",
          )
            ? entry.entryKey.slice("retry-verification-unbound:".length)
            : "";
          if (
            entry.kind !== "Governance" ||
            commandId.length === 0 ||
            entry.correlationId !== commandId
          ) {
            return yield* Effect.fail(
              persistenceCorruption(
                "InboxProjectionStore",
                "reconcile-unbound-identity",
                "RetryVerification UnboundLegacy Inbox identity is malformed",
              ),
            );
          }
          const existing = yield* run(
            sql.unsafe<{
              workspace_id: string;
              kind: string;
              summary: string;
              correlation_id: string | null;
              admitted_at: string;
              consumed_at: string | null;
              revision: number;
            }>(
              `SELECT workspace_id, kind, summary, correlation_id,
                      admitted_at, consumed_at, revision
                 FROM inbox_entries WHERE entry_key = ?`,
              [entry.entryKey],
            ),
          );
          if (existing.length > 1) {
            return yield* Effect.fail(
              persistenceCorruption(
                "InboxProjectionStore",
                "reconcile-unbound-duplicate",
                "RetryVerification UnboundLegacy key has multiple route rows",
              ),
            );
          }
          const row = existing[0];
          if (row === undefined) {
            yield* run(
              sql.unsafe(
                `INSERT INTO inbox_entries (
                   workspace_id, entry_key, kind, summary, correlation_id,
                   admitted_at, consumed_at, revision, updated_at
                 ) VALUES (?,?,?,?,?,?,NULL,1,?)`,
                [
                  entry.recipientWorkspaceId,
                  entry.entryKey,
                  entry.kind,
                  entry.summary,
                  entry.correlationId,
                  entry.admittedAt,
                  entry.admittedAt,
                ],
              ),
            );
            return;
          }
          if (
            row.kind !== "Governance" ||
            row.summary !== entry.summary ||
            row.correlation_id !== commandId ||
            row.admitted_at !== entry.admittedAt ||
            row.consumed_at !== null ||
            !Number.isSafeInteger(Number(row.revision)) ||
            Number(row.revision) < 1
          ) {
            return yield* Effect.fail(
              persistenceCorruption(
                "InboxProjectionStore",
                "reconcile-unbound-conflict",
                "RetryVerification UnboundLegacy key conflicts with its immutable disposition projection",
              ),
            );
          }
          if (row.workspace_id === entry.recipientWorkspaceId) return;
          yield* run(
            sql.unsafe(
              `UPDATE inbox_entries
                  SET workspace_id = ?, revision = revision + 1, updated_at = ?
                WHERE workspace_id = ? AND entry_key = ? AND revision = ?`,
              [
                entry.recipientWorkspaceId,
                updatedAt,
                row.workspace_id,
                entry.entryKey,
                row.revision,
              ],
            ),
          );
        }),
      listUnconsumed: (workspaceId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<InboxRow>(
              hasRouteRevision
                ? "SELECT workspace_id, entry_key, kind, summary, correlation_id, admitted_at, revision, updated_at FROM inbox_entries WHERE workspace_id = ? AND consumed_at IS NULL ORDER BY admitted_at"
                : "SELECT workspace_id, entry_key, kind, summary, correlation_id, admitted_at FROM inbox_entries WHERE workspace_id = ? AND consumed_at IS NULL ORDER BY admitted_at",
              [workspaceId],
            ),
          );
          return rows.map(toInboxEntry);
        }),
      findByKey: (workspaceId, entryKey) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<InboxRow>(
              hasRouteRevision
                ? "SELECT workspace_id, entry_key, kind, summary, correlation_id, admitted_at, revision, updated_at FROM inbox_entries WHERE workspace_id = ? AND entry_key = ?"
                : "SELECT workspace_id, entry_key, kind, summary, correlation_id, admitted_at FROM inbox_entries WHERE workspace_id = ? AND entry_key = ?",
              [workspaceId, entryKey],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some(toInboxEntry(row));
        }),
      findStoredByKey: (workspaceId, entryKey) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<InboxRow>(
              hasRouteRevision
                ? `SELECT workspace_id, entry_key, kind, summary, correlation_id,
                          admitted_at, revision, updated_at, consumed_at
                     FROM inbox_entries WHERE workspace_id = ? AND entry_key = ?`
                : `SELECT workspace_id, entry_key, kind, summary, correlation_id,
                          admitted_at, consumed_at
                     FROM inbox_entries WHERE workspace_id = ? AND entry_key = ?`,
              [workspaceId, entryKey],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some({
                entry: toInboxEntry(row),
                consumedAt: row.consumed_at ?? null,
              });
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
      currentSequence: (workspaceId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ last_sequence: number }>(
              "SELECT last_sequence FROM inbox_workspace_sequences WHERE workspace_id = ?",
              [workspaceId],
            ),
          );
          return Number(rows[0]?.last_sequence ?? 0);
        }),
    });
  }),
);
