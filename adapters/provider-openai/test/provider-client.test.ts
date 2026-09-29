import { ReadableStream } from "node:stream/web";
import { TextEncoder } from "node:util";
import { ProviderTurnId, parse } from "@arbor/domain";
import {
  type PortableModelRequest,
  ProviderPort,
  SecretMaterial,
} from "@arbor/ports";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  OpenAICompatibleFetchClient,
  type OpenAICompatibleFetchResponse,
  OpenAIProviderLive,
  type OpenAISdkChunk,
} from "../src/index.js";

const request: PortableModelRequest = {
  modelRef: "model-live",
  instructions: [
    { slotId: "runtime-safety", authorityRole: "A0", text: "Be accurate." },
  ],
  messages: [{ role: "user", text: "What is 2 + 2?" }],
  toolDefinitions: [
    {
      name: "read",
      description: "Read a bounded file.",
      schemaJson: '{"type":"object","properties":{"path":{"type":"string"}}}',
    },
  ],
  outputContractRef: "agent-directive-v1",
  budget: { maxOutputTokens: 64 },
  cacheHints: [],
};

const chunks = async (
  client: ReturnType<typeof OpenAICompatibleFetchClient>,
  secretMaterial: SecretMaterial | null = SecretMaterial.of("test-only-key"),
): Promise<ReadonlyArray<OpenAISdkChunk>> => {
  const result: OpenAISdkChunk[] = [];
  const context = {
    providerTurnId: parse(ProviderTurnId)(
      "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
    ),
    attemptNo: 0,
    ...(secretMaterial !== null ? { secretMaterial } : {}),
    cancellationSignal: new AbortController().signal,
    connectTimeoutMs: 5_000,
    firstEventTimeoutMs: 5_000,
    streamIdleTimeoutMs: 5_000,
    turnDeadlineAt: new Date(Date.now() + 30_000).toISOString(),
    maxAttempts: 3,
  };
  for await (const chunk of client.streamChat({
    modelRef: "model-live",
    request,
    context,
  })) {
    result.push(chunk);
  }
  return result;
};

const eventStream = (
  ...events: ReadonlyArray<unknown>
): OpenAICompatibleFetchResponse => {
  const text = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
  };
};

const byteChunkedEventStream = (
  ...events: ReadonlyArray<unknown>
): OpenAICompatibleFetchResponse => {
  const bytes = new TextEncoder().encode(
    events
      .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
      .concat("data: [DONE]\r\n\r\n")
      .join(""),
  );
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) {
          controller.enqueue(Uint8Array.of(byte));
        }
        controller.close();
      },
    }),
  };
};

describe("OpenAI-compatible fetch provider", () => {
  it("maps the portable request and parses streamed text, usage, and finish", async () => {
    let observedUrl = "";
    let observedHeaders: Readonly<Record<string, string>> | undefined;
    let observedBody: Record<string, unknown> | undefined;
    const client = OpenAICompatibleFetchClient({
      baseUrl: "http://provider.test/v1/",
      model: "local-chat-model",
      fetch: async (input, init) => {
        observedUrl = String(input);
        observedHeaders = init.headers;
        observedBody = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        return eventStream(
          {
            choices: [{ delta: { content: "4" }, finish_reason: null }],
          },
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 17, completion_tokens: 2 },
          },
        );
      },
    });

    await expect(chunks(client)).resolves.toEqual([
      { type: "text", text: "4" },
      { type: "usage", inputTokens: 17, outputTokens: 2 },
      { type: "completed", finishReason: "stop" },
    ]);
    expect(observedUrl).toBe("http://provider.test/v1/chat/completions");
    expect(observedHeaders?.authorization).toBe("Bearer test-only-key");
    expect(observedBody?.model).toBe("local-chat-model");
    expect(observedBody?.messages).toEqual([
      { role: "system", content: "Be accurate." },
      { role: "user", content: "What is 2 + 2?" },
    ]);
    expect(observedBody?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a bounded file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      },
    ]);
  });

  it("joins streamed tool-call fragments into one canonical proposal", async () => {
    const client = OpenAICompatibleFetchClient({
      baseUrl: "http://provider.test/v1",
      fetch: async () =>
        eventStream(
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: { name: "read", arguments: '{"path":' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { arguments: '"README.md"}' },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
        ),
    });

    await expect(chunks(client)).resolves.toEqual([
      {
        type: "tool_call",
        callRef: "call_1",
        toolName: "read",
        argumentsJson: '{"path":"README.md"}',
      },
      { type: "completed", finishReason: "tool_calls" },
    ]);
  });

  it("keeps parallel tool-call argument streams isolated through CanonicalProviderEvent", async () => {
    const client = OpenAICompatibleFetchClient({
      baseUrl: "http://provider.test/v1",
      allowUnauthenticated: true,
      fetch: async () =>
        eventStream(
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "directive-0",
                      type: "function",
                      function: {
                        name: "arbor_directive",
                        arguments: "{",
                      },
                    },
                    {
                      index: 1,
                      id: "directive-1",
                      type: "function",
                      function: { name: "arbor_directive" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 1, function: { arguments: "{}" } },
                    { index: 0, function: { arguments: "}" } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 21, completion_tokens: 3 },
          },
        ),
    });

    const canonicalEvents = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* ProviderPort;
        const collected = yield* Stream.runCollect(
          provider.runTurn({
            request,
            context: {
              providerTurnId: parse(ProviderTurnId)(
                "ptn_018f2b3c-4d5e-7abc-8def-0123456789a2",
              ),
              attemptNo: 0,
              cancellationSignal: new AbortController().signal,
              connectTimeoutMs: 5_000,
              firstEventTimeoutMs: 5_000,
              streamIdleTimeoutMs: 5_000,
              turnDeadlineAt: new Date(Date.now() + 30_000).toISOString(),
              maxAttempts: 3,
            },
          }),
        );
        return Array.from(collected)
          .filter(
            (event): event is Extract<typeof event, { _tag: "Canonical" }> =>
              event._tag === "Canonical",
          )
          .map((event) => event.event);
      }).pipe(Effect.provide(OpenAIProviderLive(client))),
    );

    expect(
      canonicalEvents.filter((event) => event._tag === "ToolCallProposed"),
    ).toEqual([
      {
        _tag: "ToolCallProposed",
        callRef: "directive-0",
        toolName: "arbor_directive",
        argumentsJson: "{}",
      },
      {
        _tag: "ToolCallProposed",
        callRef: "directive-1",
        toolName: "arbor_directive",
        argumentsJson: "{}",
      },
    ]);
    expect(canonicalEvents.at(-1)).toEqual({
      _tag: "TurnCompleted",
      finishReason: "ToolCall",
    });
  });

  it("preserves SSE events split across arbitrary network chunks", async () => {
    const client = OpenAICompatibleFetchClient({
      baseUrl: "http://provider.test/v1",
      fetch: async () =>
        byteChunkedEventStream(
          {
            choices: [
              { delta: { content: "chunk-safe reply" }, finish_reason: null },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
          },
        ),
    });

    await expect(chunks(client)).resolves.toEqual([
      { type: "text", text: "chunk-safe reply" },
      { type: "completed", finishReason: "stop" },
    ]);
  });

  it("fails closed when no resolved credential reaches the provider boundary", async () => {
    const client = OpenAICompatibleFetchClient({
      baseUrl: "http://provider.test/v1",
      fetch: async () => {
        throw new Error("must not send an unauthenticated request");
      },
    });
    await expect(chunks(client, null)).rejects.toMatchObject({
      name: "OpenAISdkError",
      status: 401,
      code: "invalid_api_key",
    });
  });

  it("omits authorization only when an unauthenticated local endpoint is opted in", async () => {
    let observedAuthorization: string | undefined;
    const client = OpenAICompatibleFetchClient({
      baseUrl: "http://127.0.0.1:8011/v1",
      allowUnauthenticated: true,
      fetch: async (_input, init) => {
        observedAuthorization = init.headers.authorization;
        return eventStream({
          choices: [
            { delta: { content: "local response" }, finish_reason: "stop" },
          ],
        });
      },
    });

    await expect(chunks(client, null)).resolves.toEqual([
      { type: "text", text: "local response" },
      { type: "completed", finishReason: "stop" },
    ]);
    expect(observedAuthorization).toBeUndefined();
  });
});
