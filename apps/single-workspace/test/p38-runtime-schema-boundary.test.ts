import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import * as PersistenceSqlite from "../../../adapters/persistence-sqlite/src/index.js";
import { buildSingleWorkspaceLayer } from "../src/composition.js";
import { runDaemonOnce } from "../src/main.js";
import { ProductionDaemonService } from "../src/production.js";

const temporaryDirectories: string[] = [];

const databaseFile = () => {
  const directory = mkdtempSync(join(tmpdir(), "p38-schema-boundary-"));
  temporaryDirectories.push(directory);
  return join(directory, "slice.db");
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const runWithRawDatabase = <A>(
  filename: string,
  program: Effect.Effect<A, unknown, SqlClient>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(program, PersistenceSqlite.layer({ filename })),
    ),
  );

describe("P38 current-schema startup boundary", () => {
  it("starts a normal P38 daemon and migrates a new database to version 38", async () => {
    const filename = databaseFile();

    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          runDaemonOnce(),
          buildSingleWorkspaceLayer({ databaseFile: filename }),
        ),
      ),
    );

    const version = await runWithRawDatabase(
      filename,
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql.unsafe<{ user_version: number }>(
          "PRAGMA user_version",
        );
        return Number(rows[0]?.user_version ?? 0);
      }),
    );
    expect(version).toBe(38);
  });

  it("refuses schema 39 before exposing the production daemon services", async () => {
    const filename = databaseFile();
    await runWithRawDatabase(
      filename,
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql.unsafe("PRAGMA user_version = 39");
      }),
    );

    let failure: unknown;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              yield* ProductionDaemonService;
            }),
            buildSingleWorkspaceLayer({ databaseFile: filename }),
          ),
        ),
      );
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toMatchObject({
      _tag: "SqliteAdapterError",
      message: "database user_version 39 is newer than latest migration 38",
    });
  });

  it("exports only the P38 migration/runtime surface, with no P39 maintenance entry", () => {
    expect(PersistenceSqlite.P38_MIGRATIONS.at(-1)?.id).toBe(38);
    expect(
      Object.keys(PersistenceSqlite).filter((name) => /p39/i.test(name)),
    ).toEqual([]);
  });
});
