import type {
  OpenAISdkChunk,
  OpenAISdkClient,
  OpenAISdkFinishReason,
} from "../../../adapters/provider-openai/src/index.js";
import {
  OpenAIProtocolError,
  OpenAISdkError,
} from "../../../adapters/provider-openai/src/index.js";
import {
  type PortableModelRequest,
  portableInputItems,
} from "../../../packages/ports/src/provider.js";

export interface HttpProviderCallEvidence {
  readonly providerTurnId: string;
  readonly attemptNo: number;
  readonly endpoint: string;
  readonly request: Record<string, unknown>;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  responseBodyBase64?: string;
  error?: string;
}

export interface HttpProviderRuntime {
  readonly endpoint: string;
  readonly model: string;
  readonly serverBuildId: string;
  readonly authMode: "none" | "env";
  readonly modelRevision: string;
  readonly serverProps: unknown;
  readonly temperature: number;
  readonly reasoningSettings: string;
}

const messageBody = (
  modelRef: string,
  request: PortableModelRequest,
): Record<string, unknown> => {
  const messages = [
    ...request.instructions.map((instruction) => ({
      role: "system",
      content: instruction.text,
    })),
    ...portableInputItems(request)
      .filter((item) => item._tag === "Message")
      .map((message) => ({
        role: message.role === "tool" ? "user" : message.role,
        content:
          message.role === "tool"
            ? `Tool observation:\n${message.text}`
            : message.text,
      })),
  ];
  return {
    model: modelRef,
    messages,
    max_tokens: request.budget.maxOutputTokens,
    temperature: 0,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.toolDefinitions.length === 0
      ? {}
      : {
          tools: request.toolDefinitions.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: JSON.parse(tool.schemaJson) as unknown,
            },
          })),
        }),
  };
};

const bytesToBase64 = (chunks: ReadonlyArray<Uint8Array>): string => {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return Buffer.from(bytes).toString("base64");
};

const finishReason = (value: unknown): OpenAISdkFinishReason => {
  switch (value) {
    case "stop":
    case "length":
    case "tool_calls":
    case "content_filter":
      return value;
    default:
      throw new OpenAIProtocolError("unsupported-finish-reason");
  }
};

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

export const runtimeForProvider = async (input: {
  readonly baseUrl: string;
  readonly model: string;
  readonly serverBuildId: string;
  readonly authMode: "none" | "env";
  readonly modelRevision?: string;
}): Promise<HttpProviderRuntime> => {
  const base = input.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  // The /props probe is llama.cpp-specific diagnostics. Any other
  // OpenAI-compatible endpoint (vLLM, Ollama, DeepSeek, OpenAI, ...) may not
  // serve it; absence degrades to defaults instead of blocking the run.
  let serverProps: unknown = {};
  let temperature = 1;
  try {
    const response = await fetch(`${base}/props`);
    if (response.ok) {
      serverProps = (await response.json()) as unknown;
      const props =
        typeof serverProps === "object" && serverProps !== null
          ? (serverProps as Record<string, unknown>)
          : {};
      const generation =
        typeof props.default_generation_settings === "object" &&
        props.default_generation_settings !== null
          ? (props.default_generation_settings as Record<string, unknown>)
              .params
          : undefined;
      const params =
        typeof generation === "object" && generation !== null
          ? (generation as Record<string, unknown>)
          : {};
      if (typeof params.temperature === "number") {
        temperature = params.temperature;
      }
    }
  } catch {
    // endpoint not reachable for the probe; the first real call reports
    // connectivity problems with full evidence
  }
  return {
    endpoint: input.baseUrl,
    model: input.model,
    serverBuildId: input.serverBuildId,
    authMode: input.authMode,
    modelRevision:
      input.modelRevision ??
      "not exposed by provider; local model file revision/hash not requested",
    serverProps,
    temperature,
    reasoningSettings:
      "Not set per request; endpoint defaults apply unless the server overrides them",
  };
};

export const makeHttpProviderClient = (input: {
  readonly runtime: HttpProviderRuntime;
  readonly apiKey?: string;
  readonly captures: Array<HttpProviderCallEvidence>;
}): OpenAISdkClient => ({
  // The capability client is used with the local llama.cpp server. A loopback
  // endpoint cannot create provider-side effects outside this machine;
  // unknown/remote endpoints are treated conservatively before fetch starts.
  externalEffectPossible: !isLoopbackEndpoint(input.runtime.endpoint),
  streamChat: async function* ({ modelRef, request, context }) {
    const requestBodyJson = messageBody(modelRef, request);
    const capture: HttpProviderCallEvidence = {
      providerTurnId: context.providerTurnId,
      attemptNo: context.attemptNo,
      endpoint: endpointOf(input.runtime.endpoint),
      request: requestBodyJson,
    };
    input.captures.push(capture);
    try {
      const response = await fetch(capture.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(input.runtime.authMode === "env" && input.apiKey !== undefined
            ? { authorization: `Bearer ${input.apiKey}` }
            : {}),
        },
        body: JSON.stringify(requestBodyJson),
        signal: context.cancellationSignal as AbortSignal,
      });
      capture.responseStatus = response.status;
      capture.responseHeaders = Object.fromEntries(
        [...response.headers.entries()].filter(([name]) =>
          ["content-type", "x-request-id", "server"].includes(
            name.toLowerCase(),
          ),
        ),
      );
      // A status response is still a provider response boundary. Persist it
      // before translating non-2xx status into a typed provider failure.
      yield { type: "response_started" };
      if (!response.ok) {
        const body = await response.text();
        capture.responseBodyBase64 = Buffer.from(body).toString("base64");
        let errorCode = "provider_http_error";
        try {
          const parsed = JSON.parse(body) as {
            error?: { code?: unknown; type?: unknown };
          };
          const candidate = parsed.error?.code ?? parsed.error?.type;
          if (
            typeof candidate === "string" &&
            /^[A-Za-z0-9_-]{1,64}$/u.test(candidate)
          ) {
            errorCode = candidate;
          }
        } catch {
          // The HTTP status remains sufficient classification evidence.
        }
        throw new OpenAISdkError(response.status, errorCode);
      }
      if (response.body === null) {
        throw new OpenAIProtocolError("successful-response-missing-body");
      }

      const reader = response.body.getReader();
      const responseBytes: Uint8Array[] = [];
      const decoder = new TextDecoder();
      const calls = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      let buffer = "";
      let completedReason: OpenAISdkFinishReason = "stop";
      let finishReasonSeen = false;
      let doneFrameSeen = false;
      let usage: OpenAISdkChunk | undefined;
      const consumeFrame = function* (
        frame: string,
      ): Generator<OpenAISdkChunk> {
        const data = frame
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data.length === 0) return;
        if (data === "[DONE]") {
          doneFrameSeen = true;
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data) as unknown;
        } catch {
          throw new OpenAIProtocolError("invalid-sse-json");
        }
        if (typeof parsed !== "object" || parsed === null) return;
        const record = parsed as Record<string, unknown>;
        if (typeof record.usage === "object" && record.usage !== null) {
          const providerUsage = record.usage as Record<string, unknown>;
          usage = {
            type: "usage",
            inputTokens:
              typeof providerUsage.prompt_tokens === "number"
                ? providerUsage.prompt_tokens
                : 0,
            outputTokens:
              typeof providerUsage.completion_tokens === "number"
                ? providerUsage.completion_tokens
                : 0,
          };
        }
        const choices = Array.isArray(record.choices) ? record.choices : [];
        const choice = choices[0];
        if (typeof choice !== "object" || choice === null) return;
        const choiceRecord = choice as Record<string, unknown>;
        if (
          choiceRecord.finish_reason !== null &&
          choiceRecord.finish_reason !== undefined
        ) {
          completedReason = finishReason(choiceRecord.finish_reason);
          finishReasonSeen = true;
        }
        const delta =
          typeof choiceRecord.delta === "object" && choiceRecord.delta !== null
            ? (choiceRecord.delta as Record<string, unknown>)
            : {};
        if (typeof delta.content === "string" && delta.content.length > 0) {
          yield { type: "text", text: delta.content };
        }
        const reasoning =
          typeof delta.reasoning_content === "string"
            ? delta.reasoning_content
            : typeof delta.reasoning === "string"
              ? delta.reasoning
              : "";
        if (reasoning.length > 0) {
          yield { type: "reasoning", text: reasoning };
        }
        const toolCalls = Array.isArray(delta.tool_calls)
          ? delta.tool_calls
          : [];
        for (const item of toolCalls) {
          if (typeof item !== "object" || item === null) continue;
          const toolCall = item as Record<string, unknown>;
          const index =
            typeof toolCall.index === "number" ? toolCall.index : calls.size;
          const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
          if (typeof toolCall.id === "string") call.id += toolCall.id;
          const fn =
            typeof toolCall.function === "object" && toolCall.function !== null
              ? (toolCall.function as Record<string, unknown>)
              : {};
          if (typeof fn.name === "string") call.name += fn.name;
          if (typeof fn.arguments === "string") {
            call.arguments += fn.arguments;
          }
          calls.set(index, call);
        }
      };

      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          responseBytes.push(next.value);
          buffer += decoder.decode(next.value, { stream: true });
          let boundary = buffer.search(/\r?\n\r?\n/u);
          while (boundary >= 0) {
            const match = /\r?\n\r?\n/u.exec(buffer);
            if (match === null || match.index !== boundary) break;
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + match[0].length);
            yield* consumeFrame(frame);
            boundary = buffer.search(/\r?\n\r?\n/u);
          }
        }
        buffer += decoder.decode();
        if (buffer.trim().length > 0) yield* consumeFrame(buffer);
        if (!finishReasonSeen || !doneFrameSeen) {
          throw new OpenAIProtocolError("stream-termination-incomplete");
        }
        for (const call of [...calls.values()]) {
          if (call.id.length === 0 || call.name.length === 0) {
            throw new OpenAIProtocolError("tool-call-missing-identity");
          }
          yield {
            type: "tool_call",
            callRef: call.id,
            toolName: call.name,
            argumentsJson: call.arguments || "{}",
          };
        }
        if (usage !== undefined) yield usage;
        yield { type: "completed", finishReason: completedReason };
      } finally {
        await reader.cancel().catch(() => undefined);
        capture.responseBodyBase64 = bytesToBase64(responseBytes);
      }
    } catch (error) {
      capture.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  },
});
