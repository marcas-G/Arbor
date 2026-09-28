import type {
  PortableModelRequest,
  ProviderExecutionContext,
} from "@arbor/ports";

/** Raw SDK/transport error, translated before crossing the ProviderPort edge. */
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

/** Injectable seam keeps adapter tests independent of live APIs. */
export interface OpenAISdkClient {
  readonly streamChat: (input: {
    readonly modelRef: string;
    readonly request: PortableModelRequest;
    readonly context: ProviderExecutionContext;
  }) => AsyncIterable<OpenAISdkChunk>;
}
