import { CommandGateway } from "@arbor/application";
import {
  ExecutionScheduler,
  RunnableWorkSource,
  SandboxProcessPort,
} from "@arbor/ports";
import { nativePosixProviderIds } from "@arbor/sandbox-native-posix";
import { WINDOWS_SANDBOX_PROVIDER_IDS } from "@arbor/sandbox-windows";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCurrentSchemaTestDatabaseFactory,
  type Schema44TestDatabaseFactory,
} from "../../../tests/support/schema44-database.js";
import { buildSingleWorkspaceLayer } from "../src/index.js";

let schema44Factory: Schema44TestDatabaseFactory | undefined;

beforeAll(async () => {
  schema44Factory = await createCurrentSchemaTestDatabaseFactory({
    prefix: ".p5-composition-template-",
  });
}, 120_000);

afterAll(() => schema44Factory?.cleanup());

describe("P5 composition root", () => {
  it("builds the full slice layer over a prestarted schema-50 DB", async () => {
    const fixture = schema44Factory?.create();
    if (fixture === undefined) {
      throw new Error("Schema-44 test database factory was not prepared.");
    }
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
            const sandboxProcess = yield* SandboxProcessPort;
            const sandboxProviders = yield* sandboxProcess.capabilities();
            return {
              version: Number(version[0]?.user_version),
              attentionTable: attentionTable[0]?.name,
              sandboxProviders,
            };
          }),
          buildSingleWorkspaceLayer({
            databaseFile: fixture.databaseFilename,
          }),
        ) as Effect.Effect<
          {
            readonly version: number;
            readonly attentionTable: string | undefined;
            readonly sandboxProviders: ReadonlyArray<{
              readonly providerId: string;
              readonly status: string;
              readonly profiles: ReadonlyArray<string>;
              readonly networkModes: ReadonlyArray<string>;
            }>;
          },
          unknown,
          never
        >,
      );
      expect(result).toEqual({
        version: 50,
        attentionTable: "attention_projection_rows",
        sandboxProviders: expect.any(Array),
      });
      expect(
        result.sandboxProviders.map((provider) => provider.providerId),
      ).toEqual([
        ...nativePosixProviderIds,
        ...Object.values(WINDOWS_SANDBOX_PROVIDER_IDS),
      ]);
      expect(
        result.sandboxProviders.every(
          (provider) =>
            provider.status === "Experimental" &&
            provider.profiles.length === 0 &&
            provider.networkModes.length === 0,
        ),
      ).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});
