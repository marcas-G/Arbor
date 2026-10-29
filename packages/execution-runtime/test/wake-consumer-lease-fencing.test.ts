import type { ExecutionId, LeaseFencingRejected } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { containLeaseFencingRejected } from "../src/wake-consumer.js";

describe("containLeaseFencingRejected", () => {
  it("ends the wake successfully when ownership was lost", async () => {
    const lost: LeaseFencingRejected = {
      _tag: "LeaseFencingRejected",
      executionId: "exe_00000000-0000-7000-8000-000000000000" as ExecutionId,
      generation: 0 as LeaseFencingRejected["generation"],
    };

    await expect(
      Effect.runPromise(containLeaseFencingRejected(Effect.fail(lost))),
    ).resolves.toBeUndefined();
  });

  it("preserves unrelated failures", async () => {
    const failure = { _tag: "OtherFailure", reason: "not ownership loss" };

    await expect(
      Effect.runPromise(containLeaseFencingRejected(Effect.fail(failure))),
    ).rejects.toMatchObject(failure);
  });
});
