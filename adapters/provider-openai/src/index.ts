import type {
  CanonicalProviderEvent,
  PortableModelRequest,
  ProviderExecutionContext,
  ProviderFailure,
  ProviderFailureKind,
  ProviderFinishReason,
} from "@arbor/ports";
import { ProviderPort } from "@arbor/ports";
import { Layer, Stream } from "effect";

/**
 * P12 `12` §2: the first concrete real provider family.
 *
 * `adapters/provider-openai` implements the frozen `ProviderPort` as a `Layer`
 * and emits `CanonicalProviderEvent` (ADT unchanged). It is selected only at
 * the Composition Root, via the model catalog `adapterId` (`12` §3) — never
 * auto-discovered, never a runtime/LLM decision.
 *
 * DID §0A.6: SDK/transport errors are translated at this adapter boundary to
 * `ProviderFailure`; no SDK type ever appears in the stream `E` channel.
 */

/** Raw SDK error class. It must never cross the adapter boundary; the
 * adapter maps it to a `ProviderFailure` and discards the raw value. */
export class OpenAISdkError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? `openai sdk error ${status} ${code}`);
    this.name = "OpenAISdkError";
    this.status = status;
    this.code = code;
  }
}

export type OpenAISdkFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter";

/** Minimal, SDK-neutral chunk vocabulary. A real SDK client adapts its wire
 * format to this; tests inject a deterministic fake. */
export type OpenAISdkChunk =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly callRef: string;
      readonly toolName: string;
      readonly argumentsJson: string;
    }
  | {
      readonly type: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
    }
  | { readonly type: "continuation"; readonly stateRef: string }
  | {
      readonly type: "completed";
      readonly finishReason: OpenAISdkFinishReason;
    };

/** Injected SDK client seam: transport/auth stay outside the port so tests
 * run with no live network. */
export interface OpenAISdkClient {
  readonly streamChat: (input: {
    readonly modelRef: string;
    readonly request: PortableModelRequest;
    readonly context: ProviderExecutionContext;
  }) => AsyncIterable<OpenAISdkChunk>;
}

const KIND_BY_CODE: Record<string, ProviderFailureKind> = {
  rate_limit_exceeded: "RateLimited",
  invalid_api_key: "AuthenticationFailed",
  authentication_error: "AuthenticationFailed",
  invalid_request_error: "RequestRejected",
  server_error: "ProviderUnavailable",
  overloaded: "ProviderUnavailable",
  stream_interrupted: "StreamInterrupted",
};

/**
 * The adapter-boundary error translation (DID §0A.6). The raw SDK/transport
 * value is discarded, never attached to the failure, so the `E` channel
 * carries only `ProviderFailure`. An unknown provider-specific class
 * normalizes to `ProtocolViolation` (terminal, `12` §5).
 */
/** Structural guard so the translation is robust to duplicated module
 * instances (a bundler/realm may hand us an `OpenAISdkError` from another
 * copy) while still refusing to let the raw value cross the boundary. */
const isOpenAISdkError = (error: unknown): error is OpenAISdkError =>
  error instanceof OpenAISdkError ||
  (typeof error === "object" &&
    error !== null &&
    (error as { readonly name?: unknown }).name === "OpenAISdkError" &&
    typeof (error as { readonly status?: unknown }).status === "number" &&
    typeof (error as { readonly code?: unknown }).code === "string");

export const classifyOpenAISdkFailure = (error: unknown): ProviderFailure => {
  if (isOpenAISdkError(error)) {
    const byCode = KIND_BY_CODE[error.code];
    if (byCode !== undefined) {
      return { _tag: "ProviderFailure", kind: byCode };
    }
    if (error.status === 429) {
      return { _tag: "ProviderFailure", kind: "RateLimited" };
    }
    if (error.status === 401 || error.status === 403) {
      return { _tag: "ProviderFailure", kind: "AuthenticationFailed" };
    }
    if (error.status === 400 || error.status === 422) {
      return { _tag: "ProviderFailure", kind: "RequestRejected" };
    }
    if (error.status >= 500) {
      return { _tag: "ProviderFailure", kind: "ProviderUnavailable" };
    }
  }
  return { _tag: "ProviderFailure", kind: "ProtocolViolation" };
};

const FINISH_REASON: Record<OpenAISdkFinishReason, ProviderFinishReason> = {
  stop: "Stop",
  length: "MaxOutputTokens",
  tool_calls: "ToolCall",
  content_filter: "ContentFilter",
};

const toCanonical = (chunk: OpenAISdkChunk): CanonicalProviderEvent => {
  switch (chunk.type) {
    case "text":
      return { _tag: "TextDelta", text: chunk.text };
    case "reasoning":
      return { _tag: "ReasoningDelta", text: chunk.text };
    case "tool_call":
      return {
        _tag: "ToolCallProposed",
        callRef: chunk.callRef,
        toolName: chunk.toolName,
        argumentsJson: chunk.argumentsJson,
      };
    case "usage":
      return {
        _tag: "UsageReported",
        inputTokens: chunk.inputTokens,
        outputTokens: chunk.outputTokens,
        ...(chunk.cacheReadTokens !== undefined
          ? { cacheReadTokens: chunk.cacheReadTokens }
          : {}),
        ...(chunk.cacheWriteTokens !== undefined
          ? { cacheWriteTokens: chunk.cacheWriteTokens }
          : {}),
      };
    case "continuation":
      return { _tag: "ContinuationState", stateRef: chunk.stateRef };
    case "completed":
      return {
        _tag: "TurnCompleted",
        finishReason: FINISH_REASON[chunk.finishReason],
      };
  }
};

export const OpenAIProviderLive = (
  client: OpenAISdkClient,
): Layer.Layer<ProviderPort> =>
  Layer.succeed(
    ProviderPort,
    ProviderPort.of({
      runTurn: ({ request, context }) => {
        const started: CanonicalProviderEvent = {
          _tag: "TurnStarted",
          providerTurnId: context.providerTurnId,
          attemptNo: context.attemptNo,
          modelRef: request.modelRef,
        };
        const normalized = Stream.fromAsyncIterable(
          client.streamChat({
            modelRef: request.modelRef,
            request,
            context,
          }),
          classifyOpenAISdkFailure,
        ).pipe(Stream.map(toCanonical));
        return Stream.concat(Stream.fromIterable([started]), normalized);
      },
    }),
  );
