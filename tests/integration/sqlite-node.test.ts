import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { SqlitePort } from "../../src/application/ports.js";
import { SqliteNodeLive } from "../../src/infrastructure/sqlite-node.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-sql-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("SqliteNodeLive", () => {
  it("opens, auto-migrates, records version, idempotent on reopen", async () => {
    const dbFile = join(tmp(), "runtime.db");
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlitePort;
        const db = yield* sql.open(dbFile);
        const v = yield* db.queryOne("SELECT version FROM schema_migrations WHERE version = 1");
        expect(v).toMatchObject({ version: 1 });
        yield* db.close();

        const db2 = yield* sql.open(dbFile);
        yield* db2.execute(
          "INSERT INTO projects (project_id, source_repo_path, runtime_dir, created_at) VALUES (?, ?, ?, ?)",
          "pid",
          "/repo",
          "/rt",
          "2026-09-14T00:00:00Z",
        );
        const row = yield* db2.queryOne("SELECT project_id FROM projects WHERE project_id = ?", "pid");
        expect(row).toMatchObject({ project_id: "pid" });
        yield* db2.close();
      }).pipe(Effect.provide(SqliteNodeLive)),
    );
  });

  it("UNIQUE (project_id, kind) blocks a second root workspace", async () => {
    const dbFile = join(tmp(), "runtime.db");
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlitePort;
        const db = yield* sql.open(dbFile);
        yield* db.execute(
          "INSERT INTO projects (project_id, source_repo_path, runtime_dir, created_at) VALUES (?, ?, ?, ?)",
          "p1",
          "/r",
          "/d",
          "2026-09-14T00:00:00Z",
        );
        const ins = (ws: string) =>
          db.execute(
            "INSERT INTO workspaces (workspace_id, project_id, store_rel_path, kind, created_at) VALUES (?, ?, ?, ?, ?)",
            ws,
            "p1",
            `workspaces/${ws}`,
            "root",
            "2026-09-14T00:00:00Z",
          );
        yield* ins("w1");
        const exit = yield* Effect.either(ins("w2"));
        expect(exit._tag).toBe("Left");
        yield* db.close();
      }).pipe(Effect.provide(SqliteNodeLive)),
    );
  });
});
