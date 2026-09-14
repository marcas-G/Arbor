import { Effect, Layer } from "effect";
import {
  type ChatMessage,
  ModelError,
  ModelPort,
  type ModelToolSpec,
  type ModelTurn,
  type ToolCall,
} from "../agent-runtime/provider.js";

interface Deps {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
}

/** Responses API input item (stateless usage: full history replayed each call). */
type InputItem =
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string }
  | {
      readonly type: "function_call";
      readonly call_id: string;
      readonly name: string;
      readonly arguments: string;
    }
  | { readonly type: "function_call_output"; readonly call_id: string; readonly output: string };

const mapInput = (messages: ReadonlyArray<ChatMessage>): InputItem[] => {
  const items: InputItem[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      items.push({ role: "user", content: m.content });
    } else if (m.role === "tool") {
      items.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
    } else if (m.toolCalls !== undefined && m.toolCalls.length > 0) {
      for (const c of m.toolCalls) {
        items.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.arguments });
      }
    } else if (m.content !== undefined) {
      items.push({ role: "assistant", content: m.content });
    }
  }
  return items;
};

/** Responses tools are flat (name/description/parameters at top level),
 * unlike Chat Completions' nested `function` envelope. */
const mapTools = (tools: ReadonlyArray<ModelToolSpec>) =>
  tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.jsonSchema,
  }));

interface ResponsesOutputItem {
  readonly type?: string;
  readonly role?: string;
  readonly content?: Array<{ readonly type?: string; readonly text?: string }>;
  readonly call_id?: string;
  readonly name?: string;
  readonly arguments?: string;
}

interface ResponsesBody {
  readonly status?: string;
  readonly incomplete_details?: { readonly reason?: string };
  readonly output?: ReadonlyArray<ResponsesOutputItem>;
}

/** D-032-amend: Responses-protocol adapter (DeepSeek-compatible gateways; stateless usage). */
export const OpenAiResponsesProviderLive = (deps: Deps = {}) =>
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
              f(`${base}/responses`, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
                body: JSON.stringify({
                  model,
                  stream: false,
                  instructions: req.system,
                  input: mapInput(req.messages),
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
              message: `responses api ${res.status}: ${errBody.slice(0, 500)}`,
            });
          }
          const body = (yield* Effect.tryPromise({
            try: () => res.json(),
            catch: (e) => new ModelError({ message: `bad json: ${String(e)}` }),
          })) as ResponsesBody;

          const output = body.output ?? [];
          const texts: string[] = [];
          const toolCalls: ToolCall[] = [];
          for (const item of output) {
            if (item.type === "message") {
              for (const part of item.content ?? []) {
                if (part.type === "output_text" && part.text !== undefined) {
                  texts.push(part.text);
                }
              }
            } else if (item.type === "function_call" && item.call_id !== undefined) {
              toolCalls.push({
                id: item.call_id,
                name: item.name ?? "",
                arguments: item.arguments ?? "{}",
              });
            }
          }
          const finishReason: ModelTurn["finishReason"] =
            toolCalls.length > 0
              ? "tool-calls"
              : body.status === "incomplete" &&
                  body.incomplete_details?.reason === "max_output_tokens"
                ? "length"
                : "stop";
          const content = texts.length > 0 ? texts.join("\n") : undefined;
          return { content, toolCalls, finishReason };
        }),
    }),
  );
