import { Clock, IdGenerator } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ClockTest, IdGeneratorTest } from "../src/index.js";

describe("clock / id-generator adapters", () => {
  it("provides deterministic test layers", async () => {
    const now = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const clock = yield* Clock;
          return yield* clock.now();
        }),
        ClockTest("2026-09-20T00:00:00.000Z"),
      ),
    );
    expect(now).toBe("2026-09-20T00:00:00.000Z");

    const id = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const generator = yield* IdGenerator;
          return yield* generator.generate<string>("Event");
        }),
        IdGeneratorTest("evt_fixed"),
      ),
    );
    expect(id).toBe("evt_fixed");
  });
});
