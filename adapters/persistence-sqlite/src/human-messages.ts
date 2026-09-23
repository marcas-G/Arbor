import type { Principal, ProjectId, WorkspaceId } from "@arbor/domain";
import {
  type HumanMessageConflict,
  type HumanMessageRecord,
  HumanMessageStore,
  type HumanMessageStoreError,
  type HumanMessageStoreService,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/**
 * P14 `01` §4 — the durable human-message store (SQLite). Writes happen in
 * the command transaction (`TransactionScope`); claim is a single-statement
 * CAS (Pending → Claimed) so concurrent triggers cannot double-admit the
 * same message (P14 `02` §2).
 */

interface HumanMessageRow {
  readonly message_id: string;
  readonly project_id: string;
  readonly root_workspace_id: string;
  readonly human_principal: string;
  readonly body_ref: string;
  readonly command_id: string;
  readonly fingerprint: string;
  readonly state: string;
  readonly claimed_by_execution_id: string | null;
  readonly created_at: string;
  readonly settled_at: string | null;
}

const toRecord = (row: HumanMessageRow): HumanMessageRecord => ({
  messageId: row.message_id,
  projectId: row.project_id as ProjectId,
  rootWorkspaceId: row.root_workspace_id as WorkspaceId,
  humanPrincipal: row.human_principal as Principal,
  bodyRef: row.body_ref,
  commandId: row.command_id as HumanMessageRecord["commandId"],
  fingerprint: row.fingerprint,
  state: row.state as HumanMessageRecord["state"],
  claimedByExecutionId: row.claimed_by_execution_id,
  createdAt: row.created_at,
  settledAt: row.settled_at,
});

const SELECT_COLUMNS =
  "message_id, project_id, root_workspace_id, human_principal, body_ref, command_id, fingerprint, state, claimed_by_execution_id, created_at, settled_at";

export const HumanMessageStoreLive: Layer.Layer<
  HumanMessageStore,
  never,
  SqlClient
> = Layer.effect(
  HumanMessageStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const service: HumanMessageStoreService = {
      insertPending: (record) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const existing = yield* sql
            .unsafe<HumanMessageRow>(
              `SELECT ${SELECT_COLUMNS} FROM human_messages WHERE message_id = ?`,
              [record.messageId],
            )
            .pipe(Effect.mapError(toOperationalFailure));
          if (existing.length > 0) {
            return yield* Effect.fail({
              _tag: "HumanMessageConflict",
              existing: toRecord(existing[0] as HumanMessageRow),
            } satisfies HumanMessageConflict);
          }
          yield* sql
            .unsafe(
              "INSERT INTO human_messages (message_id, project_id, root_workspace_id, human_principal, body_ref, command_id, fingerprint, state, claimed_by_execution_id, created_at, settled_at) VALUES (?,?,?,?,?,?,?,'Pending',NULL,?,NULL)",
              [
                record.messageId,
                record.projectId,
                record.rootWorkspaceId,
                record.humanPrincipal,
                record.bodyRef,
                record.commandId,
                record.fingerprint,
                record.createdAt,
              ],
            )
            .pipe(Effect.mapError(toOperationalFailure));
        }),
      findById: (messageId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* sql
            .unsafe<HumanMessageRow>(
              `SELECT ${SELECT_COLUMNS} FROM human_messages WHERE message_id = ?`,
              [messageId],
            )
            .pipe(Effect.mapError(toOperationalFailure));
          const row = rows[0];
          return row === undefined
            ? Option.none<HumanMessageRecord>()
            : Option.some(toRecord(row));
        }),
      pendingOrderedByCreated: (projectId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* sql
            .unsafe<HumanMessageRow>(
              `SELECT ${SELECT_COLUMNS} FROM human_messages WHERE project_id = ? AND state = 'Pending' ORDER BY created_at ASC, message_id ASC`,
              [projectId],
            )
            .pipe(Effect.mapError(toOperationalFailure));
          return rows.map(toRecord);
        }),
      claim: (messageId, claimedByExecutionId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const existing = yield* sql
            .unsafe<HumanMessageRow>(
              `SELECT ${SELECT_COLUMNS} FROM human_messages WHERE message_id = ?`,
              [messageId],
            )
            .pipe(Effect.mapError(toOperationalFailure));
          const row = existing[0];
          if (row === undefined) {
            return { _tag: "NotFound" as const };
          }
          if (row.state !== "Pending") {
            return { _tag: "AlreadyClaimed" as const };
          }
          // Single-statement CAS: only a still-Pending row flips.
          const updated = yield* sql
            .unsafe<{ message_id: string }>(
              "UPDATE human_messages SET state = 'Claimed', claimed_by_execution_id = ? WHERE message_id = ? AND state = 'Pending' RETURNING message_id",
              [claimedByExecutionId, messageId],
            )
            .pipe(Effect.mapError(toOperationalFailure));
          return updated.length > 0
            ? { _tag: "Claimed" as const }
            : { _tag: "AlreadyClaimed" as const };
        }),
      markAnswered: (messageId, settledAt) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* sql
            .unsafe(
              "UPDATE human_messages SET state = 'Answered', settled_at = ? WHERE message_id = ? AND state = 'Claimed'",
              [settledAt, messageId],
            )
            .pipe(Effect.mapError(toOperationalFailure));
        }),
      rollbackClaim: (messageId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* sql
            .unsafe(
              "UPDATE human_messages SET state = 'Pending', claimed_by_execution_id = NULL WHERE message_id = ? AND state = 'Claimed'",
              [messageId],
            )
            .pipe(Effect.mapError(toOperationalFailure));
        }),
    };
    return HumanMessageStore.of(service);
  }),
);

const toOperationalFailure = (cause: SqlError): HumanMessageStoreError => ({
  _tag: "HumanMessageStoreFailure",
  cause,
});
