/**
 * P13 `02` §2 AcceptWorkOutcome — human-as-root-parent 验收表单（§6 U-1：
 * 仅 root 直接子 workspace 的 delivered outcome 路径；agent-parent 路径不经
 * UI）。decision ∈ Accept / Reject；note 仅非空时发送（`02` §3 rule 4）。
 */

import type { FormEvent } from "react";
import { useId, useState } from "react";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Field } from "../../components/Field.js";
import { Mono } from "../../views/shared.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { FormFeedback } from "./FormFeedback.js";
import "./forms.css";

const DECISIONS = ["Accept", "Reject"] as const;

export function AcceptWorkOutcomeForm({
  actor,
  projectId,
  workId,
  deliverableRef,
  token,
  onSubmitted,
}: {
  readonly actor: string;
  readonly projectId: string;
  readonly workId: string;
  readonly deliverableRef?: string | undefined;
  readonly token?: string | undefined;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
}) {
  const radioGroup = useId();
  const [decision, setDecision] =
    useState<(typeof DECISIONS)[number]>("Accept");
  const [note, setNote] = useState("");
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted,
  });
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    void submit("AcceptWorkOutcome", projectId, {
      workId,
      decision,
      ...(note.trim() !== "" ? { note: note.trim() } : {}),
    });
  };
  return (
    <Card title="验收工作成果">
      <form className="arbor-command-form" onSubmit={doSubmit}>
        <p>
          <Mono>{workId}</Mono>
        </p>
        {deliverableRef === undefined ? null : (
          <p>
            <Mono>{deliverableRef}</Mono>
          </p>
        )}
        <div className="arbor-command-check-row" role="radiogroup">
          {DECISIONS.map((value) => (
            <label key={value} className="arbor-command-check">
              <input
                type="radio"
                name={radioGroup}
                checked={decision === value}
                onChange={() => setDecision(value)}
              />
              {value === "Accept" ? "接受（Accept）" : "拒绝（Reject）"}
            </label>
          ))}
        </div>
        <Field
          control="textarea"
          label="备注（可选）"
          rows={2}
          value={note}
          onChange={setNote}
        />
        <FormFeedback state={state} onRetry={() => doSubmit()} />
        <Button
          variant="primary"
          type="submit"
          disabled={state.phase === "submitting"}
        >
          提交验收
        </Button>
      </form>
    </Card>
  );
}
