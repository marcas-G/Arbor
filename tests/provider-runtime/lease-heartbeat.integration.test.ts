// Provider Runtime lease-heartbeat concurrency — moved verbatim from
// provider-runtime-phase1.integration.test.ts (B5 split).
import { rmSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  client,
  initialize,
  makeHarness,
  runtimeEffect,
  SEMANTIC_TEST_POLICY,
} from "./support.js";

describe("Provider Runtime Phase 1 — real Runtime + controlled OpenAI Adapter", () => {
  it("lets a concurrent lease heartbeat run while consuming a dense provider stream", async () => {
    const controlled = client({
      stream: async function* () {
        yield { type: "response_started" };
        for (let index = 0; index < 512; index += 1) {
          yield { type: "text", text: "x" };
        }
        yield { type: "completed", finishReason: "stop" };
      },
    });
    const harness = makeHarness(controlled, {
      ...SEMANTIC_TEST_POLICY,
      turnTimeoutMs: 10_000,
      firstEventTimeoutMs: 10_000,
      streamIdleTimeoutMs: 10_000,
    });
    try {
      await initialize(harness);
      const result = await harness.run(
        Effect.raceFirst(
          runtimeEffect().pipe(Effect.as("provider" as const)),
          Effect.sleep(5).pipe(Effect.as("heartbeat" as const)),
        ),
      );
      expect(result).toBe("heartbeat");
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });
});
