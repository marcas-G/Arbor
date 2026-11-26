import { Clock, IdGenerator } from "@arbor/ports";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { ClockTest, IdGeneratorTest } from "../src/index.js";

describe("clock / id-generator adapters", () => {
  it.effect("provides deterministic test layers", () =>
    Effect.gen(function* () {
      const clock = yield* Clock;
      const now = yield* clock.now();
      expect(now).toBe("2026-09-20T00:00:00.000Z");
    }).pipe(Effect.provide(ClockTest("2026-09-20T00:00:00.000Z"))),
  );

  it.effect("generates fixed ids from the scripted layer", () =>
    Effect.gen(function* () {
      const generator = yield* IdGenerator;
      const id = yield* generator.generate<string>("Event");
      expect(id).toBe("evt_fixed");
    }).pipe(Effect.provide(IdGeneratorTest("evt_fixed"))),
  );
});
