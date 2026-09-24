/**
 * Problem presentation (`03` §5): category → explicit UI treatment. code /
 * correlationId / safeDetails are always inspectable via ProblemDetail.
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
          <Mono>{`code ${problem.code}`}</Mono>
        </span>
        {problem.correlationId === null ? null : (
          <span>
            <Mono>{`correlationId ${problem.correlationId}`}</Mono>
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
      <h2 className="arbor-problem-title">未认证</h2>
      <Badge tone="danger">Unauthorized</Badge>
      <p>请提供访问令牌（token）后重连；内容区已屏蔽。</p>
      <ProblemDetail problem={problem} />
    </div>
  );
}

function ForbiddenTreatment({ problem }: { readonly problem: Problem }) {
  const reason = problem.safeDetails.reason;
  return (
    <div className="arbor-problem arbor-problem-danger" role="alert">
      <h2 className="arbor-problem-title">权限拒绝</h2>
      <Badge tone="danger">AuthorityDenied</Badge>
      <p>
        <Mono>{problem.code}</Mono>
      </p>
      {typeof reason === "string" ? <p>{reason}</p> : null}
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
      <Badge tone="attention">Validation</Badge>
      <p>
        <Mono>{problem.code}</Mono>
      </p>
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
      <Badge tone="attention">Stale</Badge>
      <p>
        <Badge tone="attention">stale</Badge> 投影尚未追上日志水位。
      </p>
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
        Network / Unavailable
      </Badge>
      <p>
        <Badge tone={retryable ? "attention" : "muted"}>
          {problem.retryDisposition}
        </Badge>
      </p>
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
      <Badge tone="muted">Unknown Problem</Badge>
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
