import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { Virtuoso } from "react-virtuoso";
import { useViewQuery } from "../../api/useViewQuery.js";
import { SubmitHumanMessageForm } from "../../commands/forms/SubmitHumanMessageForm.js";
import { Empty } from "../../components/Empty.js";
import type { ConversationMessage } from "../../conversation/store.js";
import { useConversation } from "../../conversation/useConversation.js";
import { presentResponsibilityTree } from "../tree/treePresentation.js";
import styles from "./workspace.module.css";

/**
 * Conversation face (frontend rework 2026-09-29): one message-level store
 * (streaming preview and authoritative answer are phases of the SAME
 * record — atomic swap, no blank gap) + a virtualized list with native
 * follow/anchor behavior (no manual scroll math, no reflow jumps).
 */
function MessageRow({ message }: { readonly message: ConversationMessage }) {
  const pending = message.phase === "optimistic";
  const live = message.phase === "streaming" || message.phase === "settling";
  const body =
    message.text !== ""
      ? message.text
      : (message.statusNote ??
        (message.phase === "streaming"
          ? "正在生成…"
          : message.phase === "settling"
            ? "正在保存回复…"
            : ""));
  return (
    <div
      className={`arbor-conversation-turn arbor-conversation-${
        message.role === "human" ? "human" : "assistant"
      }`}
      data-phase={message.phase}
      style={pending ? { opacity: 0.72 } : undefined}
    >
      <span className="arbor-conversation-author">
        {message.role === "human" ? "你" : "Arbor"}
      </span>
      <span className="arbor-conversation-body">{body}</span>
    </div>
  );
}

export function ConversationTab({
  projectId,
  workspaceId,
}: {
  readonly projectId: string;
  readonly workspaceId: string;
}) {
  const queryClient = useQueryClient();
  const tree = useViewQuery("responsibility-tree", {
    projectId: projectId as never,
  });
  const presented =
    tree.data === undefined
      ? undefined
      : presentResponsibilityTree(tree.data.nodes);
  const isRoot = presented?.root.workspaceId === workspaceId;

  const invalidateViews = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["view", "transcript"] });
  }, [queryClient]);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const pinnedWorkspaceRef = useRef<string | null>(null);
  const conversation = useConversation(
    "local",
    ["view", "transcript", workspaceId],
    async (cursor) => {
      const res = await fetch("/views/transcript", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          limit: 50,
          conversationOnly: true,
          ...(cursor !== undefined ? { cursor } : {}),
        }),
      });
      const json = (await res.json()) as {
        readonly ok: boolean;
        readonly body?:
          | {
              readonly value?: {
                readonly entries?: unknown[];
                readonly nextCursor?: string;
              };
            }
          | { readonly entries?: unknown[]; readonly nextCursor?: string };
      };
      const value = (json.body as { readonly value?: unknown } | undefined)
        ?.value;
      const page =
        value !== undefined && value !== null
          ? (value as { entries?: unknown[]; nextCursor?: string })
          : (json.body as
              | { entries?: unknown[]; nextCursor?: string }
              | undefined);
      return {
        entries: (page?.entries ?? []) as Array<{
          kind: string;
          messageId?: string;
          body?: string;
          occurredAt?: string;
        }>,
        nextCursor: page?.nextCursor,
      };
    },
    isRoot,
    invalidateViews,
  );

  return (
    <div className={styles.conversation}>
      <p className={styles.conversationLabel}>
        {isRoot ? "根工作区对话" : "对话记录（只读）"}
      </p>
      {conversation.loadingHistory && conversation.messages.length === 0 ? (
        <Empty>加载中</Empty>
      ) : conversation.historyError !== null &&
        conversation.messages.length === 0 ? (
        <Empty>会话记录暂不可用</Empty>
      ) : conversation.messages.length === 0 ? (
        <Empty>无会话记录</Empty>
      ) : (
        <Virtuoso
          ref={virtuosoRef}
          style={{
            height: "min(64vh, 48rem)",
            minHeight: "15rem",
            overflowX: "hidden",
          }}
          data={conversation.messages}
          computeItemKey={(_, message) => message.key}
          initialTopMostItemIndex={Math.max(
            0,
            conversation.messages.length - 1,
          )}
          followOutput={"smooth"}
          increaseViewportBy={{ top: 600, bottom: 600 }}
          startReached={() => {
            conversation.loadOlder?.();
          }}
          components={{
            Header: () =>
              conversation.olderFetching ? (
                <p className={styles.historyLoading}>正在加载更早的消息…</p>
              ) : null,
          }}
          itemContent={(_, message) => <MessageRow message={message} />}
        />
      )}
      {(() => {
        // Initial data lands asynchronously; initialTopMostItemIndex alone
        // only covers the empty first frame. Jump ONCE per workspace when
        // history arrives so the newest turn is visible; followOutput owns
        // every later append (it never drags the user back down while they
        // scroll up).
        if (
          conversation.messages.length > 0 &&
          pinnedWorkspaceRef.current !== workspaceId
        ) {
          pinnedWorkspaceRef.current = workspaceId;
          queueMicrotask(() => {
            virtuosoRef.current?.scrollToIndex({
              index: conversation.messages.length - 1,
              align: "end",
              behavior: "auto",
            });
          });
        }
        return null;
      })()}
      {isRoot ? (
        <div className={styles.composer}>
          <SubmitHumanMessageForm
            actor="user:local"
            token={undefined}
            projectId={projectId}
            targetWorkspaceId={workspaceId}
            onMessageSubmitted={(messageId, body) => {
              conversation.submit(messageId, body.trim());
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
