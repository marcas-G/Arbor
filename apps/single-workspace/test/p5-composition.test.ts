import { CommandGateway } from "@arbor/application";
import { ExecutionScheduler, RunnableWorkSource } from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { createSchema42TestDatabase } from "../../../tests/support/schema42-database.js";
import { buildSingleWorkspaceLayer } from "../src/index.js";

describe("P5 composition root", () => {
  it("builds the full slice layer over a prestarted schema-42 DB", async () => {
    const fixture = await createSchema42TestDatabase({
      prefix: ".p5-composition-",
    });
    try {
      const result = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
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
          buildSingleWorkspaceLayer({
            databaseFile: fixture.databaseFilename,
          }),
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
        version: 42,
        attentionTable: "attention_projection_rows",
      });
    } finally {
      fixture.cleanup();
    }
  });
});
