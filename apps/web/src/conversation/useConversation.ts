/**
 * The conversation timeline is a server projection. Pages are retained only
 * in TanStack Query; the browser never manufactures a message or merges a
 * streaming preview over an authoritative turn.
 */
import type {
  ConversationResponseStatus,
  TranscriptEntry,
  TranscriptRes,
} from "@arbor/api-contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { fetchView } from "../api/transport.js";
import { useSession } from "../session/SessionContext.js";

export interface ConversationMessage {
  readonly key: string;
  readonly role: "human" | "assistant";
  readonly messageId?: string | undefined;
  readonly body: string;
  readonly occurredAt: string;
  readonly responseStatus?: ConversationResponseStatus;
}

const toMessage = (
  entry: TranscriptEntry,
  index: number,
): ConversationMessage => {
  if (entry.kind === "HumanConversationTurn" && "messageId" in entry) {
    return {
      key: `h:${entry.messageId}`,
      role: "human",
      messageId: entry.messageId,
      body: entry.body,
      occurredAt: entry.occurredAt,
      ...(entry.responseStatus === undefined
        ? {}
        : { responseStatus: entry.responseStatus }),
    };
  }
  if (entry.kind === "AssistantConversationTurn" && "executionId" in entry) {
    return {
      key: `a:${entry.messageId ?? entry.executionId}`,
      role: "assistant",
      ...(entry.messageId === undefined ? {} : { messageId: entry.messageId }),
      body: entry.body,
      occurredAt: entry.occurredAt,
    };
  }
  const legacy = entry as Extract<
    TranscriptEntry,
    { readonly summaryRef: string }
  >;
  return {
    key: `x:${legacy.at}:${index}`,
    role: "assistant",
    body: legacy.summaryRef,
    occurredAt: legacy.at,
  };
};

/** Root-first pages return newest history. Reversing the loaded page sequence
 * produces one chronological list without locally changing any entry. */
export const useConversation = (workspaceId: string) => {
  const { token, reportUnauthenticated } = useSession();
  const transcript = useInfiniteQuery({
    queryKey: ["view", "transcript", "conversation", workspaceId],
    enabled: token !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchView(
        "transcript",
        {
          workspaceId: workspaceId as never,
          limit: 50,
          conversationOnly: true,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
        { token, signal, onUnauthenticated: reportUnauthenticated },
      ).then((outcome) => {
        if (!outcome.ok) {
          throw outcome.problem;
        }
        return outcome.dto as TranscriptRes;
      }),
    getNextPageParam: (page) => page.nextCursor,
  });

  const messages = useMemo(
    () =>
      [...(transcript.data?.pages ?? [])]
        .reverse()
        .flatMap((page) => page.entries)
        .map(toMessage),
    [transcript.data],
  );

  return {
    messages,
    loadingHistory: transcript.isPending,
    historyError: transcript.isError ? transcript.error : null,
    olderFetching: transcript.isFetchingNextPage,
    loadOlder: transcript.hasNextPage
      ? () => {
          void transcript.fetchNextPage();
        }
      : undefined,
    retryHistory: () => {
      void transcript.refetch();
    },
  };
};
