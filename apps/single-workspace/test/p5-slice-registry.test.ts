import { CommandHandlerRegistry } from "@arbor/application";
import { Effect, Option } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSchema42TestDatabaseFactory } from "../../../tests/support/schema42-database.js";
import { buildSingleWorkspaceLayer } from "../src/index.js";

let schema42Factory: Awaited<
  ReturnType<typeof createSchema42TestDatabaseFactory>
>;

describe("P5 slice command handler registry", () => {
  beforeAll(async () => {
    schema42Factory = await createSchema42TestDatabaseFactory();
  }, 120_000);

  afterAll(() => schema42Factory?.cleanup(), 120_000);

  it("resolves the P1 + P2 command set", async () => {
    const database = schema42Factory.create();
    try {
      const app = buildSingleWorkspaceLayer({
        databaseFile: database.databaseFilename,
      });
      const present = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const registry = yield* CommandHandlerRegistry;
            return [
              "CreateProject",
              "CreateChildWorkspace",
              "AssignWork",
              "AdmitExecution",
              "StopExecution",
              "SettleExecution",
            ].map((commandType) => Option.isSome(registry.lookup(commandType)));
          }),
          app,
        ) as unknown as Effect.Effect<ReadonlyArray<boolean>, unknown, never>,
      );
      expect(present).toEqual([true, true, true, true, true, true]);
    } finally {
      database.cleanup();
    }
  }, 120_000);
});
