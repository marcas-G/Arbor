import { useState } from "react";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Field } from "../../components/Field.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { FormFeedback } from "./FormFeedback.js";
import "./forms.css";

export function ResolveControlApprovalForm({
  actor,
  projectId,
  approvalId,
  approvalRevision,
  summary,
  token,
  onSubmitted,
}: {
  readonly actor: string;
  readonly projectId: string;
  readonly approvalId: string;
  readonly approvalRevision: number;
  readonly summary: string;
  readonly token?: string | undefined;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
}) {
  const [decision, setDecision] = useState<"Approve" | "Reject">("Approve");
  const [reason, setReason] = useState("");
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted,
  });
  const doSubmit = (): void => {
    void submit("ResolveControlApproval", projectId, {
      approvalId,
      expectedRevision: approvalRevision,
      decision,
      reason: reason.trim().length === 0 ? null : reason.trim(),
    });
  };
  return (
    <Card title="控制动作审批">
      <div className="arbor-command-form">
        <p>{summary}</p>
        <Field
          control="select"
          label="审批决定"
          value={decision}
          onChange={(next) => setDecision(next as "Approve" | "Reject")}
          options={[
            { value: "Approve", label: "批准本次精确动作" },
            { value: "Reject", label: "拒绝" },
          ]}
        />
        <Field
          control="textarea"
          label="原因（可选）"
          value={reason}
          onChange={setReason}
        />
        <FormFeedback state={state} onRetry={doSubmit} />
        <Button
          variant={decision === "Approve" ? "primary" : "danger"}
          type="button"
          disabled={state.phase === "submitting"}
          onClick={doSubmit}
        >
          {decision === "Approve" ? "批准并继续" : "拒绝动作"}
        </Button>
      </div>
    </Card>
  );
}
