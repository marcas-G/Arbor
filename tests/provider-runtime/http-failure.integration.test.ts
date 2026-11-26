// Provider Runtime HTTP failure mapping — moved verbatim from
// provider-runtime-phase1.integration.test.ts (B5 split).

import { rmSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type {
  ProviderFailure,
  ProviderRuntimeExecutionPolicy,
} from "../../packages/ports/src/index.js";
import {
  type HttpProviderRuntime,
  makeHttpProviderClient,
} from "../capability/real-provider/http-sdk-client.js";
import {
  initialize,
  makeHarness,
  readAttempt,
  request,
  runtimeEffect,
  SEMANTIC_TEST_POLICY,
} from "./support.js";

describe("Provider Runtime Phase 1 — real Runtime + controlled OpenAI Adapter", () => {
  it("records provider response start before mapping an HTTP failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: { code: "rate_limit_exceeded" },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json" },
        },
      );

    const runtime: HttpProviderRuntime = {
      endpoint: "http://127.0.0.1:18080/v1",
      model: request.modelRef,
      serverBuildId: "controlled-http-error",
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
      const failure = (await harness.run(
        Effect.flip(runtimeEffect()) as never,
      )) as ProviderFailure;
      expect(failure).toMatchObject({
        _tag: "ProviderFailure",
        kind: "RateLimited",
      });
      expect(
        JSON.parse(readAttempt(harness.databaseFile)?.observation_json ?? "{}"),
      ).toMatchObject({
        responseStarted: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("does not replay a remote HTTP request whose transport failed before a response", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw Object.assign(new Error("socket reset"), {
        code: "ECONNRESET",
      });
    };
    const runtime: HttpProviderRuntime = {
      endpoint: "http://provider.invalid/v1",
      model: request.modelRef,
      serverBuildId: "controlled-remote-transport-failure",
      authMode: "none",
      modelRevision: "fixture",
      serverProps: {},
      temperature: 0,
      reasoningSettings: "none",
      contextWindow: 8_192,
      outputCeiling: 2_048,
    };
    const sdk = makeHttpProviderClient({ runtime, captures: [] });
    expect(sdk.externalEffectPossible).toBe(true);
    const policy = {
      ...SEMANTIC_TEST_POLICY,
      maxAttempts: 3,
      retryBackoffMs: 0,
    } satisfies ProviderRuntimeExecutionPolicy;
    const harness = makeHarness(sdk, policy);
    try {
      await initialize(harness);
      const failure = (await harness.run(
        Effect.flip(runtimeEffect(undefined, policy)) as never,
      )) as ProviderFailure;
      expect(failure).toMatchObject({
        _tag: "ProviderFailure",
        kind: "TransportFailed",
      });
      expect(calls).toBe(1);
      expect(readAttempt(harness.databaseFile)).toMatchObject({
        outcome: "TerminalFailure",
        provider_error_kind: "TransportFailed",
        retry_safety: "UnsafeReplay",
        retry_decision: "Stop",
      });
      expect(
        JSON.parse(readAttempt(harness.databaseFile)?.observation_json ?? "{}"),
      ).toMatchObject({
        responseStarted: false,
        externalEffectPossible: true,
      });
      expect(readAttempt(harness.databaseFile, 1)).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("rejects an SSE EOF without a provider finish reason instead of inventing Stop", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const runtime: HttpProviderRuntime = {
      endpoint: "http://127.0.0.1:18080/v1",
      model: request.modelRef,
      serverBuildId: "controlled-truncated-sse",
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
      const failure = (await harness.run(
        Effect.flip(runtimeEffect()) as never,
      )) as ProviderFailure;
      expect(failure).toMatchObject({
        _tag: "ProviderFailure",
        kind: "ProtocolViolation",
      });
      const attempt = readAttempt(harness.databaseFile);
      expect(attempt?.outcome).toBe("TerminalFailure");
      expect(attempt?.provider_error_kind).toBe("ProtocolViolation");
      expect(attempt?.canonical_event_prefix_json).toContain("partial");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("rejects an unknown provider finish reason as ProtocolViolation", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"future_reason"}]}',
          "data: [DONE]",
          "",
          "",
        ].join("\n\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );

    const runtime: HttpProviderRuntime = {
      endpoint: "http://127.0.0.1:18080/v1",
      model: request.modelRef,
      serverBuildId: "controlled-unknown-finish-reason",
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
      const failure = (await harness.run(
        Effect.flip(runtimeEffect()) as never,
      )) as ProviderFailure;
      expect(failure).toMatchObject({
        _tag: "ProviderFailure",
        kind: "ProtocolViolation",
      });
      expect(readAttempt(harness.databaseFile)).toMatchObject({
        outcome: "TerminalFailure",
        provider_error_kind: "ProtocolViolation",
      });
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(harness.root, { recursive: true, force: true });
    }
  });
});
