import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { OpenAiResponsesProviderLive } from "../../src/agent-runtime/openai-responses-provider.js";
import { ModelPort } from "../../src/agent-runtime/provider.js";

const toolCallBody = {
  status: "completed",
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "reading the file" }],
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: '{"path":"x"}',
    },
  ],
};

describe("OpenAiResponsesProvider (D-032-amend)", () => {
  it("maps request (instructions/input/flat tools) and response (function_call → tool-calls)", async () => {
    let captured: { url: string; body: Record<string, unknown> } | undefined;
    const fakeFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body ?? "{}")) };
      return new Response(JSON.stringify(toolCallBody), { status: 200 });
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const p = yield* ModelPort;
        const t = yield* p.complete({
          system: "sys",
          messages: [{ role: "user", content: "hi" }],
        });
        expect(t.finishReason).toBe("tool-calls");
        expect(t.content).toBe("reading the file");
        expect(t.toolCalls).toEqual([
          { id: "call_1", name: "read_file", arguments: '{"path":"x"}' },
        ]);
      }).pipe(
        Effect.provide(
          OpenAiResponsesProviderLive({
            fetchImpl: fakeFetch,
            env: {
              OPENAI_API_KEY: "k",
              OPENAI_MODEL: "deepseek-v4-flash",
              OPENAI_BASE_URL: "https://api.deepseek.com/v1",
            },
          }),
        ),
      ),
    );
    expect(captured?.url).toBe("https://api.deepseek.com/v1/responses");
    expect(captured?.body.instructions).toBe("sys");
    expect(captured?.body.input).toEqual([{ role: "user", content: "hi" }]);
  });

  it("replays tool history as function_call / function_call_output pairs", async () => {
    let captured: Record<string, unknown> | undefined;
    const fakeFetch: typeof fetch = async (_url, init) => {
      captured = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
        }),
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
            { role: "assistant", toolCalls: [{ id: "c1", name: "t", arguments: "{}" }] },
            { role: "tool", toolCallId: "c1", content: "result" },
          ],
        });
      }).pipe(
        Effect.provide(
          OpenAiResponsesProviderLive({
            fetchImpl: fakeFetch,
            env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "m" },
          }),
        ),
      ),
    );
    const input = (captured?.input ?? []) as Array<Record<string, unknown>>;
    expect(input[1]).toEqual({ type: "function_call", call_id: "c1", name: "t", arguments: "{}" });
    expect(input[2]).toEqual({ type: "function_call_output", call_id: "c1", output: "result" });
  });

  it("tools map to flat responses format (not nested function envelope)", async () => {
    let captured: Record<string, unknown> | undefined;
    const fakeFetch: typeof fetch = async (_url, init) => {
      captured = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        }),
        { status: 200 },
      );
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const p = yield* ModelPort;
        yield* p.complete({
          system: "s",
          messages: [{ role: "user", content: "x" }],
          tools: [{ name: "t1", description: "d", jsonSchema: { type: "object" } }],
        });
      }).pipe(
        Effect.provide(
          OpenAiResponsesProviderLive({
            fetchImpl: fakeFetch,
            env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "m" },
          }),
        ),
      ),
    );
    expect(captured?.tools).toEqual([
      { type: "function", name: "t1", description: "d", parameters: { type: "object" } },
    ]);
  });

  it("status incomplete + max_output_tokens maps to length", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [{ type: "message", content: [{ type: "output_text", text: "trunc" }] }],
        }),
        { status: 200 },
      );
    await Effect.runPromise(
      Effect.gen(function* () {
        const p = yield* ModelPort;
        const t = yield* p.complete({ system: "s", messages: [{ role: "user", content: "x" }] });
        expect(t.finishReason).toBe("length");
      }).pipe(
        Effect.provide(
          OpenAiResponsesProviderLive({
            fetchImpl: fakeFetch,
            env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "m" },
          }),
        ),
      ),
    );
  });

  it("missing OPENAI_MODEL and non-200 fail", async () => {
    const noModel = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const p = yield* ModelPort;
        return yield* p.complete({ system: "s", messages: [] });
      }).pipe(
        Effect.provide(
          OpenAiResponsesProviderLive({
            fetchImpl: async () => new Response("{}", { status: 200 }),
            env: {},
          }),
        ),
      ),
    );
    expect(noModel._tag).toBe("Failure");

    const badStatus = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const p = yield* ModelPort;
        return yield* p.complete({ system: "s", messages: [{ role: "user", content: "x" }] });
      }).pipe(
        Effect.provide(
          OpenAiResponsesProviderLive({
            fetchImpl: async () => new Response("nope", { status: 401 }),
            env: { OPENAI_API_KEY: "k", OPENAI_MODEL: "m" },
          }),
        ),
      ),
    );
    expect(badStatus._tag).toBe("Failure");
  });
});
