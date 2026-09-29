import type { ReadableStream } from "node:stream/web";
import { clearTimeout, setTimeout } from "node:timers";
import { TextDecoder } from "node:util";
import type { PortableMessage, PortableModelRequest } from "@arbor/ports";
import {
  type OpenAISdkChunk,
  type OpenAISdkClient,
  OpenAISdkError,
} from "./sdk.js";

export interface OpenAICompatibleFetchInit {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: unknown;
}

export interface OpenAICompatibleFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: ReadableStream<Uint8Array> | null;
}

export type OpenAICompatibleFetch = (
  url: string,
  init: OpenAICompatibleFetchInit,
) => Promise<OpenAICompatibleFetchResponse>;

export interface OpenAICompatibleClientConfig {
  readonly baseUrl: string;
  readonly model?: string;
  /** Opt in only for an explicitly configured local endpoint that has no
   * authentication layer (for example a host-local llama.cpp server). */
  readonly allowUnauthenticated?: boolean;
  readonly fetch?: OpenAICompatibleFetch;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

const endpointOf = (baseUrl: string): string => {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const stringField = (value: unknown, key: string): string | undefined => {
  const field = asRecord(value)?.[key];
  return typeof field === "string" ? field : undefined;
};

const portableMessages = (
  request: PortableModelRequest,
): ReadonlyArray<{ readonly role: string; readonly content: string }> => [
  ...request.instructions.map((instruction) => ({
    role: "system",
    content: instruction.text,
  })),
  ...request.messages.map((message: PortableMessage) => ({
    role: message.role === "tool" ? "user" : message.role,
    content:
      message.role === "tool"
        ? `Tool observation:\n${message.text}`
        : message.text,
  })),
];

const requestBody = (
  modelRef: string,
  request: PortableModelRequest,
): Record<string, unknown> => ({
  model: modelRef,
  messages: portableMessages(request),
  max_tokens: request.budget.maxOutputTokens,
  stream: true,
  stream_options: { include_usage: true },
  ...(request.toolDefinitions.length > 0
    ? {
        tools: request.toolDefinitions.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: JSON.parse(tool.schemaJson) as unknown,
          },
        })),
      }
    : {}),
});

const finishReasonOf = (
  reason: unknown,
): OpenAISdkChunk & { readonly type: "completed" } => {
  switch (reason) {
    case "length":
      return { type: "completed", finishReason: "length" };
    case "tool_calls":
    case "function_call":
      return { type: "completed", finishReason: "tool_calls" };
    case "content_filter":
      return { type: "completed", finishReason: "content_filter" };
    default:
      return { type: "completed", finishReason: "stop" };
  }
};

interface PendingToolCall {
  callRef: string;
  toolName: string;
  argumentsJson: string;
}

const readSse = async function* (
  response: OpenAICompatibleFetchResponse,
): AsyncGenerator<OpenAISdkChunk> {
  const body = response.body;
  if (body === null) {
    throw new OpenAISdkError(502, "stream_interrupted");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map<number, PendingToolCall>();
  let buffer = "";
  let dataLines: string[] = [];
  let finishReason: unknown;

  const consumeEvent = (data: string): ReadonlyArray<OpenAISdkChunk> => {
    if (data === "[DONE]") {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      throw new OpenAISdkError(502, "invalid_response");
    }
    const root = asRecord(parsed);
    const error = asRecord(root?.error);
    if (error !== undefined) {
      const code =
        stringField(error, "code") ??
        stringField(error, "type") ??
        "invalid_response";
      throw new OpenAISdkError(502, code);
    }
    const choices = root?.choices;
    const firstChoice = Array.isArray(choices)
      ? asRecord(choices[0])
      : undefined;
    const delta = asRecord(firstChoice?.delta);
    const chunks: OpenAISdkChunk[] = [];

    if (typeof delta?.content === "string" && delta.content.length > 0) {
      chunks.push({ type: "text", text: delta.content });
    }
    if (
      typeof delta?.reasoning_content === "string" &&
      delta.reasoning_content.length > 0
    ) {
      chunks.push({ type: "reasoning", text: delta.reasoning_content });
    }

    const toolCalls = delta?.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const item of toolCalls) {
        const call = asRecord(item);
        if (call === undefined) {
          continue;
        }
        const index = typeof call.index === "number" ? call.index : calls.size;
        const current = calls.get(index) ?? {
          callRef: "",
          toolName: "",
          argumentsJson: "",
        };
        const fn = asRecord(call.function);
        if (typeof call.id === "string") {
          current.callRef = call.id;
        }
        if (typeof fn?.name === "string") {
          current.toolName += fn.name;
        }
        if (typeof fn?.arguments === "string") {
          current.argumentsJson += fn.arguments;
        }
        calls.set(index, current);
      }
    }

    const usage = asRecord(root?.usage);
    if (
      typeof usage?.prompt_tokens === "number" &&
      typeof usage.completion_tokens === "number"
    ) {
      chunks.push({
        type: "usage",
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
      });
    }
    if (firstChoice?.finish_reason !== undefined) {
      finishReason = firstChoice.finish_reason;
    }
    return chunks;
  };

  try {
    while (true) {
      const read = await reader.read().catch(() => {
        throw new OpenAISdkError(503, "stream_interrupted");
      });
      buffer += decoder.decode(read.value, { stream: !read.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) {
          if (dataLines.length > 0) {
            for (const chunk of consumeEvent(dataLines.join("\n"))) {
              yield chunk;
            }
            dataLines = [];
          }
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      if (read.done) {
        if (buffer.startsWith("data:")) {
          dataLines.push(buffer.slice(5).trimStart());
        }
        if (dataLines.length > 0) {
          for (const chunk of consumeEvent(dataLines.join("\n"))) {
            yield chunk;
          }
          dataLines = [];
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  for (const call of calls.values()) {
    if (call.callRef.length === 0 || call.toolName.length === 0) {
      throw new OpenAISdkError(502, "invalid_response");
    }
    yield {
      type: "tool_call",
      callRef: call.callRef,
      toolName: call.toolName,
      argumentsJson: call.argumentsJson,
    };
  }
  yield finishReasonOf(finishReason);
};

export const OpenAICompatibleFetchClient = (
  config: OpenAICompatibleClientConfig,
): OpenAISdkClient => ({
  // A pure model call sends request bytes to the provider endpoint but has no
  // externally observable side effect beyond that transport.
  externalEffectPossible: false,
  streamChat: async function* ({ modelRef, request, context }) {
    const credential = context.secretMaterial?.reveal();
    if (
      (credential === undefined || credential.length === 0) &&
      config.allowUnauthenticated !== true
    ) {
      throw new OpenAISdkError(401, "invalid_api_key");
    }
    const AbortControllerConstructor = (
      globalThis as unknown as {
        readonly AbortController: new () => {
          readonly signal: unknown;
          abort: () => void;
        };
      }
    ).AbortController;
    const controller = new AbortControllerConstructor();
    const deadlineMs = Math.max(
      1,
      new Date(context.turnDeadlineAt).getTime() - Date.now(),
    );
    const timeout = setTimeout(() => controller.abort(), deadlineMs);
    const relayAbort = () => controller.abort();
    context.cancellationSignal.addEventListener("abort", relayAbort, {
      once: true,
    });
    if (context.cancellationSignal.aborted) controller.abort();
    try {
      let response: OpenAICompatibleFetchResponse;
      try {
        const nativeFetch = (
          globalThis as unknown as { readonly fetch: OpenAICompatibleFetch }
        ).fetch;
        response = await (config.fetch ?? nativeFetch)(
          endpointOf(config.baseUrl),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "text/event-stream",
              ...(credential !== undefined && credential.length > 0
                ? { authorization: `Bearer ${credential}` }
                : {}),
              ...config.extraHeaders,
            },
            body: JSON.stringify(
              requestBody(config.model ?? modelRef, request),
            ),
            signal: controller.signal,
          },
        );
      } catch {
        throw new OpenAISdkError(503, "server_error");
      }
      if (!response.ok) {
        throw new OpenAISdkError(
          response.status,
          response.status === 401 || response.status === 403
            ? "invalid_api_key"
            : response.status === 429
              ? "rate_limit_exceeded"
              : response.status >= 500
                ? "server_error"
                : "invalid_request_error",
        );
      }
      yield* readSse(response);
    } finally {
      clearTimeout(timeout);
      context.cancellationSignal.removeEventListener("abort", relayAbort);
    }
  },
});

export const openAICompatibleEndpointOf = endpointOf;
