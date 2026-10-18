import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  createSchema44TestDatabase,
  createSchema46TestDatabase,
} from "../../../tests/support/schema44-database.js";
import {
  CURRENT_MIGRATIONS,
  layer,
  P45_RETRY_VERIFICATION_ORIGIN_MIGRATION,
  P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION,
  P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION,
  runMigrations,
} from "../src/index.js";

const run = (
  filename: string,
  migrations: Parameters<typeof runMigrations>[0] = [
    P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION,
  ],
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        runMigrations(migrations, { allowOfflineOnly: true }),
        layer({ filename }),
      ),
    ),
  );

const columns = (db: DatabaseSync, table: string) =>
  (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((row) => row.name);

describe("P47 AH14 legacy-adoption evidence Attention migration", () => {
  it("registers exact 0047 predecessor and supports both disposable upgrade prefixes", async () => {
    expect(P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION).toMatchObject({
      id: 47,
      name: "ah14_legacy_adoption_evidence_attention",
      requiresUserVersion: 46,
      offlineOnly: true,
    });
    expect(CURRENT_MIGRATIONS.map(({ id }) => id).slice(-4)).toEqual([
      45, 46, 47, 48,
    ]);

    const from46 = await createSchema46TestDatabase();
    const from44 = await createSchema44TestDatabase();
    try {
      expect(await run(from46.databaseFilename)).toBe(1);
      expect(await run(from46.databaseFilename)).toBe(0);
      expect(
        await run(from44.databaseFilename, [
          P45_RETRY_VERIFICATION_ORIGIN_MIGRATION,
          P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION,
          P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION,
        ]),
      ).toBe(3);
      for (const filename of [
        from46.databaseFilename,
        from44.databaseFilename,
      ]) {
        const db = new DatabaseSync(filename, { readOnly: true });
        try {
          expect(
            (
              db.prepare("PRAGMA user_version").get() as {
                user_version: number;
              }
            ).user_version,
          ).toBe(47);
          expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally {
          db.close();
        }
      }
    } finally {
      from46.cleanup();
      from44.cleanup();
    }
  });

  it("creates permanent immutable P9 facts and the exact rebuildable P10 marker", async () => {
    const fixture = await createSchema46TestDatabase();
    try {
      await run(fixture.databaseFilename);
      const db = new DatabaseSync(fixture.databaseFilename, { readOnly: true });
      try {
        expect(columns(db, "legacy_adoption_attention_facts")).toEqual([
          "attention_fact_id",
          "event_id",
          "project_id",
          "execution_id",
          "workspace_id",
          "provider_turn_id",
          "logical_step_no",
          "repair_attempt",
          "failure_code",
          "evidence_sha256",
          "first_detected_at",
        ]);
        expect(
          columns(db, "legacy_adoption_attention_resolution_facts"),
        ).toEqual([
          "resolution_fact_id",
          "attention_fact_id",
          "event_id",
          "project_id",
          "execution_id",
          "workspace_id",
          "provider_turn_id",
          "original_evidence_sha256",
          "resolution_evidence_sha256",
          "action_disposition_summary_json",
          "action_disposition_summary_sha256",
          "resolution_code",
          "resolved_at",
        ]);
        expect(columns(db, "legacy_adoption_attention_rows")).toEqual([
          "project_id",
          "attention_fact_id",
          "workspace_id",
        ]);
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'legacy_adoption_attention_%_immutable_%' ORDER BY name",
            )
            .all(),
        ).toHaveLength(4);
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'legacy_adoption_attention_%'",
            )
            .all(),
        ).toHaveLength(3);
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM legacy_adoption_attention_facts",
            )
            .get(),
        ).toEqual({ count: 0 });
        expect(
          db
            .prepare("PRAGMA foreign_key_list(legacy_adoption_attention_rows)")
            .all(),
        ).toHaveLength(3);
      } finally {
        db.close();
      }
    } finally {
      fixture.cleanup();
    }
  });
});
