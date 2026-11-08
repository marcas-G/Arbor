import type { ConversationStreamEvent } from "@arbor/api-contracts";
import { useEffect, useMemo, useState } from "react";
import { useSession } from "../session/SessionContext.js";

export interface ConversationProgressState {
  readonly text: string;
  readonly stage:
    | "connecting"
    | "thinking"
    | "answering"
    | "tool"
    | "retrying"
    | "done"
    | "error";
  readonly toolNames: ReadonlyArray<string>;
  readonly attemptNo: number | null;
}

const initialState = (): ConversationProgressState => ({
  text: "",
  stage: "connecting",
  toolNames: [],
  attemptNo: null,
});

/**
 * Presentation-only SSE preview for one human message. The transcript query
 * remains authoritative; this hook is discarded as soon as the answer lands.
 * It deliberately accepts only safe stage markers and text deltas, never
 * model reasoning content.
 */
export function useConversationProgress(
  messageId: string | undefined,
  enabled: boolean,
): ConversationProgressState | null {
  const { token } = useSession();
  const [state, setState] = useState<ConversationProgressState | null>(null);

  useEffect(() => {
    if (!enabled || messageId === undefined || token === null) {
      setState(null);
      return;
    }
    const controller = new AbortController();
    setState(initialState());
    let active = true;
    let lastEventId = 0;

    const consume = async (): Promise<void> => {
      try {
        const headers: Record<string, string> = {
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
        };
        if (lastEventId > 0) headers["Last-Event-ID"] = String(lastEventId);
        const response = await fetch(
          `/conversation-progress/${encodeURIComponent(messageId)}`,
          {
            headers,
            signal: controller.signal,
          },
        );
        if (!response.ok || response.body === null) {
          if (active)
            setState((previous) =>
              previous === null
                ? { ...initialState(), stage: "error" }
                : previous,
            );
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const apply = (event: ConversationStreamEvent): void => {
          if (!active) return;
          setState((previous) => {
            const current = previous ?? initialState();
            switch (event.type) {
              case "started":
                return {
                  ...current,
                  stage: "thinking",
                  attemptNo: event.attemptNo,
                };
              case "thinking":
                return {
                  ...current,
                  stage: "thinking",
                  attemptNo: event.attemptNo,
                };
              case "delta":
                return {
                  ...current,
                  stage: "answering",
                  attemptNo: event.attemptNo,
                  text: current.text + event.text,
                };
              case "tool-started":
                return {
                  ...current,
                  stage: "tool",
                  attemptNo: event.attemptNo,
                  toolNames: current.toolNames.includes(event.toolName)
                    ? current.toolNames
                    : [...current.toolNames, event.toolName],
                };
              case "retrying":
                return {
                  ...current,
                  stage: "retrying",
                  attemptNo: event.attemptNo,
                };
              case "ready":
              case "settled":
                return { ...current, stage: "done" };
              case "interrupted":
                return { ...current, stage: "error" };
              case "reset":
                return {
                  ...current,
                  text: "",
                  toolNames: [],
                  stage: "thinking",
                };
            }
          });
        };
        while (!controller.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            let id: number | null = null;
            let data = "";
            for (const line of frame.split("\n")) {
              if (line.startsWith("id:")) id = Number(line.slice(3).trim());
              if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (id !== null && Number.isFinite(id)) lastEventId = id;
            if (data.length > 0) {
              try {
                apply(JSON.parse(data) as ConversationStreamEvent);
              } catch {
                /* ignore malformed preview frame */
              }
            }
          }
        }
      } catch (error) {
        if (
          active &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          setState((previous) =>
            previous === null
              ? { ...initialState(), stage: "error" }
              : previous,
          );
        }
      }
    };
    void consume();
    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, messageId, token]);

  return useMemo(() => state, [state]);
}
