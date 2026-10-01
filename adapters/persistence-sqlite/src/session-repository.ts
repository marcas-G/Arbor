import type {
  ContextEpochNumber,
  ExecutionId,
  Session,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  type LeaseFencingRejected,
  type SessionEntryKind,
  type SessionEpochConflict,
  type SessionItemRecord,
  type SessionItemWrite,
  SessionRepository,
  type SessionRepositoryError,
  type SessionSourceConflict,
  type SessionWriteFence,
  sessionEntryKindOf,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

// --- Session ----------------------------------------------------------------

interface SessionRow {
  readonly session_id: string;
  readonly binding_kind: "WorkspacePrimary" | "ExecutionScoped";
  readonly workspace_id: string | null;
  readonly execution_id: string | null;
  readonly context_epoch: number;
}

interface SessionEntryRow {
  readonly session_id: string;
  readonly sequence: number;
  readonly entry_kind: SessionEntryKind;
  readonly payload_json: string;
  readonly created_at: string;
  readonly source_kind: string | null;
  readonly source_ref: string | null;
  readonly content_hash: string | null;
  readonly item_type?: string | null;
  readonly schema_version?: number | null;
  readonly context_epoch?: number | null;
}

interface TypedSessionItemRow extends SessionEntryRow {
  readonly item_type: SessionItemRecord["itemType"];
  readonly schema_version: 2;
  readonly context_epoch: number;
}

const toSessionEntry = (row: SessionEntryRow) => ({
  sessionId: row.session_id as SessionId,
  sequence: Number(row.sequence),
  entryKind: row.entry_kind,
  payload: JSON.parse(row.payload_json) as unknown,
  createdAt: row.created_at,
  ...(row.source_kind !== null &&
  row.source_ref !== null &&
  row.content_hash !== null
    ? {
        source: {
          kind: row.source_kind,
          ref: row.source_ref,
          contentHash: row.content_hash,
        },
      }
    : {}),
});

const toSessionItemRecord = (row: TypedSessionItemRow): SessionItemRecord => ({
  sessionId: row.session_id as SessionId,
  sequence: Number(row.sequence),
  itemType: row.item_type,
  schemaVersion: 2,
  contextEpoch: Number(row.context_epoch) as ContextEpochNumber,
  item: JSON.parse(row.payload_json) as SessionItemRecord["item"],
  createdAt: row.created_at,
  source: {
    kind: row.source_kind as string,
    ref: row.source_ref as string,
  },
  contentHash: row.content_hash as string,
});

const toSession = (row: SessionRow): Session => ({
  sessionId: row.session_id as SessionId,
  binding:
    row.binding_kind === "WorkspacePrimary"
      ? {
          _tag: "WorkspacePrimary",
          workspaceId: row.workspace_id as WorkspaceId,
        }
      : {
          _tag: "ExecutionScoped",
          executionId: row.execution_id as ExecutionId,
        },
  contextEpoch: Number(row.context_epoch) as ContextEpochNumber,
  entries: [],
  checkpoints: [],
  providerContinuation: { state: null },
  modelContinuation: null,
});

export const SessionRepositoryLive: Layer.Layer<
  SessionRepository,
  never,
  SqlClient | Clock
> = Layer.effect(
  SessionRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const clock = yield* Clock;
    const failure = (cause: unknown): SessionRepositoryError => ({
      _tag: "SessionRepositoryFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    const hasTimelineColumns = Effect.gen(function* () {
      const columns = yield* run(
        sql.unsafe<{ name: string }>("PRAGMA table_info(session_entries)"),
      );
      return columns.some((column) => column.name === "item_type");
    });
    const checkFence = (fence: SessionWriteFence) =>
      Effect.gen(function* () {
        const fenceNow = yield* clock.now();
        const rows = yield* run(
          sql.unsafe<{ ok: number }>(
            "SELECT 1 AS ok FROM executions e JOIN execution_leases l ON l.execution_id = e.execution_id WHERE e.execution_id = ? AND l.worker_id = ? AND l.worker_incarnation_id = ? AND l.generation = ? AND l.expires_at > ? AND e.settled_at IS NULL",
            [
              fence.executionId,
              fence.workerId,
              fence.workerIncarnationId,
              fence.fencingGeneration,
              fenceNow,
            ],
          ),
        );
        if (rows.length === 0) {
          return yield* Effect.fail<LeaseFencingRejected>({
            _tag: "LeaseFencingRejected",
            executionId: fence.executionId,
            generation: fence.fencingGeneration,
          });
        }
      });
    const appendTyped = (
      sessionId: SessionId,
      write: SessionItemWrite,
      fence: SessionWriteFence,
    ) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        yield* checkFence(fence);
        if (!(yield* hasTimelineColumns)) {
          return yield* Effect.fail<SessionRepositoryError>(
            failure(
              new Error("typed Session Timeline requires migration 0019"),
            ),
          );
        }
        const existing = yield* run(
          sql.unsafe<{ sequence: number; content_hash: string }>(
            "SELECT sequence, content_hash FROM session_entries WHERE session_id = ? AND item_type = ? AND source_kind = ? AND source_ref = ?",
            [sessionId, write.item._tag, write.source.kind, write.source.ref],
          ),
        );
        const prior = existing[0];
        if (prior !== undefined) {
          if (prior.content_hash !== write.contentHash) {
            return yield* Effect.fail<SessionSourceConflict>({
              _tag: "SessionSourceConflict",
              sessionId,
              entryKind: write.item._tag,
              sourceKind: write.source.kind,
              sourceRef: write.source.ref,
            });
          }
          return { sequence: Number(prior.sequence), inserted: false };
        }
        const epochRows = yield* run(
          sql.unsafe<{ context_epoch: number }>(
            "SELECT context_epoch FROM sessions WHERE session_id = ?",
            [sessionId],
          ),
        );
        const currentEpoch = Number(epochRows[0]?.context_epoch ?? -1);
        if (currentEpoch !== Number(write.contextEpoch)) {
          return yield* Effect.fail<SessionEpochConflict>({
            _tag: "SessionEpochConflict",
            sessionId,
            expectedEpoch: Number(write.contextEpoch),
            currentEpoch,
          });
        }
        const now = yield* clock.now();
        const rows = yield* run(
          sql.unsafe<{ sequence: number }>(
            "INSERT INTO session_entries (session_id, sequence, entry_kind, item_type, schema_version, context_epoch, payload_json, created_at, source_kind, source_ref, content_hash) VALUES (?, COALESCE((SELECT MAX(sequence) + 1 FROM session_entries WHERE session_id = ?), 0), ?, ?, 2, ?, ?, ?, ?, ?, ?) RETURNING sequence",
            [
              sessionId,
              sessionId,
              sessionEntryKindOf(write.item),
              write.item._tag,
              write.contextEpoch,
              JSON.stringify(write.item),
              now,
              write.source.kind,
              write.source.ref,
              write.contentHash,
            ],
          ),
        );
        return {
          sequence: Number(rows[0]?.sequence ?? 0),
          inserted: true,
        };
      });
    return SessionRepository.of({
      supportsTypedTimeline: () =>
        Effect.gen(function* () {
          yield* TransactionScope;
          return yield* hasTimelineColumns;
        }),
      findById: (sessionId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<SessionRow>(
              "SELECT * FROM sessions WHERE session_id = ?",
              [sessionId],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some(toSession(row));
        }),
      create: (session) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          yield* run(
            sql.unsafe(
              "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,?,?,?)",
              [
                session.sessionId,
                session.binding._tag,
                session.binding._tag === "WorkspacePrimary"
                  ? session.binding.workspaceId
                  : null,
                session.binding._tag === "ExecutionScoped"
                  ? session.binding.executionId
                  : null,
                session.contextEpoch,
                now,
              ],
            ),
          );
        }),
      appendEntry: (sessionId, entry, fence) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          if (fence !== undefined) {
            const fenceNow = yield* clock.now();
            const identity =
              fence.workerId !== undefined &&
              fence.workerIncarnationId !== undefined
                ? {
                    clause:
                      " AND l.worker_id = ? AND l.worker_incarnation_id = ?",
                    params: [fence.workerId, fence.workerIncarnationId],
                  }
                : fence.workerId !== undefined
                  ? { clause: " AND l.worker_id = ?", params: [fence.workerId] }
                  : { clause: "", params: [] };
            const fenceRows = yield* run(
              sql.unsafe<{ ok: number }>(
                `SELECT 1 AS ok FROM executions e JOIN execution_leases l ON l.execution_id = e.execution_id WHERE e.execution_id = ?${identity.clause} AND l.generation = ? AND l.expires_at > ? AND e.settled_at IS NULL`,
                [
                  fence.executionId,
                  ...identity.params,
                  fence.fencingGeneration,
                  fenceNow,
                ],
              ),
            );
            if (fenceRows.length === 0) {
              return yield* Effect.fail<LeaseFencingRejected>({
                _tag: "LeaseFencingRejected",
                executionId: fence.executionId,
                generation: fence.fencingGeneration,
              });
            }
          }
          const now = yield* clock.now();
          const timeline = yield* hasTimelineColumns;
          const rows = yield* run(
            timeline
              ? sql.unsafe<{ sequence: number }>(
                  "INSERT INTO session_entries (session_id, sequence, entry_kind, item_type, schema_version, context_epoch, payload_json, created_at) VALUES (?, COALESCE((SELECT MAX(sequence) + 1 FROM session_entries WHERE session_id = ?), 0), ?, ?, 1, NULL, ?, ?) RETURNING sequence",
                  [
                    sessionId,
                    sessionId,
                    entry.entryKind satisfies SessionEntryKind,
                    `Legacy${entry.entryKind}`,
                    JSON.stringify(entry.payload),
                    now,
                  ],
                )
              : sql.unsafe<{ sequence: number }>(
                  "INSERT INTO session_entries (session_id, sequence, entry_kind, payload_json, created_at) VALUES (?, COALESCE((SELECT MAX(sequence) + 1 FROM session_entries WHERE session_id = ?), 0), ?, ?, ?) RETURNING sequence",
                  [
                    sessionId,
                    sessionId,
                    entry.entryKind satisfies SessionEntryKind,
                    JSON.stringify(entry.payload),
                    now,
                  ],
                ),
          );
          return { sequence: Number(rows[0]?.sequence ?? 0) };
        }),
      appendEntryIdempotent: (sessionId, source, entry, contentHash, fence) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const fenceNow = yield* clock.now();
          const fenceRows = yield* run(
            sql.unsafe<{ ok: number }>(
              "SELECT 1 AS ok FROM executions e JOIN execution_leases l ON l.execution_id = e.execution_id WHERE e.execution_id = ? AND l.worker_id = ? AND l.worker_incarnation_id = ? AND l.generation = ? AND l.expires_at > ? AND e.settled_at IS NULL",
              [
                fence.executionId,
                fence.workerId,
                fence.workerIncarnationId,
                fence.fencingGeneration,
                fenceNow,
              ],
            ),
          );
          if (fenceRows.length === 0) {
            return yield* Effect.fail<LeaseFencingRejected>({
              _tag: "LeaseFencingRejected",
              executionId: fence.executionId,
              generation: fence.fencingGeneration,
            });
          }

          const timeline = yield* hasTimelineColumns;
          const existing = yield* run(
            sql.unsafe<{ sequence: number; content_hash: string }>(
              timeline
                ? "SELECT sequence, content_hash FROM session_entries WHERE session_id = ? AND item_type = ? AND source_kind = ? AND source_ref = ?"
                : "SELECT sequence, content_hash FROM session_entries WHERE session_id = ? AND entry_kind = ? AND source_kind = ? AND source_ref = ?",
              [
                sessionId,
                timeline ? `Legacy${entry.entryKind}` : entry.entryKind,
                source.kind,
                source.ref,
              ],
            ),
          );
          const prior = existing[0];
          if (prior !== undefined) {
            if (prior.content_hash !== contentHash) {
              return yield* Effect.fail<SessionSourceConflict>({
                _tag: "SessionSourceConflict",
                sessionId,
                entryKind: entry.entryKind,
                sourceKind: source.kind,
                sourceRef: source.ref,
              });
            }
            return { sequence: Number(prior.sequence), inserted: false };
          }

          const now = yield* clock.now();
          const rows = yield* run(
            timeline
              ? sql.unsafe<{ sequence: number }>(
                  "INSERT INTO session_entries (session_id, sequence, entry_kind, item_type, schema_version, context_epoch, payload_json, created_at, source_kind, source_ref, content_hash) VALUES (?, COALESCE((SELECT MAX(sequence) + 1 FROM session_entries WHERE session_id = ?), 0), ?, ?, 1, NULL, ?, ?, ?, ?, ?) RETURNING sequence",
                  [
                    sessionId,
                    sessionId,
                    entry.entryKind satisfies SessionEntryKind,
                    `Legacy${entry.entryKind}`,
                    JSON.stringify(entry.payload),
                    now,
                    source.kind,
                    source.ref,
                    contentHash,
                  ],
                )
              : sql.unsafe<{ sequence: number }>(
                  "INSERT INTO session_entries (session_id, sequence, entry_kind, payload_json, created_at, source_kind, source_ref, content_hash) VALUES (?, COALESCE((SELECT MAX(sequence) + 1 FROM session_entries WHERE session_id = ?), 0), ?, ?, ?, ?, ?, ?) RETURNING sequence",
                  [
                    sessionId,
                    sessionId,
                    entry.entryKind satisfies SessionEntryKind,
                    JSON.stringify(entry.payload),
                    now,
                    source.kind,
                    source.ref,
                    contentHash,
                  ],
                ),
          );
          return {
            sequence: Number(rows[0]?.sequence ?? 0),
            inserted: true,
          };
        }),
      appendItemIdempotent: (sessionId, write, fence) =>
        appendTyped(sessionId, write, fence),
      listActiveFrontier: (sessionId, contextEpoch, limit) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          if (!(yield* hasTimelineColumns)) return [];
          const rows = yield* run(
            sql.unsafe<TypedSessionItemRow>(
              "SELECT session_id, sequence, entry_kind, item_type, schema_version, context_epoch, payload_json, created_at, source_kind, source_ref, content_hash FROM session_entries WHERE session_id = ? AND schema_version = 2 AND context_epoch <= ? ORDER BY sequence DESC LIMIT ?",
              [sessionId, contextEpoch, limit],
            ),
          );
          return [...rows].reverse().map(toSessionItemRecord);
        }),
      commitCompaction: (sessionId, input, fence) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* checkFence(fence);
          if (!(yield* hasTimelineColumns)) {
            return yield* Effect.fail<SessionRepositoryError>(
              failure(
                new Error("typed Session Timeline requires migration 0019"),
              ),
            );
          }
          const existing = yield* run(
            sql.unsafe<{ sequence: number; content_hash: string }>(
              "SELECT sequence, content_hash FROM session_entries WHERE session_id = ? AND item_type = 'CompactionCheckpoint' AND source_kind = ? AND source_ref = ?",
              [sessionId, input.source.kind, input.source.ref],
            ),
          );
          const prior = existing[0];
          if (prior !== undefined) {
            if (prior.content_hash !== input.contentHash) {
              return yield* Effect.fail<SessionSourceConflict>({
                _tag: "SessionSourceConflict",
                sessionId,
                entryKind: "CompactionCheckpoint",
                sourceKind: input.source.kind,
                sourceRef: input.source.ref,
              });
            }
            return {
              sequence: Number(prior.sequence),
              inserted: false,
              newEpoch: input.nextEpoch,
            };
          }
          const epochRows = yield* run(
            sql.unsafe<{ context_epoch: number }>(
              "SELECT context_epoch FROM sessions WHERE session_id = ?",
              [sessionId],
            ),
          );
          const currentEpoch = Number(epochRows[0]?.context_epoch ?? -1);
          if (
            currentEpoch !== Number(input.expectedEpoch) ||
            Number(input.nextEpoch) !== Number(input.expectedEpoch) + 1 ||
            Number(input.checkpoint.fromEpoch) !==
              Number(input.expectedEpoch) ||
            Number(input.checkpoint.toEpoch) !== Number(input.nextEpoch)
          ) {
            return yield* Effect.fail<SessionEpochConflict>({
              _tag: "SessionEpochConflict",
              sessionId,
              expectedEpoch: Number(input.expectedEpoch),
              currentEpoch,
            });
          }
          const updated = yield* run(
            sql.unsafe<{ context_epoch: number }>(
              "UPDATE sessions SET context_epoch = ? WHERE session_id = ? AND context_epoch = ? RETURNING context_epoch",
              [input.nextEpoch, sessionId, input.expectedEpoch],
            ),
          );
          if (updated.length === 0) {
            return yield* Effect.fail<SessionEpochConflict>({
              _tag: "SessionEpochConflict",
              sessionId,
              expectedEpoch: Number(input.expectedEpoch),
              currentEpoch,
            });
          }
          const appended = yield* appendTyped(
            sessionId,
            {
              item: input.checkpoint,
              contextEpoch: input.nextEpoch,
              source: input.source,
              contentHash: input.contentHash,
            },
            fence,
          );
          return { ...appended, newEpoch: input.nextEpoch };
        }),
      listEntries: (sessionId, afterSequence, limit) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<SessionEntryRow>(
              "SELECT session_id, sequence, entry_kind, payload_json, created_at, source_kind, source_ref, content_hash FROM session_entries WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
              [sessionId, afterSequence, limit],
            ),
          );
          return rows.map(toSessionEntry);
        }),
      listRecentEntries: (sessionId, limit) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const columns = yield* run(
            sql.unsafe<{ name: string }>("PRAGMA table_info(session_entries)"),
          );
          const hasSources = columns.some(
            (column) => column.name === "source_kind",
          );
          const selection = hasSources
            ? "session_id, sequence, entry_kind, payload_json, created_at, source_kind, source_ref, content_hash"
            : "session_id, sequence, entry_kind, payload_json, created_at, NULL AS source_kind, NULL AS source_ref, NULL AS content_hash";
          const rows = yield* run(
            sql.unsafe<SessionEntryRow>(
              `SELECT ${selection} FROM session_entries WHERE session_id = ? ORDER BY sequence DESC LIMIT ?`,
              [sessionId, limit],
            ),
          );
          return [...rows].reverse().map(toSessionEntry);
        }),
      listSessionsByWorkspace: (workspaceId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ session_id: string }>(
              "SELECT session_id FROM sessions WHERE workspace_id = ? UNION SELECT s.session_id FROM sessions s JOIN executions e ON e.session_id = s.session_id WHERE e.workspace_id = ? ORDER BY session_id",
              [workspaceId, workspaceId],
            ),
          );
          return rows.map((row) => row.session_id as SessionId);
        }),
    });
  }),
);
