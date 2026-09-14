import type { TranscriptEnvelope } from "../domain/transcript-events.js";
import type { ChatMessage } from "./provider.js";

/** E5: rebuild the message array by full replay of durable transcript events.
 * An unfinished trailing turn is simply not present — that is the semantic
 * resume boundary (incomplete model turns are not committed). */
export function replayMessages(events: ReadonlyArray<TranscriptEnvelope>): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const e of events) {
    if (e.type === "user_input") {
      messages.push({ role: "user", content: (e.payload as { text: string }).text });
    } else if (e.type === "model_turn_committed") {
      const p = e.payload as {
        content?: string;
        toolCalls: Array<{ id: string; name: string; arguments: string }>;
      };
      messages.push({
        role: "assistant",
        ...(p.content !== undefined ? { content: p.content } : {}),
        ...(p.toolCalls.length > 0 ? { toolCalls: p.toolCalls } : {}),
      });
    } else if (e.type === "tool_result") {
      const p = e.payload as { callId: string; output: string; ok: boolean };
      messages.push({
        role: "tool",
        toolCallId: p.callId,
        content: p.ok ? p.output : `ERROR: ${p.output}`,
      });
    }
  }
  return messages;
}

/** True when a started run was never closed by run_finished — this covers
 * BOTH graceful pause (pause_marker) and hard crash (no marker at all, e.g.
 * SIGKILL): recovery replays the durable events either way (E5 semantic
 * resume; an incomplete trailing model turn was never committed). */
export function isResumable(events: ReadonlyArray<TranscriptEnvelope>): boolean {
  if (events.length === 0) {
    return false;
  }
  const lastFinishIdx = (() => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i]?.type === "run_finished") {
        return i;
      }
    }
    return -1;
  })();
  return events.slice(lastFinishIdx + 1).some((e) => e.type === "user_input");
}

/** SIGINT pause controller (E4): flag + abort channel; the loop checks the
 * flag between steps and the model call is aborted mid-flight. */
export class PauseController {
  private flagged = false;
  readonly abort = new AbortController();

  requestPause(): void {
    this.flagged = true;
    this.abort.abort();
  }

  get paused(): boolean {
    return this.flagged;
  }
}

export function installSigintPause(onPause: () => void): () => void {
  const handler = () => onPause();
  process.on("SIGINT", handler);
  return () => {
    process.off("SIGINT", handler);
  };
}
