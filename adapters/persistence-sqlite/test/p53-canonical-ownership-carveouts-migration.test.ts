import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createSchema51TestDatabase } from "../../../tests/support/schema44-database.js";
import {
  CURRENT_MIGRATIONS,
  CURRENT_SCHEMA_VERSION,
  layer,
  runMigrations,
} from "../src/index.js";
import { P53_CANONICAL_OWNERSHIP_CARVEOUTS_MIGRATION } from "../src/p53-canonical-ownership-carveouts-migration.js";

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

describe("schema 53 canonical ownership carve-outs", () => {
  it("adds neutral exclusions and exact activation provenance without inferring claims", async () => {
    const fixture = await createSchema51TestDatabase();
    try {
      expect(
        await run(
          fixture.databaseFilename,
          CURRENT_MIGRATIONS.filter(({ id }) => id >= 52 && id <= 53),
        ),
      ).toBe(2);
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(53);
      expect(CURRENT_MIGRATIONS.find(({ id }) => id === 53)).toEqual(
        P53_CANONICAL_OWNERSHIP_CARVEOUTS_MIGRATION,
      );
      const db = new DatabaseSync(fixture.databaseFilename, {
        readOnly: true,
      });
      try {
        expect(
          (db.prepare("PRAGMA user_version").get() as { user_version: number })
            .user_version,
        ).toBe(53);
        expect(
          db
            .prepare(
              `SELECT exclusions_json, delegating_workspace_id,
                      delegation_source_id, claim_revision
                 FROM resource_ownership`,
            )
            .all(),
        ).toEqual([]);
        expect(
          db
            .prepare(
              `SELECT parent_workspace_id, delegation_source_id,
                      delegation_json, expected_parent_workspace_revision,
                      expected_child_workspace_revision,
                      expected_parent_boundary_revision,
                      expected_parent_ownership_revision,
                      expected_child_ownership_revision
                 FROM workspace_resource_activation_intents`,
            )
            .all(),
        ).toEqual([]);
      } finally {
        db.close();
      }
      expect(
        await run(fixture.databaseFilename, [
          P53_CANONICAL_OWNERSHIP_CARVEOUTS_MIGRATION,
        ]),
      ).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });
});
