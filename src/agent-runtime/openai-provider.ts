import { Effect, Layer } from "effect";
import {
  type ChatMessage,
  ModelError,
  ModelPort,
  type ModelToolSpec,
  type ModelTurn,
} from "./provider.js";

interface Deps {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
}

interface OpenAiChoice {
  message: {
    content: string | null;
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  };
  finish_reason: string;
}

const mapMessages = (system: string, msgs: ReadonlyArray<ChatMessage>): Array<object> => [
  { role: "system", content: system },
  ...msgs.map((m): object => {
    if (m.role === "user") {
      return { role: "user", content: m.content };
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
    return {
      role: "assistant",
      ...(m.content !== undefined ? { content: m.content } : {}),
      ...(m.toolCalls !== undefined
        ? {
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: c.arguments },
            })),
          }
        : {}),
    };
  }),
];

const mapTools = (tools: ReadonlyArray<ModelToolSpec>) =>
  tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.jsonSchema },
  }));

const normFinish = (r: string): ModelTurn["finishReason"] =>
  r === "tool_calls" ? "tool-calls" : r === "length" ? "length" : "stop";

/** A1-A4 (D-032): Chat Completions, non-streaming, OPENAI_MODEL required, ModelTurn normalization. */
export const OpenAiProviderLive = (deps: Deps = {}) =>
  Layer.succeed(
    ModelPort,
    ModelPort.of({
      complete: (req) =>
        Effect.gen(function* () {
          const env = deps.env ?? process.env;
          const key = env.OPENAI_API_KEY;
          const model = env.OPENAI_MODEL;
          if (model === undefined || model === "") {
            return yield* new ModelError({ message: "OPENAI_MODEL is required (A2, D-032)" });
          }
          if (key === undefined || key === "") {
            return yield* new ModelError({ message: "OPENAI_API_KEY is required" });
          }
          const base = (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
          const f = deps.fetchImpl ?? fetch;
          const res = yield* Effect.tryPromise({
            try: () =>
              f(`${base}/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
                body: JSON.stringify({
                  model,
                  stream: false,
                  messages: mapMessages(req.system, req.messages),
                  ...(req.tools !== undefined && req.tools.length > 0
                    ? { tools: mapTools(req.tools) }
                    : {}),
                }),
              }),
            catch: (e) => new ModelError({ message: `network: ${String(e)}` }),
          });
          if (!res.ok) {
            const errBody = yield* Effect.tryPromise({
              try: () => res.text(),
              catch: (e) => new ModelError({ message: String(e) }),
            }).pipe(Effect.orElseSucceed(() => "(unreadable body)" as const));
            return yield* new ModelError({
              message: `openai ${res.status}: ${errBody.slice(0, 500)}`,
            });
          }
          const body = (yield* Effect.tryPromise({
            try: () => res.json(),
            catch: (e) => new ModelError({ message: `bad json: ${String(e)}` }),
          })) as { choices?: Array<OpenAiChoice> };
          const choice = body.choices?.[0];
          if (choice === undefined) {
            return yield* new ModelError({ message: "no choices in response" });
          }
          return {
            content: choice.message.content ?? undefined,
            toolCalls: (choice.message.tool_calls ?? []).map((c) => ({
              id: c.id,
              name: c.function.name,
              arguments: c.function.arguments,
            })),
            finishReason: normFinish(choice.finish_reason),
          };
        }),
    }),
  );
