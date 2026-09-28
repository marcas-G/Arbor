import type { ConversationStreamEvent } from "@arbor/api-contracts";

export interface ConversationProgressHandlers {
  readonly onEvent: (event: ConversationStreamEvent) => void;
}

const parseEvent = (data: string): ConversationStreamEvent | null => {
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as ConversationStreamEvent)
      : null;
  } catch {
    return null;
  }
};

export const streamConversationProgress = async (
  messageId: string,
  token: string,
  handlers: ConversationProgressHandlers,
  signal: AbortSignal,
): Promise<void> => {
  const response = await fetch(
    `/conversation-progress/${encodeURIComponent(messageId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    },
  );
  if (!response.ok || response.body === null) {
    throw new Error(`conversation progress unavailable (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), {
        stream: !chunk.done,
      });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        const event = parseEvent(data);
        if (event !== null) {
          handlers.onEvent(event);
        }
      }
      if (chunk.done) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
};
