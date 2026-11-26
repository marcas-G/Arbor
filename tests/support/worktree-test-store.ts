import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { WorkspaceId } from "../../packages/domain/dist/index.js";
import {
  type ProjectId,
  type ResourceAddress,
  TransactionScope,
  type WorktreeRecord,
  WorktreeStore,
  type WorktreeStoreService,
} from "../../packages/ports/src/index.js";

// Shared test-local worktrees DDL + sqlite-backed WorktreeStore for the
// P11 ownership/wiring suites. The production `worktrees` migration is
// owned by the MAIN SESSION (serial migration management, planned
// migration 10); tests create the table manually after runMigrations.
export const WORKTREES_TEST_DDL = `
CREATE TABLE IF NOT EXISTS worktrees (
  worktree_id     TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(project_id),
  workspace_id    TEXT NOT NULL REFERENCES workspaces(workspace_id),
  path            TEXT NOT NULL,
  repository_ref  TEXT,
  branch          TEXT,
  state           TEXT NOT NULL CHECK (state IN ('Active','Retired')),
  created_at      TEXT NOT NULL,
  retired_at      TEXT,
  CHECK ((state = 'Active') = (retired_at IS NULL))
);
CREATE INDEX idx_worktrees_workspace ON worktrees(workspace_id);
`;

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

export const toWorktreeRecord = (row: WorktreeRow): WorktreeRecord => ({
  worktreeId: row.worktree_id,
  projectId: row.project_id as ProjectId,
  workspaceId: row.workspace_id as never,
  address: {
    _tag: "GitWorktree",
    path: row.path,
    ...(row.repository_ref === null
      ? {}
      : { repositoryRef: row.repository_ref }),
    ...(row.branch === null ? {} : { branch: row.branch }),
  },
  state: row.state as "Active" | "Retired",
  createdAt: row.created_at,
  ...(row.retired_at === null ? {} : { retiredAt: row.retired_at }),
});

export const WorktreeStoreTestLive: Layer.Layer<
  WorktreeStore,
  never,
  SqlClient
> = Layer.effect(
  WorktreeStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const selectById = (worktreeId: string) =>
      sql.unsafe<WorktreeRow>("SELECT * FROM worktrees WHERE worktree_id = ?", [
        worktreeId,
      ]);
    const service = {
      insert: (record: WorktreeRecord) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* sql.unsafe(
            "INSERT INTO worktrees (worktree_id, project_id, workspace_id, path, repository_ref, branch, state, created_at, retired_at) VALUES (?,?,?,?,?,?,?,?,NULL)",
            [
              record.worktreeId,
              record.projectId,
              record.workspaceId,
              record.address.path,
              record.address.repositoryRef ?? null,
              record.address.branch ?? null,
              record.state,
              record.createdAt,
            ],
          );
        }),
      findById: (worktreeId: string) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* selectById(worktreeId);
          return rows.length === 0
            ? Option.none()
            : Option.some(toWorktreeRecord(rows[0] as WorktreeRow));
        }),
      findByWorkspace: (workspaceId: WorkspaceId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* sql.unsafe<WorktreeRow>(
            "SELECT * FROM worktrees WHERE workspace_id = ? ORDER BY worktree_id",
            [workspaceId],
          );
          return rows.map(toWorktreeRecord);
        }),
      retireIfActive: (worktreeId: string, retiredAt: string) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* sql.unsafe(
            "UPDATE worktrees SET state = 'Retired', retired_at = ? WHERE worktree_id = ? AND state = 'Active'",
            [retiredAt, worktreeId],
          );
          const rows = yield* selectById(worktreeId);
          if (rows.length === 0) {
            return Option.none();
          }
          const row = rows[0] as WorktreeRow;
          return row.state === "Retired"
            ? Option.some(toWorktreeRecord(row))
            : Option.none();
        }),
    };
    return WorktreeStore.of(service as unknown as WorktreeStoreService);
  }),
);

/** Address -> canonical region projection used by scripted environment
 * doubles (P11-005: canonical region, never a raw ResourceAddress). */
export const regionOfAddress = (
  address: ResourceAddress,
): { resourceSpaceId: string; normalizedRegion: unknown } => {
  switch (address._tag) {
    case "FileTree":
      return {
        resourceSpaceId: "filesystem",
        normalizedRegion: { kind: "FileTree", path: address.path },
      };
    case "GitWorktree":
      return {
        resourceSpaceId: "filesystem",
        normalizedRegion: { kind: "GitWorktree", path: address.path },
      };
    case "DatabaseNamespace":
      return {
        resourceSpaceId: "database",
        normalizedRegion: {
          kind: "DatabaseNamespace",
          namespace: address.namespace,
        },
      };
    case "ExternalResource":
      return {
        resourceSpaceId: "external",
        normalizedRegion: {
          kind: "ExternalResource",
          address: address.address,
        },
      };
  }
};
