// Provider Runtime cancellation — moved verbatim from
// provider-runtime-phase1.integration.test.ts (B5 split).

import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import type { CanonicalProviderEvent } from "../../packages/ports/src/index.js";
import {
  client,
  deferred,
  initialize,
  makeHarness,
  nextProviderTurnId,
  providerTurnId,
  readAttempt,
  readTurn,
  runtimeEffect,
  waitForSignal,
} from "./support.js";

describe("Provider Runtime Phase 1 — real Runtime + controlled OpenAI Adapter", () => {
  it.each([
    ["before connection", "before-connect"],
    ["after response start", "after-response"],
    ["after TextDelta", "after-text"],
    ["during fragmented tool-call arguments", "fragmented-tool"],
  ] as const)(
    "cancellation %s aborts transport, persists Cancelled, and suppresses late events",
    async (_label, mode) => {
      const entered = deferred();
      let lateChunkAttempted = false;
      const controller = new AbortController();
      const harness = makeHarness(
        client({
          externalEffectPossible: mode === "before-connect",
          stream: async function* ({ context }) {
            if (mode !== "before-connect") {
              yield { type: "response_started" };
            }
            if (mode === "after-text") {
              yield { type: "text", text: "visible-to-provider-runtime" };
            }
            if (mode === "fragmented-tool") {
              yield {
                type: "tool_call_delta",
                callRef: "fragment-call",
                toolName: "read",
                argumentsDelta: '{"path":',
              };
            }
            entered.resolve();
            await waitForSignal(context.cancellationSignal as AbortSignal);
            lateChunkAttempted = true;
            if (mode === "fragmented-tool") {
              yield { type: "tool_call_complete", callRef: "fragment-call" };
            } else {
              yield { type: "text", text: "late-after-cancel" };
            }
          },
        }),
      );
      try {
        await initialize(harness);
        const fiber = Effect.runFork(
          Effect.provide(
            runtimeEffect(controller.signal),
            harness.app,
          ) as never,
        );
        await entered.promise;
        controller.abort();
        const exit = await Effect.runPromise(Fiber.await(fiber));
        expect(Exit.isFailure(exit)).toBe(true);
        const attempt = readAttempt(harness.databaseFile);
        expect(attempt?.outcome).toBe("Cancelled");
        expect(readTurn(harness.databaseFile)).toMatchObject({
          finish_reason: "Cancelled",
        });
        expect(attempt?.observation_json).toContain(
          '"externalEffectPossible":',
        );
        expect(attempt?.canonical_event_prefix_json).not.toContain(
          "late-after-cancel",
        );
        expect(attempt?.canonical_event_prefix_json).not.toContain(
          "ToolCallProposed",
        );
        expect(lateChunkAttempted).toBe(true);
      } finally {
        controller.abort();
        rmSync(harness.root, { recursive: true, force: true });
      }
    },
  );

  it("a cancelled Turn's late Adapter event cannot contaminate the next ProviderTurn", async () => {
    const firstPartial = deferred();
    let calls = 0;
    let lateChunkAttempted = false;
    const clientWithLateTurn = client({
      stream: async function* ({ context }) {
        calls += 1;
        if (context.providerTurnId === providerTurnId) {
          yield { type: "response_started" };
          yield { type: "text", text: "old-turn-prefix" };
          firstPartial.resolve();
          await waitForSignal(context.cancellationSignal as AbortSignal);
          lateChunkAttempted = true;
          yield { type: "text", text: "late-old-turn-event" };
          return;
        }
        yield { type: "response_started" };
        yield { type: "text", text: "next-turn-only" };
        yield { type: "completed", finishReason: "stop" };
      },
    });
    const harness = makeHarness(clientWithLateTurn);
    const controller = new AbortController();
    try {
      await initialize(harness);
      const firstFiber = Effect.runFork(
        Effect.provide(
          runtimeEffect(controller.signal, undefined, providerTurnId),
          harness.app,
        ) as never,
      );
      await firstPartial.promise;
      controller.abort();
      const firstExit = await Effect.runPromise(Fiber.await(firstFiber));
      expect(Exit.isFailure(firstExit)).toBe(true);
      expect(lateChunkAttempted).toBe(true);

      const next = await harness.run(
        runtimeEffect(undefined, undefined, nextProviderTurnId),
      );
      expect(
        next.events
          .filter(
            (
              event,
            ): event is Extract<
              CanonicalProviderEvent,
              { readonly _tag: "TextDelta" }
            > => event._tag === "TextDelta",
          )
          .map((event) => event.text),
      ).toEqual(["next-turn-only"]);
      const db = new DatabaseSync(harness.databaseFile);
      try {
        const first = db
          .prepare(
            "SELECT outcome, canonical_event_prefix_json FROM provider_attempts WHERE provider_turn_id = ? AND attempt_no = 0",
          )
          .get(providerTurnId) as
          | { outcome: string; canonical_event_prefix_json: string }
          | undefined;
        const second = db
          .prepare(
            "SELECT outcome, canonical_event_prefix_json FROM provider_attempts WHERE provider_turn_id = ? AND attempt_no = 0",
          )
          .get(nextProviderTurnId) as
          | { outcome: string; canonical_event_prefix_json: string }
          | undefined;
        expect(first?.outcome).toBe("Cancelled");
        expect(first?.canonical_event_prefix_json).not.toContain(
          "late-old-turn-event",
        );
        expect(second?.outcome).toBe("Success");
        expect(second?.canonical_event_prefix_json).toContain("next-turn-only");
        expect(second?.canonical_event_prefix_json).not.toContain(
          "old-turn-prefix",
        );
      } finally {
        db.close();
      }
      expect(calls).toBe(2);
    } finally {
      controller.abort();
      rmSync(harness.root, { recursive: true, force: true });
    }
  });
});
