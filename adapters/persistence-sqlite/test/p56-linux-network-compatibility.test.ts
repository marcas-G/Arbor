import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  logicalSqliteDigest,
  sqliteSchemaSignature,
} from "../../../apps/single-workspace/src/schema-upgrade-manifest.js";
import { createSchema42TestDatabase } from "../../../tests/support/schema44-database.js";
import {
  CURRENT_MIGRATIONS,
  layer,
  P56_LINUX_WORKSPACE_NETWORK_V2_MIGRATION,
  runMigrations,
} from "../src/index.js";

const run = (
  filename: string,
  migrations: Parameters<typeof runMigrations>[0],
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        runMigrations(migrations, { allowOfflineOnly: true }),
        layer({ filename }),
      ),
    ),
  );

const rows = (filename: string) => {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    return tables.map(({ name }) => ({
      name,
      rows: db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
    }));
  } finally {
    db.close();
  }
};

const schemaObjects = (filename: string) => {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      )
      .all();
  } finally {
    db.close();
  }
};

describe("Linux V2 storage compatibility boundary", () => {
  it("advances 55 to 56 without rewriting any historical row or receipt and remains idempotent", async () => {
    const fixture = await createSchema42TestDatabase({
      targetSchemaVersion: 55,
    });
    try {
      const db = new DatabaseSync(fixture.databaseFilename);
      try {
        // These are opaque historical storage bytes, not a qualification of
        // any model-facing receipt codec or replay handler.
        db.prepare(
          `INSERT INTO commands (command_id,project_id,semantic_request_fingerprint,schema_version,fingerprint_algorithm_version,resolution,result_json,terminal_error_json,created_at,settled_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          "cmd_legacy_v1",
          "prj_legacy",
          "fingerprint",
          "1",
          1,
          "Committed",
          '{ "version": 1, "snapshot": "retain original bytes" }',
          null,
          "t1",
          "t1",
        );
        db.prepare(
          `INSERT INTO commands (command_id,project_id,semantic_request_fingerprint,schema_version,fingerprint_algorithm_version,resolution,result_json,terminal_error_json,created_at,settled_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          "cmd_legacy_denied",
          "prj_legacy",
          "denied-fingerprint",
          "1",
          1,
          "TerminalRejected",
          null,
          '{"code":"Denied","version":1}',
          "t2",
          "t2",
        );
      } finally {
        db.close();
      }
      const before = rows(fixture.databaseFilename);
      const schemaBefore = schemaObjects(fixture.databaseFilename);
      const signature = sqliteSchemaSignature(fixture.databaseFilename);
      const digest55 = logicalSqliteDigest(fixture.databaseFilename);
      expect(
        await run(fixture.databaseFilename, [
          P56_LINUX_WORKSPACE_NETWORK_V2_MIGRATION,
        ]),
      ).toBe(1);
      expect(rows(fixture.databaseFilename)).toEqual(before);
      expect(schemaObjects(fixture.databaseFilename)).toEqual(schemaBefore);
      expect(sqliteSchemaSignature(fixture.databaseFilename)).not.toBe(
        signature,
      );
      expect(sqliteSchemaSignature(fixture.databaseFilename)).toBe(
        "f521381fabc4d48242dde9135e9174099cbf136163d278855f9e18ddd2f0fbe7",
      );
      const digest56 = logicalSqliteDigest(fixture.databaseFilename);
      expect(digest56).not.toBe(digest55);
      expect(
        await run(fixture.databaseFilename, [
          P56_LINUX_WORKSPACE_NETWORK_V2_MIGRATION,
        ]),
      ).toBe(0);
      expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(digest56);
      await expect(
        run(
          fixture.databaseFilename,
          CURRENT_MIGRATIONS.filter(({ id }) => id <= 55),
        ),
      ).rejects.toMatchObject({
        message: "database user_version 56 is newer than latest migration 55",
      });
      expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(digest56);
    } finally {
      fixture.cleanup();
    }
  }, 120_000);

  it("requires the exact 55 predecessor instead of skipping historical migrations", async () => {
    const fixture = await createSchema42TestDatabase({
      targetSchemaVersion: 54,
    });
    try {
      const before = logicalSqliteDigest(fixture.databaseFilename);
      await expect(
        run(fixture.databaseFilename, [
          P56_LINUX_WORKSPACE_NETWORK_V2_MIGRATION,
        ]),
      ).rejects.toMatchObject({
        message: "migration 56 requires database user_version 55, found 54",
      });
      expect(logicalSqliteDigest(fixture.databaseFilename)).toBe(before);
    } finally {
      fixture.cleanup();
    }
  }, 120_000);
});
