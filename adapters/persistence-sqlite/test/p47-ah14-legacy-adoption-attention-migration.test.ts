import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSchema44TestDatabaseFactory,
  type Schema44TestDatabase,
  type Schema44TestDatabaseFactory,
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

let schema44Factory: Schema44TestDatabaseFactory | undefined;

beforeAll(async () => {
  schema44Factory = await createSchema44TestDatabaseFactory({
    prefix: ".p47-ah14-migration-schema44-template-",
  });
}, 120_000);

const createSchema44Clone = (): Schema44TestDatabase => {
  if (schema44Factory === undefined)
    throw new Error("Schema-44 migration template is not ready.");
  return schema44Factory.create();
};

const createSchema46Clone = async (): Promise<Schema44TestDatabase> => {
  const fixture = createSchema44Clone();
  try {
    const applied = await run(fixture.databaseFilename, [
      P45_RETRY_VERIFICATION_ORIGIN_MIGRATION,
      P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION,
    ]);
    if (applied !== 2) {
      throw new Error(
        `Schema-46 clone applied ${applied} migrations; expected 2.`,
      );
    }
    return fixture;
  } catch (cause) {
    fixture.cleanup();
    throw cause;
  }
};

afterAll(() => {
  schema44Factory?.cleanup();
  schema44Factory = undefined;
}, 120_000);

describe("P47 AH14 legacy-adoption evidence Attention migration", () => {
  it("registers exact 0047 predecessor and supports both disposable upgrade prefixes", async () => {
    expect(P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION).toMatchObject({
      id: 47,
      name: "ah14_legacy_adoption_evidence_attention",
      requiresUserVersion: 46,
      offlineOnly: true,
    });
    expect(CURRENT_MIGRATIONS.map(({ id }) => id).slice(-7)).toEqual([
      48, 49, 50, 51, 52, 53, 54,
    ]);

    const from46 = await createSchema46Clone();
    const from44 = createSchema44Clone();
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
    const fixture = await createSchema46Clone();
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
