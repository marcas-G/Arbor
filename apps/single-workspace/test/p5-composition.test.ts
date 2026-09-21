import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandGateway } from "@arbor/application";
import { ExecutionScheduler, RunnableWorkSource } from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { buildSliceLayer, P7_MIGRATIONS, runMigrations } from "../src/index.js";

const makeApp = () => {
  const dir = mkdtempSync(join(tmpdir(), "p5-comp-"));
  return buildSliceLayer({ databaseFile: join(dir, "slice.db") });
};

describe("P5 composition root", () => {
  it("builds the full slice layer and migrates a durable DB", async () => {
    const app = makeApp();
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P7_MIGRATIONS);
          const sql = yield* SqlClient;
          const version = yield* sql.unsafe<{ user_version: number }>(
            "PRAGMA user_version",
          );
          yield* CommandGateway;
          yield* ExecutionScheduler;
          yield* RunnableWorkSource;
          return Number(version[0]?.user_version);
        }),
        app,
      ) as Effect.Effect<number, unknown, never>,
    );
    expect(result).toBe(7);
  });
});
