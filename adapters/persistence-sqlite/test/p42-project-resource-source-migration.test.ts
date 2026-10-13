import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  CURRENT_MIGRATIONS,
  layer,
  P42_PROJECT_RESOURCE_SOURCE_MIGRATION,
  runMigrations,
} from "../src/index.js";

describe("FT-DG-01 ProjectResourceSource migration descriptor", () => {
  it("pins migration 0042 as the final descriptor after the 0039–0041 prefix", () => {
    expect(P42_PROJECT_RESOURCE_SOURCE_MIGRATION).toMatchObject({
      id: 42,
      name: "project_resource_source_attribution",
      requiresUserVersion: 41,
    });
    expect(CURRENT_MIGRATIONS.at(-1)?.id).toBe(42);
    expect(CURRENT_MIGRATIONS.map(({ id }) => id).slice(-3)).toEqual([
      40, 41, 42,
    ]);
    expect(CURRENT_MIGRATIONS.some(({ id }) => id === 39)).toBe(false);
  });

  it("backfills only LegacyUnknown and preserves all prior Project columns", async () => {
    const services = layer({ filename: ":memory:" });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql.unsafe(`
            CREATE TABLE projects (
              project_id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              resource_boundary_snapshot TEXT NOT NULL
            )
          `);
          yield* sql.unsafe(
            "INSERT INTO projects VALUES ('prj_a', 'A', 'boundary-a'), ('prj_b', 'B', 'boundary-b')",
          );
          yield* sql.unsafe("PRAGMA user_version = 41");
          const applied = yield* runMigrations([
            P42_PROJECT_RESOURCE_SOURCE_MIGRATION,
          ]);
          const replayed = yield* runMigrations([
            P42_PROJECT_RESOURCE_SOURCE_MIGRATION,
          ]);
          const rows = yield* sql.unsafe<{
            project_id: string;
            name: string;
            resource_boundary_snapshot: string;
            resource_source_json: string;
          }>(
            "SELECT project_id, name, resource_boundary_snapshot, resource_source_json FROM projects ORDER BY project_id",
          );
          const version = yield* sql.unsafe<{ user_version: number }>(
            "PRAGMA user_version",
          );
          return {
            rows,
            version: Number(version[0]?.user_version ?? 0),
            applied,
            replayed,
          };
        }),
        services,
      ),
    );
    expect(result.version).toBe(42);
    expect(result.applied).toBe(1);
    expect(result.replayed).toBe(0);
    expect(
      result.rows.map((row) => ({
        projectId: row.project_id,
        name: row.name,
        boundary: row.resource_boundary_snapshot,
        source: JSON.parse(row.resource_source_json),
      })),
    ).toEqual([
      {
        projectId: "prj_a",
        name: "A",
        boundary: "boundary-a",
        source: { _tag: "LegacyUnknown" },
      },
      {
        projectId: "prj_b",
        name: "B",
        boundary: "boundary-b",
        source: { _tag: "LegacyUnknown" },
      },
    ]);
  });

  it.each([38, 39, 40])(
    "refuses to skip the 0039–0041 prefix from user_version %i",
    async (userVersion) => {
      const services = layer({ filename: ":memory:" });
      const error = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            yield* sql.unsafe(
              "CREATE TABLE projects (project_id TEXT PRIMARY KEY)",
            );
            yield* sql.unsafe(`PRAGMA user_version = ${userVersion}`);
            return yield* Effect.flip(
              runMigrations([P42_PROJECT_RESOURCE_SOURCE_MIGRATION]),
            );
          }),
          services,
        ),
      );
      expect(error).toMatchObject({
        _tag: "SqliteAdapterError",
        message: expect.stringContaining("requires database user_version 41"),
      });
    },
  );
});
