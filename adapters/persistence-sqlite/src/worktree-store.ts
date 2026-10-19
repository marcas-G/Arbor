import type { ProjectId, WorkspaceId } from "@arbor/domain";
import type {
  WorktreeRecord,
  WorktreeState,
  WorktreeStoreError,
} from "@arbor/ports";
import { TransactionScope, WorktreeStore } from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

interface WorktreeRow {
  readonly worktree_id: string;
  readonly project_id: string;
  readonly workspace_id: string;
  readonly path: string;
  readonly repository_ref: string | null;
  readonly branch: string | null;
  readonly state: string;
  readonly created_at: string;
  readonly retired_at: string | null;
}

const corruption = (operation: string, reason: string): WorktreeStoreError => ({
  _tag: "PersistenceCorruption",
  repository: "WorktreeStore",
  operation,
  reason,
});

const decodeRow = (row: WorktreeRow): WorktreeRecord | undefined => {
  if (
    typeof row.worktree_id !== "string" ||
    row.worktree_id.length === 0 ||
    typeof row.project_id !== "string" ||
    typeof row.workspace_id !== "string" ||
    typeof row.path !== "string" ||
    (row.repository_ref !== null && typeof row.repository_ref !== "string") ||
    (row.branch !== null && typeof row.branch !== "string") ||
    (row.state !== "Active" && row.state !== "Retired") ||
    typeof row.created_at !== "string" ||
    (row.retired_at !== null && typeof row.retired_at !== "string") ||
    (row.state === "Active" && row.retired_at !== null) ||
    (row.state === "Retired" && row.retired_at === null)
  )
    return undefined;
  const address = {
    _tag: "GitWorktree" as const,
    path: row.path,
    ...(row.repository_ref === null
      ? {}
      : { repositoryRef: row.repository_ref }),
    ...(row.branch === null ? {} : { branch: row.branch }),
  };
  return {
    worktreeId: row.worktree_id,
    projectId: row.project_id as ProjectId,
    workspaceId: row.workspace_id as WorkspaceId,
    address,
    state: row.state as WorktreeState,
    createdAt: row.created_at,
    ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
  };
};

const columns = `worktree_id, project_id, workspace_id, path,
  repository_ref, branch, state, created_at, retired_at`;

/** SQLite implementation for the existing P11/09 `worktrees` table. The
 * sandbox preparation consumer only receives the `findByWorkspace` read
 * capability; no migration or alternate path-based primary inference exists. */
export const WorktreeStoreLive: Layer.Layer<WorktreeStore, never, SqlClient> =
  Layer.effect(
    WorktreeStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const failure = repositoryFailure("WorktreeStore", "sql");
      const run = <A>(effect: Effect.Effect<A, SqlError>) =>
        effect.pipe(Effect.mapError(failure));

      const decodeRows = (
        rows: ReadonlyArray<WorktreeRow>,
        operation: string,
      ): Effect.Effect<ReadonlyArray<WorktreeRecord>, WorktreeStoreError> => {
        const decoded: WorktreeRecord[] = [];
        for (const row of rows) {
          const record = decodeRow(row);
          if (record === undefined)
            return Effect.fail(
              corruption(operation, "stored P11 worktree row is malformed"),
            );
          decoded.push(record);
        }
        return Effect.succeed(decoded);
      };

      return WorktreeStore.of({
        insert: (record) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const retiredAt = record.retiredAt ?? null;
            if (
              record.worktreeId.length === 0 ||
              record.address._tag !== "GitWorktree" ||
              (record.state === "Active" && retiredAt !== null) ||
              (record.state === "Retired" && retiredAt === null)
            )
              return yield* Effect.fail(
                corruption("insert", "worktree input is malformed"),
              );
            yield* run(
              sql.unsafe(
                `INSERT INTO worktrees (
                  worktree_id, project_id, workspace_id, path,
                  repository_ref, branch, state, created_at, retired_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  record.worktreeId,
                  record.projectId,
                  record.workspaceId,
                  record.address.path,
                  record.address.repositoryRef ?? null,
                  record.address.branch ?? null,
                  record.state,
                  record.createdAt,
                  retiredAt,
                ],
              ),
            );
          }),

        findById: (worktreeId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* run(
              sql.unsafe<WorktreeRow>(
                `SELECT ${columns} FROM worktrees WHERE worktree_id = ?`,
                [worktreeId],
              ),
            );
            const decoded = yield* decodeRows(rows, "find-by-id");
            return decoded[0] === undefined
              ? Option.none()
              : Option.some(decoded[0]);
          }),

        findByWorkspace: (workspaceId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* run(
              sql.unsafe<WorktreeRow>(
                `SELECT ${columns} FROM worktrees
                 WHERE workspace_id = ?
                 ORDER BY created_at, worktree_id`,
                [workspaceId],
              ),
            );
            return yield* decodeRows(rows, "find-by-workspace");
          }),

        retireIfActive: (worktreeId, retiredAt) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* run(
              sql.unsafe<WorktreeRow>(
                `UPDATE worktrees
                 SET state = 'Retired', retired_at = ?
                 WHERE worktree_id = ? AND state = 'Active' AND retired_at IS NULL
                 RETURNING ${columns}`,
                [retiredAt, worktreeId],
              ),
            );
            const decoded = yield* decodeRows(rows, "retire-if-active");
            return decoded[0] === undefined
              ? Option.none()
              : Option.some(decoded[0]);
          }),
      });
    }),
  );
