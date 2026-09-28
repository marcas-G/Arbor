import type {
  OpenAISdkChunk,
  OpenAISdkClient,
  OpenAISdkFinishReason,
} from "../../../adapters/provider-openai/src/index.js";
import type {
  PortableMessage,
  PortableModelRequest,
  ProviderExecutionContext,
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
    ...request.messages.map((message: PortableMessage) => ({
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
    case "length":
    case "tool_calls":
    case "content_filter":
      return value;
    default:
      return "stop";
  }
};

const endpointOf = (baseUrl: string): string => {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
};

export const runtimeForProvider = async (input: {
  readonly baseUrl: string;
  readonly model: string;
  readonly serverBuildId: string;
  readonly authMode: "none" | "env";
  readonly modelRevision?: string;
}): Promise<HttpProviderRuntime> => {
  const base = input.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const response = await fetch(`${base}/props`);
  if (!response.ok) {
    throw new Error(`provider /props returned HTTP ${response.status}`);
  }
  const serverProps = (await response.json()) as unknown;
  const props =
    typeof serverProps === "object" && serverProps !== null
      ? (serverProps as Record<string, unknown>)
      : {};
  const generation =
    typeof props.default_generation_settings === "object" &&
    props.default_generation_settings !== null
      ? (props.default_generation_settings as Record<string, unknown>).params
      : undefined;
  const params =
    typeof generation === "object" && generation !== null
      ? (generation as Record<string, unknown>)
      : {};
  const temperature =
    typeof params.temperature === "number" ? params.temperature : 1;
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
      "Not set per request; llama-server launched with --reasoning-format deepseek -rea on",
  };
};

export const makeHttpProviderClient = (input: {
  readonly runtime: HttpProviderRuntime;
  readonly apiKey?: string;
  readonly captures: Array<HttpProviderCallEvidence>;
}): OpenAISdkClient => ({
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
      });
      capture.responseStatus = response.status;
      capture.responseHeaders = Object.fromEntries(
        [...response.headers.entries()].filter(([name]) =>
          ["content-type", "x-request-id", "server"].includes(
            name.toLowerCase(),
          ),
        ),
      );
      if (!response.ok) {
        const body = await response.text();
        capture.responseBodyBase64 = Buffer.from(body).toString("base64");
        throw new Error(`provider returned HTTP ${response.status}: ${body}`);
      }
      if (response.body === null) {
        throw new Error("provider returned a successful response without a body");
      }

      const [streamBody, evidenceBody] = response.body.tee();
      const evidencePromise = (async () => {
        const reader = evidenceBody.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(next.value);
        }
        capture.responseBodyBase64 = bytesToBase64(chunks);
      })();
      const reader = streamBody.getReader();
      const decoder = new TextDecoder();
      const calls = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      let buffer = "";
      let completedReason: OpenAISdkFinishReason = "stop";
      let usage: OpenAISdkChunk | undefined;
      const consumeFrame = function* (
        frame: string,
      ): Generator<OpenAISdkChunk> {
        const data = frame
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data.length === 0 || data === "[DONE]") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data) as unknown;
        } catch {
          throw new Error(`provider emitted invalid SSE JSON: ${data}`);
        }
        if (typeof parsed !== "object" || parsed === null) return;
        const record = parsed as Record<string, unknown>;
        if (
          typeof record.usage === "object" &&
          record.usage !== null
        ) {
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
        if (choiceRecord.finish_reason !== null) {
          completedReason = finishReason(choiceRecord.finish_reason);
        }
        const delta =
          typeof choiceRecord.delta === "object" &&
          choiceRecord.delta !== null
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
            typeof toolCall.function === "object" &&
            toolCall.function !== null
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
        for (const call of [...calls.values()]) {
          if (call.id.length === 0 || call.name.length === 0) {
            throw new Error("provider returned a tool call without id/name");
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
        await evidencePromise;
      }
    } catch (error) {
      capture.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  },
});
