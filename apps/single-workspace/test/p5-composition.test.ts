import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandGateway } from "@arbor/application";
import { ExecutionScheduler, RunnableWorkSource } from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  buildSingleWorkspaceLayer,
  CURRENT_MIGRATIONS,
  runMigrations,
} from "../src/index.js";

const makeApp = () => {
  const dir = mkdtempSync(join(tmpdir(), "p5-comp-"));
  return buildSingleWorkspaceLayer({ databaseFile: join(dir, "slice.db") });
};

describe("P5 composition root", () => {
  it("builds the full slice layer and migrates a durable DB", async () => {
    const app = makeApp();
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(CURRENT_MIGRATIONS);
          const sql = yield* SqlClient;
          const version = yield* sql.unsafe<{ user_version: number }>(
            "PRAGMA user_version",
          );
          const attentionTable = yield* sql.unsafe<{ name: string }>(
            `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name = 'attention_projection_rows'`,
          );
          yield* CommandGateway;
          yield* ExecutionScheduler;
          yield* RunnableWorkSource;
          return {
            version: Number(version[0]?.user_version),
            attentionTable: attentionTable[0]?.name,
          };
        }),
        app,
      ) as Effect.Effect<
        {
          readonly version: number;
          readonly attentionTable: string | undefined;
        },
        unknown,
        never
      >,
    );
    expect(result).toEqual({
      version: 34,
      attentionTable: "attention_projection_rows",
    });
  });
});
