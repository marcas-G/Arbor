import { useRef } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { Virtuoso } from "react-virtuoso";
import { useViewQuery } from "../../api/useViewQuery.js";
import { FormFeedback } from "../../commands/forms/FormFeedback.js";
import { StopExecutionForm } from "../../commands/forms/StopExecutionForm.js";
import { SubmitHumanMessageForm } from "../../commands/forms/SubmitHumanMessageForm.js";
import { useCommandSubmission } from "../../commands/useCommandSubmission.js";
import { Button } from "../../components/Button.js";
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

function ResponseStatusPanel({
  message,
  projectId,
  actor,
  token,
  onChanged,
}: {
  readonly message: ConversationMessage;
  readonly projectId: string;
  readonly actor: string;
  readonly token?: string | undefined;
  readonly onChanged: () => void;
}) {
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted: onChanged,
  });
  const status = message.responseStatus;
  if (message.messageId === undefined || status === undefined) return null;
  if (status.state === "Answered") return null;
  if (status.state === "Running") {
    return (
      <div className={styles.conversationStatus} role="status">
        <strong>正在处理（第 {status.attemptNo + 1} 次执行）</strong>
        <StopExecutionForm
          actor={actor}
          token={token}
          projectId={projectId}
          executionId={status.executionId}
          onSubmitted={onChanged}
        />
      </div>
    );
  }
  const cancel = () =>
    void submit("CancelConversationResponse", projectId, {
      messageId: message.messageId,
      expectedJobRevision: status.revision,
    });
  const resume = () =>
    void submit("ResumeConversationResponse", projectId, {
      messageId: message.messageId,
      expectedJobRevision: status.revision,
    });
  const attentionReason =
    status.state === "NeedsAttention" ? status.reason : undefined;
  const attentionCopy =
    attentionReason === undefined
      ? undefined
      : presentAttentionReason(attentionReason);
  return (
    <div className={styles.conversationStatus} role="status">
      <strong>
        {status.state === "Queued"
          ? "已排队"
          : status.state === "RetryScheduled"
            ? `等待重试（${status.nextEligibleAt}）`
            : status.state === "NeedsAttention"
              ? attentionCopy?.title
              : `已停止：${status.reason}`}
      </strong>
      {attentionCopy === undefined ? null : (
        <>
          <span>{attentionCopy.description}</span>
          <details className={styles.technicalReason}>
            <summary>技术详情</summary>
            <code>{attentionReason}</code>
          </details>
        </>
      )}
      {status.state === "RetryScheduled" ? (
        <span>{status.safeReason}</span>
      ) : null}
      {status.state === "NeedsAttention" ? (
        <Button onClick={resume}>再次尝试</Button>
      ) : null}
      {status.state === "Queued" ||
      status.state === "RetryScheduled" ||
      status.state === "NeedsAttention" ? (
        <Button variant="quiet" onClick={cancel}>
          停止本次回复
        </Button>
      ) : null}
      <FormFeedback state={state} onRetry={onChanged} />
    </div>
  );
}

const presentAttentionReason = (
  reason: string,
): { readonly title: string; readonly description: string } => {
  switch (reason) {
    case "DeterministicModelFailure":
      return {
        title: "模型没有返回可用回复",
        description: "系统已暂停自动重试。你可以再次尝试，或停止本次回复。",
      };
    case "AuthenticationFailed":
      return {
        title: "模型服务认证失败",
        description: "请检查模型服务的访问凭据，修复后再试。",
      };
    case "RequestRejected":
      return {
        title: "模型服务拒绝了请求",
        description: "当前请求与模型服务不兼容，请检查模型或上下文配置。",
      };
    case "ContextBlocked":
      return {
        title: "对话上下文尚未准备好",
        description: "系统已停止继续调用模型，以免使用不完整的上下文。",
      };
    case "ReconciliationRequired":
      return {
        title: "上一次调用结果尚未确认",
        description: "系统需要先确认外部调用结果，避免产生重复回复。",
      };
    case "RetryBudgetExhausted":
      return {
        title: "模型服务连续不可用",
        description: "自动重试已经停止。服务恢复后可以再次尝试。",
      };
    default:
      return {
        title: "这次回复未能完成",
        description: "系统已暂停自动重试。你可以再次尝试或停止本次回复。",
      };
  }
};

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
                <ResponseStatusPanel
                  message={message}
                  projectId={projectId}
                  actor={actor ?? ""}
                  token={token ?? undefined}
                  onChanged={conversation.retryHistory}
                />
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
