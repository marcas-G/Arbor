import type {
  CanonicalProviderEvent,
  PortableModelRequest,
  ProtocolAdapter,
  ProviderContinuationCheckpoint,
  ProviderExecutionContext,
  ProviderFailure,
  ProviderFailureKind,
  ProviderFinishReason,
  ProviderPortEvent,
} from "@arbor/ports";
import { PROVIDER_FAILURE_KINDS, ProviderPort } from "@arbor/ports";
import { Layer, Stream } from "effect";
import type { OpenAICompatibleFetch } from "./client.js";
import { OpenAICompatibleFetchClient } from "./client.js";
import {
  OpenAIProtocolError,
  type OpenAISdkChunk,
  type OpenAISdkClient,
  OpenAISdkError,
  type OpenAISdkFinishReason,
} from "./sdk.js";

export {
  OpenAIProtocolError,
  type OpenAISdkChunk,
  type OpenAISdkClient,
  OpenAISdkError,
  type OpenAISdkFinishReason,
} from "./sdk.js";

/**
 * P12's first concrete provider adapter. It translates provider transport
 * events to the provider-neutral stream consumed by Provider Runtime. It
 * never executes a proposed tool call or makes Agent/Work decisions.
 */

export {
  type OpenAICompatibleClientConfig,
  type OpenAICompatibleFetch,
  OpenAICompatibleFetchClient,
  type OpenAICompatibleFetchInit,
  type OpenAICompatibleFetchResponse,
  openAICompatibleEndpointOf,
  openAICompatibleRequestBody,
} from "./client.js";

const KIND_BY_CODE: Readonly<Record<string, ProviderFailureKind>> = {
  // R1 (D1 remediation): a truncated tool-arguments stream under
  // finish_reason=tool_calls is malformed wire output — ProtocolViolation,
  // never repaired and never silently accepted.
  tool_arguments_truncated: "ProtocolViolation",
  rate_limit_exceeded: "RateLimited",
  insufficient_quota: "QuotaExceeded",
  quota_exceeded: "QuotaExceeded",
  invalid_api_key: "AuthenticationFailed",
  authentication_error: "AuthenticationFailed",
  permission_denied: "AuthorizationFailed",
  invalid_request_error: "RequestRejected",
  context_length_exceeded: "ContextLimitExceeded",
  server_error: "ProviderUnavailable",
  overloaded: "ProviderUnavailable",
  stream_interrupted: "StreamInterrupted",
};

const isOpenAISdkError = (error: unknown): error is OpenAISdkError =>
  error instanceof OpenAISdkError ||
  (typeof error === "object" &&
    error !== null &&
    (error as { readonly name?: unknown }).name === "OpenAISdkError" &&
    typeof (error as { readonly status?: unknown }).status === "number" &&
    typeof (error as { readonly code?: unknown }).code === "string");

const rawSafeCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_-]{1,64}$/u.test(code)
    ? code
    : undefined;
};

const transportCodes = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
]);

/** Unknown native/SDK failures remain unknown; only explicit malformed-wire
 * markers are ProtocolViolation. The raw exception is never retained. */
export const classifyOpenAISdkFailure = (
  error: unknown,
  responseStarted = false,
): ProviderFailure => {
  const failed = (
    kind: ProviderFailureKind,
    safeDiagnostic?: string,
  ): ProviderFailure => ({
    _tag: "ProviderFailure",
    kind,
    taxonomyVersion: "phase1-v2",
    ...(safeDiagnostic === undefined ? {} : { safeDiagnostic }),
  });

  if (error instanceof OpenAIProtocolError) {
    return failed("ProtocolViolation", error.safeCode);
  }
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly _tag?: unknown })._tag === "ProviderFailure" &&
    typeof (error as { readonly kind?: unknown }).kind === "string"
  ) {
    const kind = (error as { readonly kind: string }).kind;
    return (PROVIDER_FAILURE_KINDS as ReadonlyArray<string>).includes(kind)
      ? (error as ProviderFailure)
      : failed("UnknownProviderFailure", "unrecognized-provider-failure-kind");
  }
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly name?: unknown }).name === "OpenAIProtocolError"
  ) {
    const code = (error as { readonly safeCode?: unknown }).safeCode;
    return failed(
      "ProtocolViolation",
      typeof code === "string" ? code : "malformed-wire-output",
    );
  }
  if (isOpenAISdkError(error)) {
    const byCode = KIND_BY_CODE[error.code];
    if (byCode !== undefined) return failed(byCode, error.code);
    if (error.status === 429) return failed("RateLimited", "http-429");
    if (error.status === 401) return failed("AuthenticationFailed", "http-401");
    if (error.status === 403) return failed("AuthorizationFailed", "http-403");
    if (error.status === 400 || error.status === 422) {
      return failed("RequestRejected", `http-${error.status}`);
    }
    if (error.status >= 500) {
      return failed("ProviderUnavailable", `http-${error.status}`);
    }
    return failed("UnknownProviderFailure", error.code);
  }

  const code = rawSafeCode(error);
  const name =
    typeof error === "object" && error !== null
      ? (error as { readonly name?: unknown }).name
      : undefined;
  if (
    (code !== undefined && transportCodes.has(code)) ||
    name === "TypeError"
  ) {
    return failed(
      responseStarted ? "StreamInterrupted" : "TransportFailed",
      code ?? "fetch-transport",
    );
  }
  return failed("UnknownProviderFailure", "unclassified-adapter-error");
};

const cancelledFailure = (): ProviderFailure => ({
  _tag: "ProviderFailure",
  kind: "Cancelled",
  taxonomyVersion: "phase1-v2",
  safeDiagnostic: "provider-call-cancelled",
});

const FINISH_REASON: Record<OpenAISdkFinishReason, ProviderFinishReason> = {
  stop: "Stop",
  length: "MaxOutputTokens",
  tool_calls: "ToolCall",
  content_filter: "ContentFilter",
};

const toCanonical = (
  chunk: Exclude<
    OpenAISdkChunk,
    | { readonly type: "response_started" }
    | { readonly type: "tool_call_delta" }
    | { readonly type: "tool_call_complete" }
  >,
): CanonicalProviderEvent => {
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
        ...(chunk.reasoningTokens !== undefined
          ? { reasoningTokens: chunk.reasoningTokens }
          : {}),
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

const continuationCheckpoint = (
  chunk: Extract<OpenAISdkChunk, { readonly type: "continuation" }>,
): ProviderContinuationCheckpoint => ({
  cursor: chunk.stateRef,
  canonicalEventPrefixJson: "[]",
  deliveredPosition: 0,
  resumeGuaranteed: chunk.resumeGuaranteed === true,
});

const normalizedStream = (
  client: OpenAISdkClient,
  request: PortableModelRequest,
  context: ProviderExecutionContext,
): Stream.Stream<ProviderPortEvent, ProviderFailure> => {
  let responseStarted = false;
  const classifyFailure = (error: unknown): ProviderFailure =>
    context.cancellationSignal.aborted
      ? cancelledFailure()
      : classifyOpenAISdkFailure(error, responseStarted);
  const events = async function* (): AsyncGenerator<ProviderPortEvent> {
    const pendingCalls = new Map<
      string,
      { toolName: string; argumentsJson: string }
    >();
    try {
      for await (const chunk of client.streamChat({
        modelRef: request.modelRef,
        request,
        context,
      })) {
        if (context.cancellationSignal.aborted) return;
        if (chunk.type === "response_started") {
          if (!responseStarted) {
            responseStarted = true;
            yield {
              _tag: "Observation",
              delta: { responseStarted: true },
            };
          }
          continue;
        }
        // Legacy injected SDK clients may not emit an explicit response
        // marker. Their first provider data chunk establishes response start.
        if (!responseStarted) {
          responseStarted = true;
          yield {
            _tag: "Observation",
            delta: { responseStarted: true },
          };
        }
        if (chunk.type === "tool_call_delta") {
          const prior = pendingCalls.get(chunk.callRef) ?? {
            toolName: "",
            argumentsJson: "",
          };
          pendingCalls.set(chunk.callRef, {
            toolName: chunk.toolName ?? prior.toolName,
            argumentsJson: prior.argumentsJson + chunk.argumentsDelta,
          });
          continue;
        }
        if (chunk.type === "tool_call_complete") {
          const assembled = pendingCalls.get(chunk.callRef);
          if (assembled === undefined || assembled.toolName.length === 0) {
            throw new OpenAIProtocolError("tool-call-missing-identity");
          }
          pendingCalls.delete(chunk.callRef);
          yield {
            _tag: "Canonical",
            event: {
              _tag: "ToolCallProposed",
              callRef: chunk.callRef,
              toolName: assembled.toolName,
              argumentsJson: assembled.argumentsJson,
            },
          };
          continue;
        }
        if (chunk.type === "continuation") {
          yield {
            _tag: "Observation",
            delta: { continuationAvailable: true },
            continuationCheckpoint: continuationCheckpoint(chunk),
          };
        }
        yield { _tag: "Canonical", event: toCanonical(chunk) };
      }
      // A clean terminal frame closes any remaining fragmented function-call
      // arguments. An interrupted iterator never reaches this flush.
      if (context.cancellationSignal.aborted) return;
      for (const [callRef, assembled] of pendingCalls) {
        if (assembled.toolName.length === 0) {
          throw new OpenAIProtocolError("tool-call-missing-identity");
        }
        yield {
          _tag: "Canonical",
          event: {
            _tag: "ToolCallProposed",
            callRef,
            toolName: assembled.toolName,
            argumentsJson: assembled.argumentsJson,
          },
        };
      }
    } catch (error) {
      throw classifyFailure(error);
    }
  };
  return Stream.fromAsyncIterable(events(), (error) => classifyFailure(error));
};

export const OpenAIProviderLive = (
  client: OpenAISdkClient,
): Layer.Layer<ProviderPort> =>
  Layer.succeed(
    ProviderPort,
    ProviderPort.of({
      runTurn: ({ request, context }) => {
        const started: ProviderPortEvent = {
          _tag: "Canonical",
          event: {
            _tag: "TurnStarted",
            providerTurnId: context.providerTurnId,
            attemptNo: context.attemptNo,
            modelRef: request.modelRef,
          },
        };
        const preflight: ProviderPortEvent = {
          _tag: "Observation",
          delta: {
            responseStarted: false,
            // Model inference does not execute the proposed tool calls. The
            // client declares provider-side effects before request dispatch.
            externalEffectPossible: client.externalEffectPossible,
          },
        };
        return Stream.concat(
          Stream.fromIterable([started, preflight]),
          normalizedStream(client, request, context),
        );
      },
    }),
  );

/**
 * P16 `01` §2/§6: the OpenAI-compatible family's `ProtocolAdapter`
 * registration value. `layerFor` accepts:
 *  - `transportOverride` = full `OpenAISdkClient` (test injection), or
 *  - `transportOverride` = `{ fetch?, allowUnauthenticated? }` layered over
 *    `OpenAICompatibleFetchClient({ baseUrl: endpoint, model: wireModelName })`.
 */
export const providerOpenaiAdapter: ProtocolAdapter = {
  adapterId: "provider-openai",
  profile: {
    protocolFamily: "openai-chat-completions-sse",
    authMode: { _tag: "BearerSecret" },
    capabilityFlags: {
      // R2 (D1 remediation): the adapter extracts prompt_cache_hit_tokens
      // (native read dimension; write stays absent). Declaration now matches
      // actual extraction.
      reportsCacheTokens: true,
      supportsContinuation: false,
      streamsDeltas: true,
    },
    failureTaxonomy: "phase1-v2",
  },
  layerFor: (binding) => {
    const override = binding.transportOverride;
    if (override !== undefined && isSdkClient(override)) {
      return OpenAIProviderLive(override);
    }
    const overrides = (override ?? {}) as {
      fetch?: unknown;
      allowUnauthenticated?: boolean;
    };
    return OpenAIProviderLive(
      OpenAICompatibleFetchClient({
        baseUrl: binding.endpoint ?? "",
        ...(binding.wireModelName !== undefined
          ? { model: binding.wireModelName }
          : {}),
        ...(binding.extraHeaders !== undefined
          ? { extraHeaders: headersOf(binding.extraHeaders) }
          : {}),
        ...(overrides.fetch !== undefined
          ? { fetch: overrides.fetch as OpenAICompatibleFetch }
          : {}),
        ...(overrides.allowUnauthenticated === true
          ? { allowUnauthenticated: true }
          : {}),
      }),
    );
  },
};

const isSdkClient = (value: unknown): value is OpenAISdkClient =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as OpenAISdkClient).streamChat === "function";

const headersOf = (
  extra: ReadonlyArray<Record<string, string>>,
): Record<string, string> => Object.assign({}, ...extra);
