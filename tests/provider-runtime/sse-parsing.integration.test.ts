// Provider Runtime SSE parsing — moved verbatim from
// provider-runtime-phase1.integration.test.ts (B5 split).

import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type HttpProviderRuntime,
  makeHttpProviderClient,
} from "../capability/real-provider/http-sdk-client.js";
import { initialize, makeHarness, request, runtimeEffect } from "./support.js";

describe("Provider Runtime Phase 1 — real Runtime + controlled OpenAI Adapter", () => {
  it("parses arbitrary SSE byte chunking through the real Adapter and Runtime path", async () => {
    const originalFetch = globalThis.fetch;
    const sse = [
      'data: {"choices":[{"delta":{"content":"chunked hello"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read","arguments":"{\\"path\\":\\"."}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
      "data: [DONE]",
      "",
      "",
    ].join("\n\n");
    const bytes = new TextEncoder().encode(sse);
    let offset = 0;
    let chunkNo = 0;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= bytes.length) {
              controller.close();
              return;
            }
            // Split SSE field names, UTF-8 payloads, and frame separators at
            // deliberately irregular byte offsets.
            const width = [1, 4, 2, 11, 3, 7][chunkNo % 6] ?? 5;
            controller.enqueue(bytes.slice(offset, offset + width));
            offset += width;
            chunkNo += 1;
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    const runtime: HttpProviderRuntime = {
      endpoint: "http://127.0.0.1:18080/v1",
      model: request.modelRef,
      serverBuildId: "controlled-sse",
      authMode: "none",
      modelRevision: "fixture",
      serverProps: {},
      temperature: 0,
      reasoningSettings: "none",
      contextWindow: 8_192,
      outputCeiling: 2_048,
    };
    const sdk = makeHttpProviderClient({ runtime, captures: [] });
    const harness = makeHarness(sdk);
    try {
      await initialize(harness);
      const result = await harness.run(runtimeEffect());
      expect(result.events).toContainEqual({
        _tag: "TextDelta",
        text: "chunked hello",
      });
      expect(result.events).toContainEqual({
        _tag: "ToolCallProposed",
        callRef: "call-1",
        toolName: "read",
        argumentsJson: '{"path":"."}',
      });
      expect(result.events).toContainEqual({
        _tag: "UsageReported",
        inputTokens: 3,
        outputTokens: 2,
      });
      expect(result.events).toContainEqual({
        _tag: "TurnCompleted",
        finishReason: "ToolCall",
      });
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(harness.root, { recursive: true, force: true });
    }
  });
});
