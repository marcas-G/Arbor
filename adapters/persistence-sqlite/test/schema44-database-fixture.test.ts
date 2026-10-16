import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSchema44TestDatabase } from "../../../tests/support/schema44-database.js";

describe("central schema-44 runtime test fixture", () => {
  it("creates the ordered P43/P44 current schema with guarded ApprovalRejected outcomes", async () => {
    const fixture = await createSchema44TestDatabase();
    const db = new DatabaseSync(fixture.databaseFilename, { readOnly: true });
    try {
      expect(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version,
      ).toBe(44);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='work_blockers'",
          )
          .all(),
      ).toHaveLength(1);
      const guards = db
        .prepare(
          `SELECT name,sql FROM sqlite_master WHERE type='trigger'
             AND name IN ('tool_invocations_observation_insert_guard',
                          'tool_invocations_observation_update_guard')
             ORDER BY name`,
        )
        .all() as Array<{ readonly name: string; readonly sql: string }>;
      expect(guards).toHaveLength(2);
      expect(guards.map(({ sql }) => sql)).toEqual([
        expect.stringContaining("ApprovalRejected"),
        expect.stringContaining("ApprovalRejected"),
      ]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
      fixture.cleanup();
    }
  }, 180_000);
});
