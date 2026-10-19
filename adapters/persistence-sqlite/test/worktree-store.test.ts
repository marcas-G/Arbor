import {
  TransactionPort as TransactionPortTag,
  WorktreeStore as WorktreeStoreTag,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer } from "../src/client.js";
import { TransactionPortLive } from "../src/transaction.js";
import { WorktreeStoreLive } from "../src/worktree-store.js";

const workspaceId = "ws_worktree-store-test" as never;

const createWorktrees = `CREATE TABLE worktrees (
  worktree_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  repository_ref TEXT,
  branch TEXT,
  state TEXT NOT NULL CHECK (state IN ('Active','Retired')),
  created_at TEXT NOT NULL,
  retired_at TEXT,
  CHECK ((state = 'Active') = (retired_at IS NULL))
)`;

const appLayer = () => {
  const base = layer({ filename: ":memory:" });
  return Layer.mergeAll(
    base,
    Layer.provide(TransactionPortLive, base),
    Layer.provide(WorktreeStoreLive, base),
  );
};

describe("SQLite P11 WorktreeStore", () => {
  it("reads exact active and retired managed bindings by Workspace", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql.unsafe(createWorktrees);
          yield* sql.unsafe(
            `INSERT INTO worktrees VALUES
              ('wt_active', 'prj_one', ?, '/repo/active', 'repo:one', 'main', 'Active', '2026-10-01T00:00:00.000Z', NULL),
              ('wt_retired', 'prj_one', ?, '/repo/old', NULL, NULL, 'Retired', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
              ('wt_other', 'prj_other', 'ws_other', '/repo/other', NULL, NULL, 'Active', '2026-10-01T00:00:00.000Z', NULL)`,
            [workspaceId, workspaceId],
          );
          const transaction = yield* TransactionPortTag;
          const store = yield* WorktreeStoreTag;
          const records = yield* transaction.transact(
            store.findByWorkspace(workspaceId),
          );
          expect(records).toEqual([
            {
              worktreeId: "wt_retired",
              projectId: "prj_one",
              workspaceId,
              address: { _tag: "GitWorktree", path: "/repo/old" },
              state: "Retired",
              createdAt: "2026-09-01T00:00:00.000Z",
              retiredAt: "2026-10-01T00:00:00.000Z",
            },
            {
              worktreeId: "wt_active",
              projectId: "prj_one",
              workspaceId,
              address: {
                _tag: "GitWorktree",
                path: "/repo/active",
                repositoryRef: "repo:one",
                branch: "main",
              },
              state: "Active",
              createdAt: "2026-10-01T00:00:00.000Z",
            },
          ]);
          const byId = yield* transaction.transact(store.findById("wt_active"));
          expect(Option.getOrNull(byId)?.worktreeId).toBe("wt_active");
        }),
        appLayer(),
      ),
    );
  });

  it("keeps missing, multiple, and retired rows distinguishable for fail-closed selection", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql.unsafe(createWorktrees);
          yield* sql.unsafe(
            `INSERT INTO worktrees VALUES
              ('wt_a', 'prj_one', ?, '/repo/a', NULL, NULL, 'Active', '2026-10-01T00:00:00.000Z', NULL),
              ('wt_b', 'prj_one', ?, '/repo/b', NULL, NULL, 'Active', '2026-10-02T00:00:00.000Z', NULL),
              ('wt_old', 'prj_none', 'ws_none', '/repo/old', NULL, NULL, 'Retired', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
            [workspaceId, workspaceId],
          );
          const transaction = yield* TransactionPortTag;
          const store = yield* WorktreeStoreTag;
          const duplicate = yield* transaction.transact(
            store.findByWorkspace(workspaceId),
          );
          expect(
            duplicate.filter((record) => record.state === "Active"),
          ).toHaveLength(2);
          expect(
            yield* transaction.transact(
              store.findByWorkspace("ws_none" as never),
            ),
          ).toMatchObject([{ state: "Retired" }]);
          expect(
            yield* transaction.transact(
              store.findByWorkspace("ws_missing" as never),
            ),
          ).toEqual([]);
        }),
        appLayer(),
      ),
    );
  });

  it("fails closed on malformed persisted worktree state", async () => {
    const base = layer({ filename: ":memory:" });
    const app = Layer.mergeAll(
      base,
      Layer.provide(TransactionPortLive, base),
      Layer.provide(WorktreeStoreLive, base),
    );
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql.unsafe(
            createWorktrees.replace(
              ",\n  CHECK ((state = 'Active') = (retired_at IS NULL))",
              "",
            ),
          );
          yield* sql.unsafe(
            "INSERT INTO worktrees VALUES ('wt_bad', 'prj_one', ?, '/repo/a', NULL, NULL, 'Active', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z')",
            [workspaceId],
          );
          const transaction = yield* TransactionPortTag;
          const store = yield* WorktreeStoreTag;
          const outcome = yield* Effect.match(
            transaction.transact(store.findByWorkspace(workspaceId)),
            {
              onFailure: (error) => ({ _tag: "Left" as const, error }),
              onSuccess: (value) => ({ _tag: "Right" as const, value }),
            },
          );
          if (outcome._tag === "Left") {
            expect(outcome.error).toMatchObject({
              _tag: "PersistenceCorruption",
              repository: "WorktreeStore",
              operation: "find-by-workspace",
            });
          } else {
            throw new Error("malformed worktree row unexpectedly decoded");
          }
        }),
        app,
      ),
    );
  });
});
