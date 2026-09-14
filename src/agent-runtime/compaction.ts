import type { ChatMessage } from "./provider.js";

/** P1-06A (D-036): deterministic mechanical compaction — a derived cache.
 * Messages beyond `keepTail` are replaced by one compacted-context message;
 * the summary is a plain concatenation of prior textual content, truncated.
 * No LLM involved: the same input always produces the same compaction, so a
 * lost compaction file is rebuilt from the transcript by re-running this. */

export interface CompactionPlan {
  readonly droppedCount: number;
  readonly coveredFrom: number; // index of first dropped message
  readonly coveredTo: number; // index of last dropped message (exclusive end)
  readonly summaryText: string;
  readonly kept: ReadonlyArray<ChatMessage>;
}

export const DEFAULT_THRESHOLD = 80;
export const DEFAULT_KEEP_TAIL = 20;
const SUMMARY_CHAR_LIMIT = 4000;

export function compactMessages(
  messages: ReadonlyArray<ChatMessage>,
  threshold: number = DEFAULT_THRESHOLD,
  keepTail: number = DEFAULT_KEEP_TAIL,
): CompactionPlan | null {
  if (messages.length <= threshold) {
    return null;
  }
  const cut = messages.length - keepTail;
  const dropped = messages.slice(0, cut);
  const parts: string[] = [];
  for (const m of dropped) {
    if (m.role === "user") {
      parts.push(`user: ${m.content}`);
    } else if (m.role === "assistant" && m.content !== undefined) {
      parts.push(`assistant: ${m.content}`);
    } else if (m.role === "tool") {
      parts.push(`tool(${m.toolCallId}): ${m.content.slice(0, 200)}`);
    }
  }
  let summary = parts.join("\n");
  if (summary.length > SUMMARY_CHAR_LIMIT) {
    summary = `${summary.slice(0, SUMMARY_CHAR_LIMIT)}\n[truncated]`;
  }
  return {
    droppedCount: dropped.length,
    coveredFrom: 0,
    coveredTo: cut,
    summaryText: summary,
    kept: [
      {
        role: "user",
        content: `[earlier context compacted — mechanical summary of ${dropped.length} messages]\n${summary}`,
      },
      ...messages.slice(cut),
    ],
  };
}
