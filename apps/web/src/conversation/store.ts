/**
 * Conversation message store (frontend rework 2026-09-29).
 *
 * Single source of truth per workspace at the MESSAGE level — the streaming
 * preview and the authoritative transcript answer are the SAME record in two
 * phases, so the swap is atomic and position-stable (no blank gap, no list
 * reflow). Transcript pages MERGE (never wholesale-replace), so scroll
 * anchors and DOM keys survive refetches.
 */

export interface ConversationMessage {
  /** Stable identity: `h:<messageId>` / `a:<messageId>`. */
  readonly key: string;
  readonly role: "human" | "assistant";
  /** Human message id; the assistant phase carries the same id (one turn). */
  readonly messageId: string;
  readonly text: string;
  readonly occurredAt: string;
  /** authoritative = from the transcript projection; otherwise live. */
  readonly phase: "authoritative" | "streaming" | "settling" | "optimistic";
  readonly statusNote?: string;
}

type Listener = () => void;

export interface ConversationStore {
  readonly subscribe: (listener: Listener) => () => void;
  readonly snapshot: () => ReadonlyArray<ConversationMessage>;
  /** Merge an authoritative transcript page (oldest→newest) without
   * disturbing live phases for messages the page does not cover. */
  readonly applyTranscript: (
    entries: ReadonlyArray<{
      readonly kind: string;
      readonly messageId?: string;
      readonly body?: string;
      readonly occurredAt?: string;
      readonly summaryRef?: string;
    }>,
  ) => void;
  /** Optimistically insert the human turn at submit time. */
  readonly addOptimisticHuman: (messageId: string, text: string) => void;
  /** SSE lifecycle for the assistant phase of a message. */
  readonly beginStream: (messageId: string) => void;
  readonly appendDelta: (messageId: string, text: string) => void;
  readonly resetStream: (messageId: string) => void;
  readonly markRetrying: (messageId: string) => void;
  readonly markSettling: (messageId: string) => void;
  readonly markUnavailable: (messageId: string) => void;
  /** Drop live phases older than the given boundary (idempotent cleanup). */
  readonly reapLive: (answeredMessageIds: ReadonlySet<string>) => void;
}

export const createConversationStore = (): ConversationStore => {
  let messages: ConversationMessage[] = [];
  const listeners = new Set<Listener>();
  const emit = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  const indexOfMessage = (messageId: string): number =>
    messages.findIndex((message) => message.messageId === messageId);
  const assistantIndex = (messageId: string): number =>
    messages.findIndex(
      (message) =>
        message.messageId === messageId && message.role === "assistant",
    );

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => messages,

    applyTranscript: (entries) => {
      // Merge BY IDENTITY over the current list: a page (latest or older)
      // updates/replaces matching turns in place and inserts unknown turns
      // positioned by occurredAt. Existing turns are NEVER dropped — an
      // older page prepends, a latest page refreshes/appends.
      const incoming: ConversationMessage[] = [];
      for (const entry of entries) {
        if (
          entry.kind === "HumanConversationTurn" &&
          entry.messageId !== undefined
        ) {
          incoming.push({
            key: `h:${entry.messageId}`,
            role: "human",
            messageId: entry.messageId,
            text: entry.body ?? "",
            occurredAt: entry.occurredAt ?? "",
            phase: "authoritative",
          });
          continue;
        }
        if (
          entry.kind === "AssistantConversationTurn" &&
          entry.messageId !== undefined
        ) {
          const existing = messages.find(
            (message) =>
              message.messageId === entry.messageId &&
              message.role === "assistant",
          );
          // A live phase with content keeps its slot; the reap swaps it once
          // the authoritative answer lands.
          if (
            existing !== undefined &&
            existing.phase !== "authoritative" &&
            existing.text !== ""
          ) {
            incoming.push(existing);
            continue;
          }
          incoming.push({
            key: `a:${entry.messageId}`,
            role: "assistant",
            messageId: entry.messageId,
            text: entry.body ?? "",
            occurredAt: entry.occurredAt ?? "",
            phase: "authoritative",
          });
          continue;
        }
        // Legacy session-entry arm: read-only marker (summaryRef is its
        // display text).
        incoming.push({
          key: `x:${entry.occurredAt ?? ""}:${incoming.length}`,
          role: "assistant",
          messageId: `legacy-${incoming.length}`,
          text:
            entry.body ??
            (entry as { readonly summaryRef?: string }).summaryRef ??
            entry.kind,
          occurredAt: entry.occurredAt ?? "",
          phase: "authoritative",
        });
      }
      const merged = [...messages];
      for (const message of incoming) {
        const index = merged.findIndex(
          (candidate) => candidate.key === message.key,
        );
        if (index >= 0) {
          merged[index] = message;
        } else {
          merged.push(message);
        }
      }
      const timeOf = (message: ConversationMessage): number =>
        Number.isFinite(Date.parse(message.occurredAt))
          ? Date.parse(message.occurredAt)
          : 0;
      // Stable by time; ties keep insertion order (page order is
      // chronological, so older-page prepends land above current turns).
      merged.sort((a, b) => timeOf(a) - timeOf(b));
      messages = merged;
      emit();
    },

    addOptimisticHuman: (messageId, text) => {
      if (indexOfMessage(messageId) !== -1) {
        return;
      }
      messages = [
        ...messages,
        {
          key: `h:${messageId}`,
          role: "human",
          messageId,
          text,
          occurredAt: new Date().toISOString(),
          phase: "optimistic",
        },
      ];
      emit();
    },

    beginStream: (messageId) => {
      messages = [
        ...messages.filter(
          (message) =>
            !(message.messageId === messageId && message.role === "assistant"),
        ),
        {
          key: `a:${messageId}`,
          role: "assistant",
          messageId,
          text: "",
          occurredAt: new Date().toISOString(),
          phase: "streaming",
        },
      ];
      emit();
    },

    appendDelta: (messageId, text) => {
      const index = assistantIndex(messageId);
      if (index === -1) {
        return;
      }
      const current = messages[index] as ConversationMessage;
      messages = [
        ...messages.slice(0, index),
        { ...current, text: `${current.text}${text}` },
        ...messages.slice(index + 1),
      ];
      emit();
    },

    resetStream: (messageId) => {
      const index = assistantIndex(messageId);
      if (index === -1) {
        return;
      }
      const current = messages[index] as ConversationMessage;
      messages = [
        ...messages.slice(0, index),
        { ...current, text: "" },
        ...messages.slice(index + 1),
      ];
      emit();
    },

    markRetrying: (messageId) => {
      const index = assistantIndex(messageId);
      if (index === -1) {
        return;
      }
      const current = messages[index] as ConversationMessage;
      messages = [
        ...messages.slice(0, index),
        { ...current, text: "", phase: "streaming", statusNote: "正在重试…" },
        ...messages.slice(index + 1),
      ];
      emit();
    },

    markSettling: (messageId) => {
      const index = assistantIndex(messageId);
      if (index === -1) {
        return;
      }
      const current = messages[index] as ConversationMessage;
      messages = [
        ...messages.slice(0, index),
        { ...current, phase: "settling" },
        ...messages.slice(index + 1),
      ];
      emit();
    },

    markUnavailable: (messageId) => {
      const index = assistantIndex(messageId);
      if (index === -1) {
        return;
      }
      const current = messages[index] as ConversationMessage;
      messages = [
        ...messages.slice(0, index),
        { ...current, statusNote: "实时预览暂不可用，等待正式回复…" },
        ...messages.slice(index + 1),
      ];
      emit();
    },

    reapLive: (answeredMessageIds) => {
      const next = messages.filter(
        (message) =>
          message.phase === "authoritative" ||
          !answeredMessageIds.has(message.messageId),
      );
      if (next.length !== messages.length) {
        messages = next;
        emit();
      }
    },
  };
};
