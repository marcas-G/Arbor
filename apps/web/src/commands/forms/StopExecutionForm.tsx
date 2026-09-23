/**
 * P13 `02` §2 StopExecution — external Human/Parent 紧急停止控件（§6 U-3：
 * payload 目标仅为当前呈现的 executionId，不提供跨 workspace 批量停止）。
 * 两段式显式确认：先进入确认区（显示 executionId），再次确认才提交。
 */
import { useState } from "react";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Mono } from "../../views/shared.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { FormFeedback } from "./FormFeedback.js";
import "./forms.css";

export function StopExecutionForm({
  actor,
  projectId,
  executionId,
  workspaceName,
  token,
  onSubmitted,
}: {
  readonly actor: string;
  readonly projectId: string;
  readonly executionId: string;
  readonly workspaceName?: string | undefined;
  readonly token?: string | undefined;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted,
  });
  const doSubmit = (): void => {
    void submit("StopExecution", projectId, {
      executionId,
      reason: "human-emergency-stop",
    });
  };
  return (
    <Card title="紧急停止执行">
      <div className="arbor-command-form">
        {confirming ? (
          <div className="arbor-command-confirm">
            <p>
              确认停止执行 <Mono>{executionId}</Mono>
            </p>
            {workspaceName === undefined ? null : <p>{workspaceName}</p>}
            <div className="arbor-command-confirm-actions">
              <Button
                variant="danger"
                disabled={state.phase === "submitting"}
                onClick={doSubmit}
              >
                确认停止
              </Button>
              <Button variant="quiet" onClick={() => setConfirming(false)}>
                取消
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirming(true)}>
            紧急停止执行
          </Button>
        )}
        <FormFeedback state={state} onRetry={doSubmit} />
      </div>
    </Card>
  );
}
