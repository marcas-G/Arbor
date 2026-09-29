import type {
  PortableModelRequest,
  ProviderExecutionContext,
} from "@arbor/ports";

/** Raw SDK error type. Only status/code are retained in safe diagnostics. */
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

/** Explicit adapter marker for malformed protocol data. */
export class OpenAIProtocolError extends Error {
  constructor(readonly safeCode: string) {
    super("provider response violated the declared wire protocol");
    this.name = "OpenAIProtocolError";
  }
}

export type OpenAISdkFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter";

/** SDK-neutral input to the Provider Adapter. The production/test transport
 * reports `response_started` as soon as response headers are available. */
export type OpenAISdkChunk =
  | { readonly type: "response_started" }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly callRef: string;
      readonly toolName: string;
      readonly argumentsJson: string;
    }
  | {
      readonly type: "tool_call_delta";
      readonly callRef: string;
      readonly toolName?: string;
      readonly argumentsDelta: string;
    }
  | { readonly type: "tool_call_complete"; readonly callRef: string }
  | {
      readonly type: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
      /** Provider-reported reasoning tokens (Gate C C1); absent = unknown. */
      readonly reasoningTokens?: number;
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
    }
  | {
      readonly type: "continuation";
      readonly stateRef: string;
      readonly resumeGuaranteed?: boolean;
    }
  | {
      readonly type: "completed";
      readonly finishReason: OpenAISdkFinishReason;
    };

export interface OpenAISdkClient {
  /** Explicit provider-side effect classification. This must be reported and
   * persisted before the transport client can send request bytes. */
  readonly externalEffectPossible: boolean;
  readonly streamChat: (input: {
    readonly modelRef: string;
    readonly request: PortableModelRequest;
    readonly context: ProviderExecutionContext;
  }) => AsyncIterable<OpenAISdkChunk>;
}
