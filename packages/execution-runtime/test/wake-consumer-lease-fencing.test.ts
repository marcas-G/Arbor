import type { ExecutionId, LeaseFencingRejected } from "@arbor/ports";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import {
  containFencingRejection,
  containLeaseFencingRejected,
} from "../src/wake-consumer.js";

describe("containFencingRejection", () => {
  it.effect("ends the wake successfully when ownership was lost", () =>
    Effect.gen(function* () {
      const lost: LeaseFencingRejected = {
        _tag: "LeaseFencingRejected",
        executionId: "exe_00000000-0000-7000-8000-000000000000" as ExecutionId,
        generation: 0 as LeaseFencingRejected["generation"],
      };

      expect(yield* containFencingRejection(Effect.fail(lost))).toBeUndefined();
    }),
  );

  it.effect(
    "contains the terminal settlement rejection after a stale lease",
    () =>
      Effect.gen(function* () {
        expect(
          yield* containFencingRejection(
            Effect.fail({ _tag: "FencingRejected" as const }),
          ),
        ).toBeUndefined();
      }),
  );

  it.effect("preserves unrelated failures", () =>
    Effect.gen(function* () {
      const failure = { _tag: "OtherFailure", reason: "not ownership loss" };

      expect(
        yield* Effect.flip(containFencingRejection(Effect.fail(failure))),
      ).toMatchObject(failure);
    }),
  );

  it.effect("keeps the legacy helper equivalent", () =>
    Effect.gen(function* () {
      const lost: LeaseFencingRejected = {
        _tag: "LeaseFencingRejected",
        executionId: "exe_00000000-0000-7000-8000-000000000000" as ExecutionId,
        generation: 0 as LeaseFencingRejected["generation"],
      };

      expect(
        yield* containLeaseFencingRejected(Effect.fail(lost)),
      ).toBeUndefined();
    }),
  );
});
