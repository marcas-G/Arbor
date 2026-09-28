/**
 * Ephemeral progress for a root Human Conversation. These frames are a
 * presentation preview only; the transcript read model remains the canonical
 * source for completed answers.
 */
export type ConversationStreamEvent =
  | {
      readonly type: "started";
      readonly executionId: string;
      readonly providerTurnId: string;
      readonly attemptNo: number;
    }
  | {
      readonly type: "delta";
      readonly executionId: string;
      readonly providerTurnId: string;
      readonly attemptNo: number;
      readonly text: string;
    }
  | {
      readonly type: "reset";
      readonly executionId?: string;
      readonly providerTurnId?: string;
      readonly reason:
        | "provider-retry"
        | "model-repair"
        | "action-turn"
        | "history-gap";
    }
  | {
      readonly type: "retrying";
      readonly executionId: string;
      readonly attemptNo: number;
    }
  | { readonly type: "ready"; readonly executionId: string }
  | { readonly type: "settled"; readonly executionId?: string }
  | { readonly type: "interrupted"; readonly executionId?: string };

export interface ConversationStreamFrame {
  /** Monotonic within one message stream; also used as the SSE event id. */
  readonly sequence: number;
  readonly event: ConversationStreamEvent;
}
