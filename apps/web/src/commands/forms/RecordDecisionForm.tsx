/**
 * P13 `02` §2 RecordDecision — governance decision form. Binds the EXACT
 * pending proposal revision（P6 D1 human gate）; decision ∈ Approve / Reject /
 * Adjust; note only sent when non-empty (`02` §3 rule 4: never embed fields
 * the server did not ask for).
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

const DECISIONS = ["Approve", "Reject", "Adjust"] as const;

export function RecordDecisionForm({
  actor,
  projectId,
  proposal,
  token,
  onSubmitted,
}: {
  readonly actor: string;
  readonly projectId: string;
  readonly proposal: {
    readonly proposalId: string;
    readonly revision: number;
    readonly summary: string;
  };
  readonly token?: string | undefined;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
}) {
  const [decision, setDecision] =
    useState<(typeof DECISIONS)[number]>("Approve");
  const [note, setNote] = useState("");
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted,
  });
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    void submit("RecordDecision", projectId, {
      proposalId: proposal.proposalId,
      proposalRevision: proposal.revision,
      decision,
      ...(note.trim() !== "" ? { note: note.trim() } : {}),
    });
  };
  return (
    <Card title="记录治理决策">
      <form className="arbor-command-form" onSubmit={doSubmit}>
        <p>
          <Mono>{proposal.proposalId}</Mono>{" "}
          <span className="arbor-command-static">
            revision {proposal.revision}
          </span>
        </p>
        <p>{proposal.summary}</p>
        <Field
          control="select"
          label="决策"
          value={decision}
          onChange={(next) => setDecision(next as (typeof DECISIONS)[number])}
          options={DECISIONS.map((value) => ({ value, label: value }))}
        />
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
          提交决策
        </Button>
      </form>
    </Card>
  );
}
