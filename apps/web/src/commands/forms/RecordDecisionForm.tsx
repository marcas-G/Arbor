/**
 * W-08 — RecordDecision form (RHF + Zod). Frozen payload:
 * {proposalId, expectedProposalRevision, outcome:{_tag}}; targets come from
 * structured contexts only (W-00 proof: gov: entryKey binding) — no manual
 * proposalId entry path in the product surface.
 */
import type { FormEvent } from "react";
import { type Resolver, useForm } from "react-hook-form";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Field } from "../../components/Field.js";
import { recordDecisionSchema, zodResolver } from "../schemas.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { FormFeedback } from "./FormFeedback.js";
import "./forms.css";

export interface DecisionTarget {
  readonly proposalId: string;
  readonly proposalRevision: number;
  readonly summary: string;
}

type DecisionValues = {
  proposalId: string;
  expectedProposalRevision: number;
  outcome: "Approve" | "Reject";
};

export function RecordDecisionForm({
  actor,
  projectId,
  target,
  token,
  onSubmitted,
}: {
  readonly actor: string;
  readonly projectId: string;
  readonly target: DecisionTarget;
  readonly token?: string | undefined;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
}) {
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted,
  });
  const { handleSubmit, setValue, watch } = useForm<DecisionValues>({
    resolver: zodResolver(recordDecisionSchema) as Resolver<DecisionValues>,
    defaultValues: {
      proposalId: target.proposalId,
      expectedProposalRevision: target.proposalRevision,
      outcome: "Approve",
    },
  });
  const outcome = watch("outcome");
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    void handleSubmit((values) =>
      submit("RecordDecision", projectId, {
        proposalId: values.proposalId,
        expectedProposalRevision: values.expectedProposalRevision,
        outcome: { _tag: values.outcome },
      }),
    )();
  };
  return (
    <Card title="处理待决事项">
      <form className="arbor-command-form" onSubmit={doSubmit}>
        <p>{target.summary}</p>
        <Field
          control="select"
          label="决策"
          disabled={
            state.phase === "submitting" || state.phase === "transport-failed"
          }
          value={outcome}
          onChange={(next) => {
            setValue("outcome", next as DecisionValues["outcome"]);
          }}
          options={[
            { value: "Approve", label: "批准" },
            { value: "Reject", label: "驳回" },
          ]}
        />
        <FormFeedback state={state} onRetry={() => doSubmit()} />
        <Button
          variant="primary"
          type="submit"
          disabled={
            state.phase === "submitting" || state.phase === "transport-failed"
          }
        >
          提交决策
        </Button>
      </form>
    </Card>
  );
}
