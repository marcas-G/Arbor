/**
 * P13 `02` §2 SteerWork — human steer form（P6 `04`）。message + urgency；
 * Critical 需显式二次确认（"确认紧急纠偏"勾选前 Submit 保持 disabled）。
 */

import type { FormEvent } from "react";
import { useState } from "react";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Field } from "../../components/Field.js";
import { Mono } from "../../views/shared.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { FormFeedback } from "./FormFeedback.js";
import "./forms.css";

export function SteerWorkForm({
  actor,
  projectId,
  workId,
  workspaceId,
  objective,
  expectedWorkRevision,
  token,
  onSubmitted,
}: {
  readonly actor: string;
  readonly projectId: string;
  readonly workId: string;
  readonly workspaceId: string;
  readonly objective: string;
  readonly expectedWorkRevision: number;
  readonly token?: string | undefined;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
}) {
  const [message, setMessage] = useState("");
  const [critical, setCritical] = useState(false);
  const [criticalConfirmed, setCriticalConfirmed] = useState(false);
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted,
  });
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    void submit("SteerWork", projectId, {
      workId,
      workspaceId,
      steer: {
        severity: critical ? "Critical" : "Normal",
        guidance: message,
      },
      expectedWorkRevision,
      provenance: { source: "HumanInput" },
    });
  };
  const submitBlocked =
    state.phase === "submitting" || (critical && !criticalConfirmed);
  return (
    <Card title="纠偏（SteerWork）">
      <form className="arbor-command-form" onSubmit={doSubmit}>
        <p>
          <Mono>{workId}</Mono>
        </p>
        <p className="arbor-command-static">{objective}</p>
        <Field
          control="textarea"
          label="纠偏消息"
          rows={3}
          placeholder="向执行中的 workspace 传达的纠偏内容"
          value={message}
          onChange={setMessage}
        />
        <label className="arbor-command-check">
          <input
            type="checkbox"
            checked={critical}
            onChange={(event) => {
              setCritical(event.target.checked);
              setCriticalConfirmed(false);
            }}
          />
          Critical（紧急纠偏）
        </label>
        {critical ? (
          <label className="arbor-command-check">
            <input
              type="checkbox"
              checked={criticalConfirmed}
              onChange={(event) => setCriticalConfirmed(event.target.checked)}
            />
            确认紧急纠偏
          </label>
        ) : null}
        <FormFeedback state={state} onRetry={() => doSubmit()} />
        <Button variant="primary" type="submit" disabled={submitBlocked}>
          发送纠偏
        </Button>
      </form>
    </Card>
  );
}
