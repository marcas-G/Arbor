/**
 * Problem presentation (`03` §5): category → explicit UI treatment. code /
 * correlationId / safeDetails remain available in the collapsed diagnostic
 * detail without becoming the primary user-facing explanation.
 * Retry affordances follow `retryDisposition`, never guess it client-side.
 */
import type { Problem } from "@arbor/api-contracts";
import { Badge } from "../components/Badge.js";
import { Button } from "../components/Button.js";
import { Empty } from "../components/Empty.js";
import { Mono } from "../views/shared.js";

export function ProblemDetail({ problem }: { readonly problem: Problem }) {
  return (
    <details className="arbor-problem-details">
      <summary>问题详情</summary>
      <div className="arbor-view-stack">
        <span>
          <Mono>{`错误代码：${problem.code}`}</Mono>
        </span>
        {problem.correlationId === null ? null : (
          <span>
            <Mono>{`跟踪编号：${problem.correlationId}`}</Mono>
          </span>
        )}
        <pre className="arbor-problem-pre">
          <Mono>{JSON.stringify(problem.safeDetails, null, 2) ?? "{}"}</Mono>
        </pre>
      </div>
    </details>
  );
}

function UnauthenticatedTreatment({ problem }: { readonly problem: Problem }) {
  return (
    <div className="arbor-problem" role="alert">
      <h2 className="arbor-problem-title">连接已失效</h2>
      <Badge tone="danger">需要重新连接</Badge>
      <p>请重新连接 Arbor 后继续。</p>
      <ProblemDetail problem={problem} />
    </div>
  );
}

function ForbiddenTreatment({ problem }: { readonly problem: Problem }) {
  return (
    <div className="arbor-problem arbor-problem-danger" role="alert">
      <h2 className="arbor-problem-title">权限拒绝</h2>
      <Badge tone="danger">没有操作权限</Badge>
      <p>当前连接没有执行此操作的权限。</p>
      <ProblemDetail problem={problem} />
    </div>
  );
}

function NotFoundTreatment({
  problem,
  onBack,
}: {
  readonly problem: Problem;
  readonly onBack?: (() => void) | undefined;
}) {
  return (
    <div className="arbor-view-stack">
      <Empty
        action={
          onBack === undefined ? undefined : (
            <Button variant="quiet" onClick={onBack}>
              返回
            </Button>
          )
        }
      >
        对象不存在
      </Empty>
      <ProblemDetail problem={problem} />
    </div>
  );
}

function InvalidRequestTreatment({ problem }: { readonly problem: Problem }) {
  return (
    <div className="arbor-problem" role="alert">
      <h2 className="arbor-problem-title">请求错误</h2>
      <Badge tone="attention">请检查输入</Badge>
      <p>提交的内容无法处理，请检查后重试。</p>
      <ProblemDetail problem={problem} />
    </div>
  );
}

function StaleTreatment({
  problem,
  onRetry,
}: {
  readonly problem: Problem;
  readonly onRetry?: (() => void) | undefined;
}) {
  return (
    <div className="arbor-problem" role="alert">
      <h2 className="arbor-problem-title">数据滞后</h2>
      <Badge tone="attention">正在同步</Badge>
      <p>最新变化仍在同步，请稍后重试。</p>
      {onRetry === undefined ? null : (
        <Button variant="quiet" onClick={onRetry}>
          重试
        </Button>
      )}
      <ProblemDetail problem={problem} />
    </div>
  );
}

function UnavailableTreatment({
  problem,
  onRetry,
}: {
  readonly problem: Problem;
  readonly onRetry?: (() => void) | undefined;
}) {
  const retryable = problem.retryDisposition === "retryable";
  return (
    <div className="arbor-problem" role="alert">
      <h2 className="arbor-problem-title">服务不可用</h2>
      <Badge tone={retryable ? "attention" : "muted"}>
        {retryable ? "可以重试" : "暂时无法恢复"}
      </Badge>
      <p>{retryable ? "连接暂时中断，请重试。" : "当前请求暂时无法完成。"}</p>
      {retryable && onRetry !== undefined ? (
        <Button variant="quiet" onClick={onRetry}>
          重试
        </Button>
      ) : null}
      <ProblemDetail problem={problem} />
    </div>
  );
}

function UnknownTreatment({ problem }: { readonly problem: Problem }) {
  return (
    <div className="arbor-problem" role="alert">
      <h2 className="arbor-problem-title">未知问题</h2>
      <Badge tone="muted">暂时无法完成</Badge>
      <ProblemDetail problem={problem} />
    </div>
  );
}

export function ProblemCard({
  problem,
  onBack,
  onRetry,
}: {
  readonly problem: Problem;
  readonly onBack?: (() => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
}) {
  switch (problem.category) {
    case "unauthenticated":
      return <UnauthenticatedTreatment problem={problem} />;
    case "forbidden":
      return <ForbiddenTreatment problem={problem} />;
    case "not-found":
      return <NotFoundTreatment problem={problem} onBack={onBack} />;
    case "invalid-request":
      return <InvalidRequestTreatment problem={problem} />;
    case "stale":
      return <StaleTreatment problem={problem} onRetry={onRetry} />;
    case "unavailable":
      return <UnavailableTreatment problem={problem} onRetry={onRetry} />;
    default:
      return <UnknownTreatment problem={problem} />;
  }
}
