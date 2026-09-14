import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { OpenAiProviderLive } from "../../src/agent-runtime/openai-provider.js";
import { ModelPort } from "../../src/agent-runtime/provider.js";

const okBody = {
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"x"}' },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
};

describe("OpenAIProvider (A1/A3/A4)", () => {
  it("maps request and response", async () => {
    let captured: { url: string; body: unknown } | undefined;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = {
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")),
      };
      return new Response(JSON.stringify(okBody), { status: 200 });
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const p = yield* ModelPort;
        const t = yield* p.complete({
          system: "sys",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(t.finishReason).toBe("tool-calls");
        expect(t.toolCalls[0]?.name).toBe("read_file");
        expect(t.toolCalls[0]?.arguments).toBe('{"path":"x"}');
      }).pipe(
        Effect.provide(
          OpenAiProviderLive({
            fetchImpl: fakeFetch,
            env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-test" },
          }),
        ),
      ),
    );
    expect(captured?.url).toBe("https://api.openai.com/v1/chat/completions");
    const body = captured?.body as { model: string; stream: boolean; messages: Array<object> };
    expect(body.model).toBe("gpt-test");
    expect(body.stream).toBe(false);
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
  });

  it("assistant tool history maps back to openai format", async () => {
    let captured: unknown;
    const fakeFetch: typeof fetch = async (_url, init) => {
      captured = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
        { status: 200 },
      );
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const p = yield* ModelPort;
        yield* p.complete({
          system: "s",
          messages: [
            { role: "user", content: "go" },
            {
              role: "assistant",
              toolCalls: [{ id: "c1", name: "t", arguments: "{}" }],
            },
            { role: "tool", toolCallId: "c1", content: "result" },
          ],
        });
      }).pipe(
        Effect.provide(
          OpenAiProviderLive({
            fetchImpl: fakeFetch,
            env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "m" },
          }),
        ),
      ),
    );
    const msgs = (captured as { messages: Array<Record<string, unknown>> }).messages;
    expect(msgs[2]).toEqual({
      role: "assistant",
      tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }],
    });
    expect(msgs[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "result" });
  });

  it("missing OPENAI_MODEL fails (A2)", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const p = yield* ModelPort;
        return yield* p.complete({ system: "s", messages: [] });
      }).pipe(
        Effect.provide(
          OpenAiProviderLive({
            fetchImpl: async () => new Response("{}", { status: 200 }),
            env: {},
          }),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("non-200 fails with status", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const p = yield* ModelPort;
        return yield* p.complete({
          system: "s",
          messages: [{ role: "user", content: "x" }],
        });
      }).pipe(
        Effect.provide(
          OpenAiProviderLive({
            fetchImpl: async () => new Response("nope", { status: 401 }),
            env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "m" },
          }),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });
});
