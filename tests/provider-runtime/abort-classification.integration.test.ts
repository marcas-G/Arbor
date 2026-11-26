// Provider Runtime fetch abort classification — moved verbatim from
// provider-runtime-phase1.integration.test.ts (B5 split).
import { rmSync } from "node:fs";
import { Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import type { OpenAISdkClient } from "../../adapters/provider-openai/src/index.js";
import type { ProviderRuntimeExecutionPolicy } from "../../packages/ports/src/index.js";
import {
  type HttpProviderRuntime,
  makeHttpProviderClient,
} from "../capability/real-provider/http-sdk-client.js";
import {
  deferred,
  initialize,
  makeHarness,
  readAttempt,
  readTurn,
  request,
  runtimeEffect,
} from "./support.js";

describe("Provider Runtime Phase 1 — real Runtime + controlled OpenAI Adapter", () => {
  it("classifies fetch AbortError as Cancelled when the caller signal aborts", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const fetchStarted = deferred();
    globalThis.fetch = async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      fetchStarted.resolve();
      return await new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () =>
          reject(
            Object.assign(new Error("fetch aborted"), { name: "AbortError" }),
          );
        if (signal.aborted) {
          rejectAbort();
        } else {
          signal.addEventListener("abort", rejectAbort, { once: true });
        }
      });
    };
    const runtime: HttpProviderRuntime = {
      endpoint: "http://127.0.0.1:18080/v1",
      model: request.modelRef,
      serverBuildId: "controlled-fetch-abort",
      authMode: "none",
      modelRevision: "fixture",
      serverProps: {},
      temperature: 0,
      reasoningSettings: "none",
      contextWindow: 8_192,
      outputCeiling: 2_048,
    };
    const harness = makeHarness(
      makeHttpProviderClient({ runtime, captures: [] }),
    );
    try {
      await initialize(harness);
      const fiber = Effect.runFork(
        Effect.provide(runtimeEffect(controller.signal), harness.app) as never,
      );
      await fetchStarted.promise;
      controller.abort();
      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(readAttempt(harness.databaseFile)).toMatchObject({
        outcome: "Cancelled",
        provider_error_kind: "Cancelled",
      });
      expect(readTurn(harness.databaseFile)?.finish_reason).toBe("Cancelled");
    } finally {
      controller.abort();
      globalThis.fetch = originalFetch;
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("classifies fetch AbortError from the staged timeout as TimedOut, not TransportFailed", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () =>
          reject(
            Object.assign(new Error("fetch aborted"), { name: "AbortError" }),
          );
        if (signal.aborted) {
          rejectAbort();
        } else {
          signal.addEventListener("abort", rejectAbort, { once: true });
        }
      });
    };
    const runtime: HttpProviderRuntime = {
      endpoint: "http://127.0.0.1:18080/v1",
      model: request.modelRef,
      serverBuildId: "controlled-fetch-timeout",
      authMode: "none",
      modelRevision: "fixture",
      serverProps: {},
      temperature: 0,
      reasoningSettings: "none",
      contextWindow: 8_192,
      outputCeiling: 2_048,
    };
    const policy = {
      connectTimeoutMs: 35,
      firstEventTimeoutMs: 300,
      streamIdleTimeoutMs: 300,
      turnTimeoutMs: 500,
      maxAttempts: 2,
      retryBackoffMs: 0,
    } satisfies ProviderRuntimeExecutionPolicy;
    const harness = makeHarness(
      makeHttpProviderClient({ runtime, captures: [] }),
      policy,
    );
    try {
      await initialize(harness);
      const failure = (await harness.run(
        Effect.flip(runtimeEffect(undefined, policy)) as never,
      )) as { readonly _tag: string; readonly phase?: string };
      expect(failure).toMatchObject({
        _tag: "ProviderExecutionTimeout",
        phase: "ConnectTimeout",
      });
      expect(readAttempt(harness.databaseFile)).toMatchObject({
        outcome: "TimedOut",
        provider_error_kind: null,
      });
      expect(readAttempt(harness.databaseFile, 1)).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("cancels an in-flight fetch reader after TextDelta and rejects late SSE data", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const textDelivered = deferred();
    let readerCancelled = false;
    let fetchSignal: AbortSignal | undefined;
    globalThis.fetch = async (_input, init) => {
      fetchSignal = init?.signal as AbortSignal | undefined;
      let sent = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(bodyController) {
            fetchSignal?.addEventListener(
              "abort",
              () =>
                bodyController.enqueue(
                  new TextEncoder().encode(
                    'data: {"choices":[{"delta":{"content":"late"}}]}\n\n',
                  ),
                ),
              { once: true },
            );
          },
          pull(bodyController) {
            if (sent) return;
            sent = true;
            bodyController.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"first chunk"}}]}\n\n',
              ),
            );
          },
          cancel() {
            readerCancelled = true;
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const runtime: HttpProviderRuntime = {
      endpoint: "http://127.0.0.1:18080/v1",
      model: request.modelRef,
      serverBuildId: "controlled-cancel",
      authMode: "none",
      modelRevision: "fixture",
      serverProps: {},
      temperature: 0,
      reasoningSettings: "none",
      contextWindow: 8_192,
      outputCeiling: 2_048,
    };
    const base = makeHttpProviderClient({ runtime, captures: [] });
    const sdk: OpenAISdkClient = {
      externalEffectPossible: false,
      streamChat: async function* (input) {
        for await (const chunk of base.streamChat(input)) {
          yield chunk;
          if (chunk.type === "text") textDelivered.resolve();
        }
      },
    };
    const harness = makeHarness(sdk);
    try {
      await initialize(harness);
      const fiber = Effect.runFork(
        Effect.provide(runtimeEffect(controller.signal), harness.app) as never,
      );
      await textDelivered.promise;
      controller.abort();
      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(fetchSignal?.aborted).toBe(true);
      expect(readerCancelled).toBe(true);
      const attempt = readAttempt(harness.databaseFile);
      expect(attempt?.outcome).toBe("Cancelled");
      expect(attempt?.canonical_event_prefix_json).toContain("first chunk");
      expect(attempt?.canonical_event_prefix_json).not.toContain("late");
    } finally {
      controller.abort();
      globalThis.fetch = originalFetch;
      rmSync(harness.root, { recursive: true, force: true });
    }
  });
});
