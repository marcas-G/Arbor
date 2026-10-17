import { join } from "node:path";
import { Duration, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import * as PersistenceSqlite from "../../../adapters/persistence-sqlite/src/index.js";
import { PersistenceHealthProbe } from "../../../packages/ports/src/health.js";
import {
  createP39PrivateTestFile,
  makeP39PrivateTestDirectory,
  removeP39PrivateTestDirectory,
} from "../../../tests/support/p39-windows-deployment-test.js";
import { createSchema45TestDatabase } from "../../../tests/support/schema44-database.js";
import { buildSingleWorkspaceLayer } from "../src/composition.js";
import {
  PersistenceHealthProbeSqliteLive,
  T1RecoveryStateLive,
} from "../src/health.js";
import { runDaemonOnce } from "../src/main.js";
import { ProductionDaemonService } from "../src/production.js";

let temporaryDirectory: string | undefined;
let databaseSequence = 0;

const databaseFile = () => {
  temporaryDirectory ??= makeP39PrivateTestDirectory(
    process.cwd(),
    ".schema-42-boundary-",
  );
  databaseSequence += 1;
  const filename = join(temporaryDirectory, `slice-${databaseSequence}.db`);
  createP39PrivateTestFile(filename);
  return filename;
};

afterAll(() => {
  if (temporaryDirectory !== undefined)
    removeP39PrivateTestDirectory(temporaryDirectory);
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

const seedVersion = (filename: string, version: number) =>
  runWithRawDatabase(
    filename,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`PRAGMA user_version = ${version}`);
    }),
  );

const readVersion = (filename: string) =>
  runWithRawDatabase(
    filename,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{ user_version: number }>(
        "PRAGMA user_version",
      );
      return Number(rows[0]?.user_version ?? 0);
    }),
  );

const readReadiness = (filename: string) => {
  const infrastructure = Layer.merge(
    PersistenceSqlite.layer({ filename }),
    T1RecoveryStateLive,
  );
  const services = Layer.provideMerge(
    PersistenceHealthProbeSqliteLive,
    infrastructure,
  );
  return Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.gen(function* () {
          const probe = yield* PersistenceHealthProbe;
          return yield* probe.probe();
        }),
        services,
      ),
    ),
  );
};

describe("schema 45 runtime startup boundary", () => {
  it.each([38, 39, 40, 41, 42, 43, 44])(
    "refuses schema %i during composition before exposing runtime services",
    async (version) => {
      const filename = databaseFile();
      await seedVersion(filename, version);

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

      expect(JSON.stringify(failure)).toContain(
        `database user_version ${version} requires an offline upgrade to schema 45`,
      );
      expect(await readVersion(filename)).toBe(version);
    },
    60_000,
  );

  it.each([38, 39, 40, 41, 42, 43, 44])(
    "refuses schema %i on the direct --once path before migration or Web bind",
    async (version) => {
      const filename = databaseFile();
      await seedVersion(filename, version);
      let webListening = false;

      let failure: unknown;
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.provide(
              Effect.timeout(Duration.seconds(20))(
                runDaemonOnce({
                  databaseFile: filename,
                  webTransport: { port: 0 },
                  onWebTransportListening: () => {
                    webListening = true;
                  },
                }),
              ),
              buildSingleWorkspaceLayer({ databaseFile: filename }),
            ),
          ),
        );
      } catch (cause) {
        failure = cause;
      }

      expect(JSON.stringify(failure)).toContain(
        `database user_version ${version} requires an offline upgrade to schema 45`,
      );
      expect(webListening).toBe(false);
      expect(await readVersion(filename)).toBe(version);
    },
    60_000,
  );

  it("admits exactly schema 45 and makes the production migration hook a no-op", async () => {
    const filename = databaseFile();
    await seedVersion(filename, 45);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* ProductionDaemonService;
            return yield* PersistenceSqlite.runMigrations(
              PersistenceSqlite.CURRENT_MIGRATIONS,
            );
          }),
          buildSingleWorkspaceLayer({ databaseFile: filename }),
        ),
      ),
    );

    expect(result).toBe(0);
    expect(await readVersion(filename)).toBe(45);
  });

  it("completes a real --once daemon startup and Web bind from the schema-45 fixture", async () => {
    const fixture = await createSchema45TestDatabase({
      prefix: ".schema-45-runtime-once-",
    });
    const startupDiagnosticProbe = (_phase: string) => {
      throw new Error("test-only startup observer failure");
    };
    let listeningPort: number | undefined;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.timeout(Duration.seconds(45))(
              runDaemonOnce({
                databaseFile: fixture.databaseFilename,
                webTransport: { host: "127.0.0.1", port: 0 },
                startupDiagnosticProbe,
                onWebTransportListening: (port) => {
                  listeningPort = port;
                },
              }),
            ),
            buildSingleWorkspaceLayer({
              databaseFile: fixture.databaseFilename,
              startupDiagnosticProbe,
            }),
          ),
        ),
      );
      expect(listeningPort).toBeGreaterThan(0);
      expect(await readVersion(fixture.databaseFilename)).toBe(45);
    } finally {
      fixture.cleanup();
    }
  }, 120_000);

  it("rejects schemas newer than the explicit runtime target", async () => {
    const filename = databaseFile();
    await seedVersion(filename, 46);

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

    expect(JSON.stringify(failure)).toContain(
      "database user_version 46 is newer than latest migration 45",
    );
    expect(await readVersion(filename)).toBe(46);
  });

  it("marks readiness only when user_version exactly matches schema 45", async () => {
    const filename = databaseFile();
    await seedVersion(filename, 41);
    expect(await readReadiness(filename)).toEqual({
      dbOpen: true,
      migrationBaseline: false,
      t1RecoveryComplete: false,
    });

    await seedVersion(filename, 45);
    expect(await readReadiness(filename)).toEqual({
      dbOpen: true,
      migrationBaseline: true,
      t1RecoveryComplete: false,
    });
  });

  it("keeps P39 maintenance outside the ordinary 40–45 schema suffix", () => {
    expect(PersistenceSqlite.CURRENT_SCHEMA_VERSION).toBe(45);
    expect(PersistenceSqlite.CURRENT_MIGRATION_BASELINE).toBe(45);
    expect(PersistenceSqlite.P38_MIGRATIONS.at(-1)?.id).toBe(38);
    expect(PersistenceSqlite.CURRENT_MIGRATIONS.map(({ id }) => id)).toEqual([
      ...PersistenceSqlite.P38_MIGRATIONS.map(({ id }) => id),
      40,
      41,
      42,
      43,
      44,
      45,
    ]);
    expect(
      PersistenceSqlite.CURRENT_MIGRATIONS.some(({ id }) => id === 39),
    ).toBe(false);
    expect(
      PersistenceSqlite.P39_MAINTENANCE_MIGRATIONS.map(({ id }) => id),
    ).toEqual([37, 38, 39]);
    expect(
      PersistenceSqlite.CURRENT_MIGRATIONS.find(({ id }) => id === 40)
        ?.requiresUserVersion,
    ).toBe(39);
    expect(
      PersistenceSqlite.CURRENT_MIGRATIONS.find(({ id }) => id === 41)
        ?.requiresUserVersion,
    ).toBe(40);
    expect(
      PersistenceSqlite.CURRENT_MIGRATIONS.find(({ id }) => id === 42)
        ?.requiresUserVersion,
    ).toBe(41);
    expect(
      PersistenceSqlite.CURRENT_MIGRATIONS.find(({ id }) => id === 43)
        ?.requiresUserVersion,
    ).toBe(42);
    expect(
      PersistenceSqlite.CURRENT_MIGRATIONS.find(({ id }) => id === 44)
        ?.requiresUserVersion,
    ).toBe(43);
    expect(
      PersistenceSqlite.CURRENT_MIGRATIONS.find(({ id }) => id === 45)
        ?.requiresUserVersion,
    ).toBe(44);
    expect(
      PersistenceSqlite.CURRENT_MIGRATIONS.find(({ id }) => id === 45)
        ?.offlineOnly,
    ).toBe(true);
  });
});
