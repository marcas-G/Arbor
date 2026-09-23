/**
 * P13 `02` §2 RecordDecision — governance decision form. Binds the EXACT
 * pending proposal revision（P6 D1 human gate）; frozen payload =
 * {proposalId, expectedProposalRevision, outcome:{_tag}}.
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

// The frozen outcome ADT is Approve | Reject | Modify(proposal payload).
// v1 exposes the two pure decisions; Modify requires a full proposal editor
// (a UI subset of the frozen semantics — not a semantic change).
const DECISIONS = ["Approve", "Reject"] as const;

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
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted,
  });
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    void submit("RecordDecision", projectId, {
      proposalId: proposal.proposalId,
      expectedProposalRevision: proposal.revision,
      outcome: { _tag: decision },
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
