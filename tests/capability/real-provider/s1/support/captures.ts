// Shared REAL public S1 provider capture model and stream parsers — moved
// verbatim from public-s1-lifecycle.test.ts (B5 split).
import { readFileSync } from "node:fs";

export interface ProductionProviderConfig {
  readonly path: string;
  readonly deploymentId: string;
  readonly modelRef: string;
  readonly endpoint: string;
  readonly wireModelName: string;
  readonly secretKind: "env" | "file" | "inline";
}

export interface ProviderCapture {
  readonly event:
    | "request-start"
    | "response-complete"
    | "response-capture-failed"
    | "request-failed";
  readonly requestId: string;
  readonly processId: number;
  readonly sequence: number;
  readonly method: string;
  readonly path: string;
  readonly request?: Record<string, unknown>;
  readonly status?: number;
  readonly responseBodyBase64?: string;
  readonly captureError?: string;
  readonly error?: string;
}

export const startedProviderRequests = (
  captures: ReadonlyArray<ProviderCapture>,
): ReadonlyArray<ProviderCapture> =>
  captures.filter((capture) => capture.event === "request-start");

export const completedProviderRequestIds = (
  captures: ReadonlyArray<ProviderCapture>,
): ReadonlySet<string> =>
  new Set(
    captures
      .filter(
        (capture) =>
          capture.event === "response-complete" ||
          capture.event === "request-failed" ||
          capture.event === "response-capture-failed",
      )
      .map((capture) => capture.requestId),
  );

export const systemPromptText = (capture: ProviderCapture): string => {
  const messages = capture.request?.messages;
  if (!Array.isArray(messages)) return "";
  return messages
    .filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" && message !== null,
    )
    .filter(
      (message) => message.role === "system" || message.role === "developer",
    )
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? ""),
    )
    .join("\n");
};

export interface CapturedToolCall {
  readonly name: string;
  readonly arguments?: unknown;
}

export const advertisedToolNames = (
  capture: ProviderCapture,
): ReadonlyArray<string> => {
  const tools = capture.request?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (typeof tool !== "object" || tool === null) return [];
    const functionDefinition = (tool as { function?: { name?: unknown } })
      .function;
    return typeof functionDefinition?.name === "string"
      ? [functionDefinition.name]
      : [];
  });
};

export const capturedToolCalls = (
  capture: ProviderCapture,
): ReadonlyArray<CapturedToolCall> => {
  if (capture.responseBodyBase64 === undefined) return [];
  const responseText = Buffer.from(
    capture.responseBodyBase64,
    "base64",
  ).toString("utf8");
  const fragments = new Map<number, { name: string; argumentsText: string }>();
  const absorb = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const calls = (
      value as {
        choices?: Array<{
          delta?: { tool_calls?: unknown[] };
          message?: { tool_calls?: unknown[] };
        }>;
      }
    ).choices?.[0];
    const streamed =
      calls?.delta?.tool_calls ?? calls?.message?.tool_calls ?? [];
    for (const rawCall of streamed) {
      if (typeof rawCall !== "object" || rawCall === null) continue;
      const call = rawCall as {
        index?: number;
        function?: { name?: unknown; arguments?: unknown };
      };
      const index = call.index ?? fragments.size;
      const fragment = fragments.get(index) ?? { name: "", argumentsText: "" };
      if (typeof call.function?.name === "string") {
        fragment.name += call.function.name;
      }
      if (typeof call.function?.arguments === "string") {
        fragment.argumentsText += call.function.arguments;
      } else if (call.function?.arguments !== undefined) {
        fragment.argumentsText += JSON.stringify(call.function.arguments);
      }
      fragments.set(index, fragment);
    }
  };
  for (const line of responseText.split(/\r?\n/u)) {
    if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
    try {
      absorb(JSON.parse(line.slice(6)) as unknown);
    } catch {
      // Ignore non-JSON stream metadata; provider content is diagnostic only.
    }
  }
  if (fragments.size === 0 && responseText.trimStart().startsWith("{")) {
    try {
      absorb(JSON.parse(responseText) as unknown);
    } catch {
      return [];
    }
  }
  return [...fragments.values()].map((fragment) => {
    let parsedArguments: unknown;
    try {
      parsedArguments = JSON.parse(fragment.argumentsText) as unknown;
    } catch {
      parsedArguments = fragment.argumentsText;
    }
    return {
      name: fragment.name,
      ...(fragment.argumentsText.length > 0
        ? { arguments: parsedArguments }
        : {}),
    };
  });
};

export function readProviderCaptures(
  captureFile: string,
): Array<ProviderCapture> {
  let text: string;
  try {
    text = readFileSync(captureFile, "utf8");
  } catch {
    return [];
  }
  const captures: Array<ProviderCapture> = [];
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    try {
      captures.push(JSON.parse(line) as ProviderCapture);
    } catch {
      // Ignore a partial final write while a streamed response is settling.
    }
  }
  return captures;
}
