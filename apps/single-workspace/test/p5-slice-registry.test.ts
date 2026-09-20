import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandHandlerRegistry } from "@arbor/application";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { buildSliceLayer } from "../src/index.js";

describe("P5 slice command handler registry", () => {
  it("resolves the P1 + P2 command set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p5-reg-"));
    const app = buildSliceLayer({ databaseFile: join(dir, "slice.db") });
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
  });
});
