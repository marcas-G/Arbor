/**
 * W-08 — StopExecution form (RHF + Zod). Frozen payload {executionId};
 * two-stage explicit confirmation; external Human/Parent stop REQUEST —
 * the server Authority Resolver remains the sole enforcement (P13 `02` U-3).
 */
import type { FormEvent } from "react";
import { useState } from "react";
import { type Resolver, useForm } from "react-hook-form";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Mono } from "../../views/shared.js";
import { stopExecutionSchema, zodResolver } from "../schemas.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { FormFeedback } from "./FormFeedback.js";
import "./forms.css";

type StopValues = { executionId: string; confirmed: true };

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
  const [stage, setStage] = useState<"idle" | "confirming">("idle");
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted,
  });
  const { handleSubmit, setValue, watch } = useForm<StopValues>({
    resolver: zodResolver(stopExecutionSchema) as Resolver<StopValues>,
    defaultValues: {
      executionId,
      confirmed: false as unknown as true,
    },
  });
  const confirmed = watch("confirmed");
  if (stage === "idle") {
    return (
      <Button variant="danger" onClick={() => setStage("confirming")}>
        紧急停止执行
      </Button>
    );
  }
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    void handleSubmit((values) =>
      submit("StopExecution", projectId, {
        executionId: values.executionId,
        reason: "human-emergency-stop",
      }),
    )();
  };
  return (
    <Card title="紧急停止（StopExecution）">
      <form className="arbor-command-form" onSubmit={doSubmit}>
        <p>
          确认停止执行 <Mono>{executionId}</Mono>
          {workspaceName === undefined ? null : `（${workspaceName}）`}
        </p>
        <label className="arbor-command-check">
          <input
            type="checkbox"
            checked={confirmed === true}
            onChange={(event) => {
              setValue("confirmed", event.target.checked as true);
            }}
          />
          我确认要立即停止该执行
        </label>
        <FormFeedback state={state} onRetry={() => doSubmit()} />
        <div className="arbor-command-actions">
          <Button
            variant="danger"
            type="submit"
            disabled={state.phase === "submitting" || confirmed !== true}
          >
            确认停止
          </Button>
          <Button variant="quiet" onClick={() => setStage("idle")}>
            取消
          </Button>
        </div>
      </form>
    </Card>
  );
}
