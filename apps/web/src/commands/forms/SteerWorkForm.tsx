/**
 * W-08 — SteerWork form (RHF + Zod). Frozen payload:
 * {workId, workspaceId, steer:{severity,guidance}, expectedWorkRevision,
 * provenance:{source:"HumanInput"}}; Critical requires the explicit second
 * confirmation (P6 `04`).
 */
import type { FormEvent } from "react";
import { type Resolver, useForm } from "react-hook-form";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Field } from "../../components/Field.js";
import { steerWorkSchema, zodResolver } from "../schemas.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { FormFeedback } from "./FormFeedback.js";
import "./forms.css";

type SteerValues = {
  workId: string;
  workspaceId: string;
  guidance: string;
  severity: "Normal" | "Critical";
  criticalConfirmed: boolean;
  expectedWorkRevision: number;
};

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
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted,
  });
  const { handleSubmit, setValue, watch, formState } = useForm<SteerValues>({
    resolver: zodResolver(steerWorkSchema) as Resolver<SteerValues>,
    defaultValues: {
      workId,
      workspaceId,
      guidance: "",
      severity: "Normal",
      criticalConfirmed: false,
      expectedWorkRevision,
    },
  });
  const severity = watch("severity");
  const guidance = watch("guidance");
  const criticalConfirmed = watch("criticalConfirmed");
  const submissionLocked =
    state.phase === "submitting" || state.phase === "transport-failed";
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    void handleSubmit((values) =>
      submit("SteerWork", projectId, {
        workId: values.workId,
        workspaceId: values.workspaceId,
        steer: {
          severity: values.severity,
          guidance: values.guidance,
        },
        expectedWorkRevision: values.expectedWorkRevision,
        provenance: { source: "HumanInput" },
      }),
    )();
  };
  const blocked =
    submissionLocked || (severity === "Critical" && !criticalConfirmed);
  return (
    <Card title="调整工作方向">
      <form className="arbor-command-form" onSubmit={doSubmit}>
        <p className="arbor-command-static">{objective}</p>
        <Field
          control="textarea"
          label="调整说明"
          disabled={submissionLocked}
          rows={3}
          placeholder="说明希望 Arbor 如何调整接下来的工作"
          value={guidance}
          onChange={(next) => {
            setValue("guidance", next);
          }}
        />
        {formState.errors.guidance ? (
          <p className="arbor-command-error">
            {formState.errors.guidance.message}
          </p>
        ) : null}
        <Field
          control="select"
          label="紧急程度"
          disabled={submissionLocked}
          value={severity}
          onChange={(next) => {
            setValue("severity", next as SteerValues["severity"]);
            setValue("criticalConfirmed", false);
          }}
          options={[
            { value: "Normal", label: "常规调整" },
            { value: "Critical", label: "紧急调整" },
          ]}
        />
        {severity === "Critical" ? (
          <label className="arbor-command-check">
            <input
              type="checkbox"
              disabled={submissionLocked}
              checked={criticalConfirmed}
              onChange={(event) => {
                setValue("criticalConfirmed", event.target.checked);
              }}
            />
            我确认这项调整需要立即生效
          </label>
        ) : null}
        <FormFeedback state={state} onRetry={() => doSubmit()} />
        <Button variant="primary" type="submit" disabled={blocked}>
          发送调整
        </Button>
      </form>
    </Card>
  );
}
