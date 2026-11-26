import { CommandHandlerRegistry } from "@arbor/application";
import { it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { createCurrentSchemaTestDatabaseFactory } from "../../../tests/support/schema44-database.js";
import { buildSingleWorkspaceLayer } from "../src/index.js";

let schema44Factory: Awaited<
  ReturnType<typeof createCurrentSchemaTestDatabaseFactory>
>;

describe("P5 slice command handler registry", () => {
  beforeAll(async () => {
    schema44Factory = await createCurrentSchemaTestDatabaseFactory();
  }, 120_000);

  afterAll(() => schema44Factory?.cleanup(), 120_000);

  it.effect(
    "resolves the P1 + P2 command set",
    () =>
      Effect.gen(function* () {
        const database = schema44Factory.create();
        try {
          const app = buildSingleWorkspaceLayer({
            databaseFile: database.databaseFilename,
          });
          const present = yield* Effect.provide(
            Effect.gen(function* () {
              const registry = yield* CommandHandlerRegistry;
              return [
                "CreateProject",
                "CreateChildWorkspace",
                "AssignWork",
                "AdmitExecution",
                "StopExecution",
                "SettleExecution",
              ].map((commandType) =>
                Option.isSome(registry.lookup(commandType)),
              );
            }),
            app,
          ) as unknown as Effect.Effect<ReadonlyArray<boolean>, unknown, never>;
          expect(present).toEqual([true, true, true, true, true, true]);
        } finally {
          database.cleanup();
        }
      }),
    120_000,
  );
});
