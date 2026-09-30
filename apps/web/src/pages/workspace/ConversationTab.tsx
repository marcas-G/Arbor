import { useRef } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { Virtuoso } from "react-virtuoso";
import { useViewQuery } from "../../api/useViewQuery.js";
import { SubmitHumanMessageForm } from "../../commands/forms/SubmitHumanMessageForm.js";
import { Empty } from "../../components/Empty.js";
import {
  type ConversationMessage,
  useConversation,
} from "../../conversation/useConversation.js";
import { ProblemCard } from "../../problems/ProblemCard.js";
import { useSession } from "../../session/SessionContext.js";
import { presentResponsibilityTree } from "../tree/treePresentation.js";
import styles from "./workspace.module.css";

/** The browser displays one server-authoritative conversation timeline. */
function MessageRow({ message }: { readonly message: ConversationMessage }) {
  return (
    <div
      className={`arbor-conversation-turn arbor-conversation-${
        message.role === "human" ? "human" : "assistant"
      }`}
      data-phase="authoritative"
    >
      <span className="arbor-conversation-author">
        {message.role === "human" ? "你" : "Arbor"}
      </span>
      <span className="arbor-conversation-body">{message.body}</span>
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
  const { actor, token } = useSession();
  const tree = useViewQuery("responsibility-tree", {
    projectId: projectId as never,
  });
  const presented =
    tree.data === undefined
      ? undefined
      : presentResponsibilityTree(tree.data.nodes);
  const isRoot = presented?.root.workspaceId === workspaceId;
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const pinnedWorkspaceRef = useRef<string | null>(null);
  const conversation = useConversation(workspaceId);
  const answeredMessageIds = new Set(
    conversation.messages.flatMap((message) =>
      message.role === "assistant" && message.messageId !== undefined
        ? [message.messageId]
        : [],
    ),
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
        <ProblemCard
          problem={conversation.historyError as never}
          onRetry={conversation.retryHistory}
        />
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
          followOutput="smooth"
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
          itemContent={(_, message) => (
            <>
              <MessageRow message={message} />
              {message.role === "human" &&
              message.messageId !== undefined &&
              !answeredMessageIds.has(message.messageId) ? (
                <p className={styles.conversationStatus} role="status">
                  <strong>正在处理</strong>
                  <span>已提交。刷新页面或服务重启后会自动继续。</span>
                </p>
              ) : null}
            </>
          )}
        />
      )}
      {(() => {
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
            actor={actor ?? ""}
            token={token ?? undefined}
            projectId={projectId}
            targetWorkspaceId={workspaceId}
          />
        </div>
      ) : null}
    </div>
  );
}
