import { useEffect, useRef } from "react";
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
import { useConversationProgress } from "../../conversation/useConversationProgress.js";
import { cn } from "../../lib/utils.js";
import { ProblemCard } from "../../problems/ProblemCard.js";
import { useSession } from "../../session/SessionContext.js";
import { TimeText } from "../../views/shared.js";
import { presentResponsibilityTree } from "../tree/treePresentation.js";

/** The browser displays one server-authoritative conversation timeline. */
function MessageRow({ message }: { readonly message: ConversationMessage }) {
  return (
    <div
      className={cn(
        "flex max-w-[min(84%,48rem)] flex-col gap-1 rounded-lg border border-solid border-border px-5 py-3 text-foreground max-[48rem]:max-w-full",
        message.role === "human"
          ? "ml-auto rounded-br-sm border-primary/20 bg-accent"
          : "mr-auto rounded-bl-sm bg-card shadow-card",
      )}
      data-phase="authoritative"
    >
      <span className="text-caption font-bold tracking-wide text-primary">
        {message.role === "human" ? "你" : "Arbor"}
      </span>
      <span className="wrap-anywhere whitespace-pre-wrap leading-[1.65]">
        {message.body}
      </span>
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
  const pendingAction = useRef<{
    readonly commandType:
      | "CancelConversationResponse"
      | "ResumeConversationResponse";
    readonly messageId: string;
    readonly revision: number;
  } | null>(null);
  const status = message.responseStatus;
  const progress = useConversationProgress(
    message.messageId,
    status?.state === "Running",
  );
  if (message.messageId === undefined || status === undefined) return null;
  if (status.state === "Answered") return null;
  if (status.state === "Running") {
    return (
      <div
        className="my-1 mb-3 grid gap-1 rounded-r-md border-0 border-l-[3px] border-solid border-attention bg-[color-mix(in_srgb,var(--arbor-attention)_8%,transparent)] px-3 py-2 text-caption text-muted-foreground [&_strong]:text-foreground"
        role="status"
      >
        <strong>正在处理（第 {status.attemptNo + 1} 次尝试）</strong>
        <span className="text-muted-foreground">
          {progress === null
            ? "正在连接模型"
            : progress.stage === "tool"
              ? "正在调用工具"
              : progress.stage === "retrying"
                ? "正在重试模型请求"
                : progress.stage === "answering"
                  ? "正在生成回复"
                  : "正在分析请求"}
        </span>
        {progress?.toolNames.map((toolName) => (
          <span
            className="inline-flex items-center gap-1.5 text-muted-foreground"
            key={toolName}
          >
            <span
              className="size-1.5 rounded-full bg-accent-foreground motion-safe:animate-pulse"
              aria-hidden="true"
            />
            工具调用：{toolName}
          </span>
        ))}
        {progress?.text ? (
          <span
            className="max-h-40 overflow-auto whitespace-pre-wrap border-0 border-l-2 border-solid border-accent-foreground bg-background/70 p-2 text-foreground"
            aria-live="polite"
          >
            {progress.text}
          </span>
        ) : null}
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
  const sendPending = () => {
    const action = pendingAction.current;
    if (action === null) return;
    void submit(action.commandType, projectId, {
      messageId: action.messageId,
      expectedJobRevision: action.revision,
    });
  };
  const chooseAction = (
    commandType: "CancelConversationResponse" | "ResumeConversationResponse",
  ) => {
    if (state.phase === "submitting" || state.phase === "transport-failed")
      return;
    pendingAction.current = {
      commandType,
      messageId: message.messageId as string,
      revision: status.revision,
    };
    sendPending();
  };
  const attentionReason =
    status.state === "NeedsAttention" ? status.reason : undefined;
  const attentionCopy =
    attentionReason === undefined
      ? undefined
      : presentAttentionReason(attentionReason);
  const cancelledCopy =
    status.state === "Cancelled" ? presentCancelledReason(status.reason) : null;
  return (
    <div
      className="my-1 mb-3 grid gap-1 rounded-r-md border-0 border-l-[3px] border-solid border-attention bg-[color-mix(in_srgb,var(--arbor-attention)_8%,transparent)] px-3 py-2 text-caption text-muted-foreground [&_strong]:text-foreground"
      role="status"
    >
      <strong>
        {status.state === "Queued"
          ? "已排队"
          : status.state === "RetryScheduled"
            ? "等待自动重试"
            : status.state === "NeedsAttention"
              ? attentionCopy?.title
              : cancelledCopy?.title}
      </strong>
      {status.state === "RetryScheduled" ? (
        <span>
          预计于 <TimeText at={status.nextEligibleAt} /> 再次尝试
        </span>
      ) : null}
      {attentionCopy === undefined ? null : (
        <>
          <span>{attentionCopy.description}</span>
          <details className="text-muted-foreground [&_summary]:cursor-pointer [&_code]:mt-1 [&_code]:block [&_code]:font-mono">
            <summary>技术详情</summary>
            <code>{attentionReason}</code>
          </details>
        </>
      )}
      {status.state === "RetryScheduled" ? (
        <span>{status.safeReason}</span>
      ) : null}
      {cancelledCopy === null ? null : (
        <>
          <span>{cancelledCopy.description}</span>
          {cancelledCopy.known ? null : (
            <details className="text-muted-foreground [&_summary]:cursor-pointer [&_code]:mt-1 [&_code]:block [&_code]:font-mono">
              <summary>技术详情</summary>
              <code>{status.state === "Cancelled" ? status.reason : ""}</code>
            </details>
          )}
        </>
      )}
      {status.state === "NeedsAttention" ? (
        <Button
          disabled={
            state.phase === "submitting" || state.phase === "transport-failed"
          }
          onClick={() => chooseAction("ResumeConversationResponse")}
        >
          再次尝试
        </Button>
      ) : null}
      {status.state === "Queued" ||
      status.state === "RetryScheduled" ||
      status.state === "NeedsAttention" ? (
        <Button
          variant="quiet"
          disabled={
            state.phase === "submitting" || state.phase === "transport-failed"
          }
          onClick={() => chooseAction("CancelConversationResponse")}
        >
          停止本次回复
        </Button>
      ) : null}
      <FormFeedback state={state} onRetry={sendPending} />
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

const presentCancelledReason = (
  reason: string,
): {
  readonly title: string;
  readonly description: string;
  readonly known: boolean;
} => {
  switch (reason) {
    case "HumanCancelled":
      return {
        title: "已按你的要求停止",
        description: "Arbor 不会继续生成这次回复。",
        known: true,
      };
    case "ProjectClosed":
      return {
        title: "项目已归档，回复已停止",
        description: "重新打开项目后可以发送新的消息。",
        known: true,
      };
    case "ControlledStop":
      return {
        title: "回复已停止",
        description: "Arbor 已安全停止这次回复。",
        known: true,
      };
    default:
      return {
        title: "回复已停止",
        description: "这次回复没有继续生成。",
        known: false,
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
  useEffect(() => {
    if (
      conversation.messages.length === 0 ||
      pinnedWorkspaceRef.current === workspaceId
    ) {
      return;
    }
    pinnedWorkspaceRef.current = workspaceId;
    queueMicrotask(() => {
      virtuosoRef.current?.scrollToIndex({
        index: conversation.messages.length - 1,
        align: "end",
        behavior: "auto",
      });
    });
  }, [conversation.messages.length, workspaceId]);

  const answeredMessageIds = new Set(
    conversation.messages.flatMap((message) =>
      message.role === "assistant" && message.messageId !== undefined
        ? [message.messageId]
        : [],
    ),
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <p className="sr-only">{isRoot ? "项目主对话" : "对话记录（只读）"}</p>
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
          className="h-[min(64vh,48rem)] min-h-60 overflow-x-hidden overscroll-contain max-[48rem]:h-[min(55dvh,38rem)] max-[48rem]:min-h-48"
          style={{ overflowX: "hidden" }}
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
                <p className="m-0 self-center text-caption text-muted-foreground">
                  正在加载更早的消息…
                </p>
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
      {isRoot ? (
        <div className="flex flex-col gap-2 rounded-lg border border-solid border-border-strong bg-card px-3 pt-2 pb-3 shadow-card transition focus-within:border-accent-foreground focus-within:shadow-float [&_.arbor-field-label]:text-primary [&_.arbor-button-primary]:min-w-[76px]">
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
