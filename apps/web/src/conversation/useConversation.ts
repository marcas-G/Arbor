import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { streamConversationProgress } from "../data/conversation-progress.js";
import { type ConversationMessage, createConversationStore } from "./store.js";

/**
 * Conversation data integration: transcript pages (TanStack Query) merge into
 * a message-level store; SSE deltas write the same records. The component
 * sees ONE stable list — preview and answer are phases of the same record.
 */
export interface UseConversationResult {
  readonly messages: ReadonlyArray<ConversationMessage>;
  readonly loadingHistory: boolean;
  readonly historyError: unknown;
  readonly olderFetching: boolean;
  readonly loadOlder: (() => void) | undefined;
  readonly streamMessageId: string | null;
  readonly submit: (messageId: string, text: string) => void;
}

export const useConversation = (
  token: string,
  queryKey: readonly unknown[],
  fetchTranscript: (cursor: string | undefined) => Promise<{
    readonly entries: ReadonlyArray<{
      readonly kind: string;
      readonly messageId?: string;
      readonly body?: string;
      readonly occurredAt?: string;
      readonly summaryRef?: string;
    }>;
    readonly nextCursor?: string | undefined;
  }>,
  streamEnabled: boolean,
  invalidateViews: () => void,
): UseConversationResult => {
  const queryClient = useQueryClient();
  const store = useMemo(() => createConversationStore(), []);
  const messages = useSyncExternalStore(store.subscribe, store.snapshot);

  const latest = useQuery({
    queryKey,
    queryFn: () => fetchTranscript(undefined),
  });
  const older = useQuery({
    queryKey: [...queryKey, "older"],
    queryFn: () => fetchTranscript(latest.data?.nextCursor),
    enabled: false,
  });

  // Merge authoritative pages (latest + any loaded older page) into the
  // store; order within a page is authoritative, live phases survive.
  useEffect(() => {
    if (latest.data !== undefined) {
      store.applyTranscript(latest.data.entries);
      store.reapLive(
        new Set(
          latest.data.entries
            .filter((entry) => entry.kind === "AssistantConversationTurn")
            .map((entry) => entry.messageId ?? ""),
        ),
      );
    }
  }, [latest.data, store]);
  useEffect(() => {
    if (older.data !== undefined) {
      store.applyTranscript(older.data.entries);
    }
  }, [older.data, store]);

  // The live assistant message the SSE stream should attach to. Derived
  // WITHOUT triggering the effect on every delta (effect deps are the id,
  // not the messages array).
  const streamMessageId =
    messages.find(
      (message) =>
        message.phase !== "authoritative" && message.role === "assistant",
    )?.messageId ?? null;

  // SSE lifecycle → store writes (never clears the preview on settle).
  useEffect(() => {
    if (!streamEnabled || streamMessageId === null) {
      return;
    }
    const controller = new AbortController();
    void streamConversationProgress(
      streamMessageId,
      token,
      {
        onEvent: (event) => {
          switch (event.type) {
            case "started":
              store.beginStream(streamMessageId);
              break;
            case "delta":
              store.appendDelta(streamMessageId, event.text);
              break;
            case "reset":
              store.resetStream(streamMessageId);
              break;
            case "retrying":
              store.markRetrying(streamMessageId);
              break;
            case "ready":
              store.markSettling(streamMessageId);
              break;
            case "settled":
            case "interrupted":
              store.markSettling(streamMessageId);
              // The authoritative answer arrives via the transcript
              // refetch; the reap above swaps it in atomically.
              invalidateViews();
              break;
          }
        },
      },
      controller.signal,
    ).catch(() => {
      if (!controller.signal.aborted) {
        store.markUnavailable(streamMessageId);
      }
    });
    return () => controller.abort();
  }, [streamEnabled, streamMessageId, store, invalidateViews, token]);

  const loadOlder = (() => {
    if (older.isFetching) {
      return undefined;
    }
    return latest.data?.nextCursor !== undefined
      ? () => older.refetch()
      : undefined;
  })();

  return {
    messages,
    loadingHistory: latest.isPending,
    historyError: latest.isError ? latest.error : null,
    olderFetching: older.isFetching,
    loadOlder,
    streamMessageId,
    submit: (messageId, text) => {
      store.addOptimisticHuman(messageId, text);
      store.beginStream(messageId);
      void queryClient.invalidateQueries({ queryKey });
    },
  };
};
