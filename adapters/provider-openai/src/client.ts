import type { ReadableStream } from "node:stream/web";
import { clearTimeout, setTimeout } from "node:timers";
import { TextDecoder } from "node:util";
import type {
  PortableInputItem,
  PortableModelRequest,
  PortableRequestCompatibility,
  ProviderCancellationSignal,
} from "@arbor/ports";
import {
  portableInputItems,
  validatePortableRequestCompatibility,
  validatePortableToolPairing,
} from "@arbor/ports";
import {
  OpenAIProtocolError,
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

const isLoopbackEndpoint = (endpoint: string): boolean => {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      /^127(?:\.\d{1,3}){3}$/u.test(hostname) ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const stringField = (value: unknown, key: string): string | undefined => {
  const field = asRecord(value)?.[key];
  return typeof field === "string" ? field : undefined;
};

const OPENAI_CHAT_COMPATIBILITY = {
  operationKinds: ["Inference", "CompactionSummary"],
  inputItemKinds: [
    "Message",
    "ToolCall",
    "ToolResult",
    "ControlResult",
    "ContextUpdate",
  ],
} as const satisfies PortableRequestCompatibility;

const resultContent = (
  item: Extract<
    PortableInputItem,
    { readonly _tag: "ToolResult" | "ControlResult" }
  >,
): string =>
  item.status === "Succeeded"
    ? item.outputText
    : `[${item.status}] ${item.outputText}`;

const lowerInputItem = (
  item: PortableInputItem,
): Readonly<Record<string, unknown>> => {
  switch (item._tag) {
    case "Message":
      return item.role === "tool"
        ? {
            role: "user",
            content: `Legacy tool observation:\n${item.text}`,
          }
        : { role: item.role, content: item.text };
    case "ToolCall":
      throw new OpenAISdkError(400, "portable_tool_call_grouping_invalid");
    case "ToolResult":
    case "ControlResult":
      return {
        role: "tool",
        tool_call_id: item.callRef,
        content: resultContent(item),
      };
    case "ContextUpdate":
      return {
        role: "system",
        content: `[Context ${item.updateKind} ${item.sourceRef}@${item.revision}]\n${item.text}`,
      };
    case "CompactionCheckpoint":
    case "AttachmentRef":
      throw new OpenAISdkError(400, "portable_request_incompatible");
  }
};

const lowerInputItems = (
  items: ReadonlyArray<PortableInputItem>,
): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  const lowered: Array<Readonly<Record<string, unknown>>> = [];
  for (let index = 0; index < items.length; ) {
    const item = items[index] as PortableInputItem;
    if (item._tag !== "ToolCall") {
      lowered.push(lowerInputItem(item));
      index += 1;
      continue;
    }
    const calls: Array<Extract<PortableInputItem, { _tag: "ToolCall" }>> = [];
    while (index < items.length && items[index]?._tag === "ToolCall") {
      calls.push(
        items[index] as Extract<PortableInputItem, { _tag: "ToolCall" }>,
      );
      index += 1;
    }
    lowered.push({
      role: "assistant",
      content: null,
      tool_calls: calls.map((call) => ({
        id: call.callRef,
        type: "function",
        function: {
          name: call.toolName,
          arguments: call.argumentsJson,
        },
      })),
    });
  }
  return lowered;
};

const portableMessages = (
  request: PortableModelRequest,
): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  const compatible = validatePortableRequestCompatibility(
    request,
    OPENAI_CHAT_COMPATIBILITY,
  );
  if (!compatible.ok) {
    throw new OpenAISdkError(400, "portable_request_incompatible");
  }
  const items = portableInputItems(request);
  const pairing = validatePortableToolPairing(items);
  if (!pairing.ok) {
    throw new OpenAISdkError(400, "portable_tool_pairing_invalid");
  }
  return [
    ...request.instructions.map((instruction) => ({
      role: "system",
      content: instruction.text,
    })),
    ...lowerInputItems(items),
  ];
};

/**
 * The sole OpenAI-compatible rendering boundary for a portable request.
 *
 * Qualification clients may capture or dispatch this value, but must not
 * reimplement message lowering: doing so can turn one typed ToolCall batch
 * into invalid assistant/tool history.
 */
export const openAICompatibleRequestBody = (
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
    case "stop":
      return { type: "completed", finishReason: "stop" };
    case "length":
      return { type: "completed", finishReason: "length" };
    case "tool_calls":
    case "function_call":
      return { type: "completed", finishReason: "tool_calls" };
    case "content_filter":
      return { type: "completed", finishReason: "content_filter" };
    default:
      throw new OpenAIProtocolError("unsupported-finish-reason");
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
  let finishReasonSeen = false;
  let doneSeen = false;
  let streamCompleted = false;

  const consumeEvent = (data: string): ReadonlyArray<OpenAISdkChunk> => {
    if (data === "[DONE]") {
      doneSeen = true;
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
      // Gate C C1 + R2 (D1 remediation): reasoning tokens translate from
      // completion_tokens_details.reasoning_tokens. Cache tokens translate
      // from the DeepSeek-native read semantics ONLY — prompt_cache_hit_tokens
      // is the canonical read/hit dimension; prompt_tokens_details.cached_tokens
      // is the SAME quantity in OpenAI-compatible form and must not be
      // double-counted (native top-level field wins). DeepSeek exposes no
      // cache-write dimension, so cacheWriteTokens stays absent (unknown,
      // never 0).
      const details = asRecord(usage.completion_tokens_details);
      const promptDetails = asRecord(usage.prompt_tokens_details);
      const cacheRead =
        typeof usage.prompt_cache_hit_tokens === "number"
          ? usage.prompt_cache_hit_tokens
          : typeof promptDetails?.cached_tokens === "number"
            ? promptDetails.cached_tokens
            : undefined;
      chunks.push({
        type: "usage",
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        ...(typeof details?.reasoning_tokens === "number"
          ? { reasoningTokens: details.reasoning_tokens }
          : {}),
        ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
      });
    }
    if (firstChoice?.finish_reason !== undefined) {
      finishReason = firstChoice.finish_reason;
      if (finishReason !== null) finishReasonSeen = true;
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
        streamCompleted = true;
        break;
      }
    }
  } finally {
    if (!streamCompleted) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }

  if (!doneSeen || !finishReasonSeen) {
    throw new OpenAIProtocolError("stream-termination-incomplete");
  }

  for (const call of calls.values()) {
    if (call.callRef.length === 0 || call.toolName.length === 0) {
      throw new OpenAISdkError(502, "invalid_response");
    }
    // R1 (D1 remediation): the provider wire carries finish_reason=tool_calls
    // only when the arguments JSON is complete. A truncated stream (observed
    // intermittently on the live endpoint) must fail closed as a malformed
    // wire output — never repaired, never passed through as silent bad data.
    try {
      JSON.parse(call.argumentsJson);
    } catch {
      throw new OpenAISdkError(502, "tool_arguments_truncated");
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
  // A remote provider request can be billed or accepted even when the local
  // transport later fails. Loopback qualification endpoints are effect-free.
  externalEffectPossible: !isLoopbackEndpoint(endpointOf(config.baseUrl)),
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
          readonly signal: ProviderCancellationSignal;
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
              openAICompatibleRequestBody(config.model ?? modelRef, request),
            ),
            signal: controller.signal,
          },
        );
      } catch (error) {
        // Native transport failures (TypeError from fetch, ECONNRESET, abort)
        // must reach the adapter-edge classifier unclassified so it can
        // distinguish TransportFailed (pre-response) from StreamInterrupted
        // (post-response) — pre-classifying here would erase the distinction
        // (found by P16 conformance A5).
        if (
          error instanceof OpenAISdkError ||
          error instanceof TypeError ||
          (typeof error === "object" &&
            error !== null &&
            typeof (error as { readonly code?: unknown }).code === "string") ||
          controller.signal.aborted
        ) {
          throw error;
        }
        throw new OpenAISdkError(503, "server_error");
      }
      yield { type: "response_started" };
      if (!response.ok) {
        throw new OpenAISdkError(
          response.status,
          response.status === 401
            ? "invalid_api_key"
            : response.status === 403
              ? "permission_denied"
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
