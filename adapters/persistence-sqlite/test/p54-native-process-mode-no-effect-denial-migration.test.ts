import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createSchema51TestDatabase } from "../../../tests/support/schema44-database.js";
import {
  CURRENT_MIGRATIONS,
  CURRENT_SCHEMA_VERSION,
  layer,
  P54_NATIVE_PROCESS_MODE_NO_EFFECT_DENIAL_MIGRATION,
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

const readGuard = (filename: string, name: string): string => {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
      .get(name) as { readonly sql: string } | undefined;
    if (row === undefined) throw new Error(`missing trigger ${name}`);
    return row.sql;
  } finally {
    db.close();
  }
};

describe("P54 Native process-mode no-effect Denied migration", () => {
  it("changes only the current P40 Denied allowlists after schema 53", async () => {
    const fixture = await createSchema51TestDatabase();
    try {
      const priorMigrations = CURRENT_MIGRATIONS.filter(
        ({ id }) => id === 52 || id === 53,
      );
      expect(await run(fixture.databaseFilename, priorMigrations)).toBe(2);
      const insertBefore = readGuard(
        fixture.databaseFilename,
        "tool_invocations_observation_insert_guard",
      );
      const updateBefore = readGuard(
        fixture.databaseFilename,
        "tool_invocations_observation_update_guard",
      );
      const oldCodes =
        "'ResourceResolutionDenied','ResourceAdmissionDenied','ApprovalNoLongerAuthorized'";
      const newCodes =
        "'ResourceResolutionDenied','ResourceAdmissionDenied','ApprovalNoLongerAuthorized','ProcessExecutionDisabled','NativeOsTupleUnavailable'";
      expect(insertBefore.split(oldCodes)).toHaveLength(2);
      expect(updateBefore.split(oldCodes)).toHaveLength(2);

      expect(
        await run(fixture.databaseFilename, [
          P54_NATIVE_PROCESS_MODE_NO_EFFECT_DENIAL_MIGRATION,
        ]),
      ).toBe(1);
      expect(CURRENT_SCHEMA_VERSION).toBe(54);
      expect(CURRENT_MIGRATIONS.at(-1)?.id).toBe(54);
      const db = new DatabaseSync(fixture.databaseFilename, { readOnly: true });
      try {
        expect(
          (db.prepare("PRAGMA user_version").get() as { user_version: number })
            .user_version,
        ).toBe(54);
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM tool_invocations").get(),
        ).toEqual({ count: 0 });
      } finally {
        db.close();
      }
      expect(
        readGuard(
          fixture.databaseFilename,
          "tool_invocations_observation_insert_guard",
        ),
      ).toBe(insertBefore.replaceAll(oldCodes, newCodes));
      expect(
        readGuard(
          fixture.databaseFilename,
          "tool_invocations_observation_update_guard",
        ),
      ).toBe(updateBefore.replaceAll(oldCodes, newCodes));
      expect(
        await run(fixture.databaseFilename, [
          P54_NATIVE_PROCESS_MODE_NO_EFFECT_DENIAL_MIGRATION,
        ]),
      ).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });
});
