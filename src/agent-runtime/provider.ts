import { Context, Data, type Effect } from "effect";

export class ModelError extends Data.TaggedError("ModelError")<{ message: string }> {}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string; // JSON string; the agent loop owns decoding
}

export type FinishReason = "stop" | "tool-calls" | "length";

/** A4 (D-032): Arbor-owned normalized provider turn. Never raw provider JSON. */
export interface ModelTurn {
  readonly content: string | undefined;
  readonly toolCalls: ReadonlyArray<ToolCall>;
  readonly finishReason: FinishReason;
}

export type ChatMessage =
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content?: string | undefined;
      readonly toolCalls?: ReadonlyArray<ToolCall> | undefined;
    }
  | { readonly role: "tool"; readonly toolCallId: string; readonly content: string };

export interface ModelToolSpec {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: object;
}

export interface ModelRequest {
  readonly system: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly tools?: ReadonlyArray<ModelToolSpec> | undefined;
}

export interface ModelPort {
  readonly complete: (req: ModelRequest) => Effect.Effect<ModelTurn, ModelError>;
}

export const ModelPort = Context.Service<ModelPort>("agent-runtime/ModelPort");
