import type {
  CurrentWorkSummary,
  VerificationRes,
  WorkDetailRes,
} from "@arbor/api-contracts";
import { Card } from "../components/Card.js";
import { EnumBadge, Mono, TimeText } from "./shared.js";

type ProgressState = {
  readonly label: string;
  readonly explanation: string;
  readonly next: string;
};

function progressState(
  work: WorkDetailRes,
  current: CurrentWorkSummary | undefined,
  verification: VerificationRes | undefined,
): ProgressState {
  if (work.lifecycle === "Completed")
    return {
      label: "流程：已完成",
      explanation: "成果已经通过用户验收，工作已结束。",
      next: "无需继续操作。",
    };
  if (work.lifecycle === "Cancelled")
    return {
      label: "流程：已取消",
      explanation: "这项工作已被取消，不会继续产生新的运行。",
      next: "如需继续，请重新安排一项工作。",
    };
  if (work.acceptedResult !== undefined)
    return {
      label: "流程：已验收，待完成",
      explanation: "你已确认成果，系统正在完成最后的收尾。",
      next: "等待系统完成收尾；如果长时间没有变化，请查看运行记录。",
    };
  if (verification?.verdict === "Pass")
    return {
      label: "流程：等待验收",
      explanation: "独立验证已通过，成果现在等待你的确认。",
      next: "检查验证明细后，确认验收或调整方向。",
    };
  if (verification?.verdict === "Fail")
    return {
      label: "流程：验证未通过",
      explanation: "独立验证发现了未满足的标准。",
      next: "查看验证明细并调整方向，然后等待下一次运行。",
    };
  if (current?.activeExecution !== undefined)
    return {
      label: "流程：正在执行",
      explanation: "当前工作正在运行，进度会在运行记录和实时流中更新。",
      next: "等待本轮运行完成；需要介入时可停止当前运行。",
    };
  if (current?.workId === work.workId)
    return {
      label: "流程：等待执行",
      explanation: "这项工作仍是当前工作，但现在没有活动运行。",
      next: "等待调度唤醒；如果长时间没有变化，请查看关注事项。",
    };
  return {
    label: "流程：待安排",
    explanation: "这项工作已创建，但目前不是该工作区的当前工作。",
    next: "完成当前工作或调整安排后，系统才会继续处理它。",
  };
}

export function WorkProgressView({
  work,
  current,
  verification,
}: {
  readonly work: WorkDetailRes;
  readonly current: CurrentWorkSummary | undefined;
  readonly verification: VerificationRes | undefined;
}) {
  const state = progressState(work, current, verification);
  const execution = current?.activeExecution;
  return (
    <Card title="进度与下一步">
      <div className="arbor-view-stack">
        <div className="arbor-badge-row">
          <EnumBadge label={state.label} />
          {execution === undefined ? null : <span>运行中</span>}
        </div>
        <div className="arbor-kv">
          <span className="arbor-kv-label">当前说明</span>
          <span>{state.explanation}</span>
        </div>
        <div className="arbor-kv">
          <span className="arbor-kv-label">下一步</span>
          <span>{state.next}</span>
        </div>
        {execution === undefined ? null : (
          <div className="arbor-kv">
            <span className="arbor-kv-label">本轮运行</span>
            <span>
              自 <TimeText at={execution.admittedAt} /> 开始 ·{" "}
              <Mono>{execution.executionId}</Mono>
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}
