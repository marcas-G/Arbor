/** P13 human RetryVerification form. Caller-bound identities are allocated
 * once and retained across uncertain transport retries, just like commandId. */
import type { FormEvent } from "react";
import { useRef, useState } from "react";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Field } from "../../components/Field.js";
import { Mono } from "../../views/shared.js";
import { retryVerificationSchema } from "../schemas.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { uuidv7 } from "../uuid7.js";
import { FormFeedback } from "./FormFeedback.js";
import "./forms.css";

export function RetryVerificationForm({
  actor,
  projectId,
  workId,
  verificationId,
  expectedWorkRevision,
  token,
  onSubmitted,
}: {
  readonly actor: string;
  readonly projectId: string;
  readonly workId: string;
  readonly verificationId: string;
  readonly expectedWorkRevision: number;
  readonly token?: string | undefined;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
}) {
  const [summaryContent, setSummaryContent] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const successorVerificationId = useRef<string | null>(null);
  const verifierExecutionId = useRef<string | null>(null);
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted,
  });

  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    successorVerificationId.current ??= `ver_${uuidv7()}`;
    verifierExecutionId.current ??= `exe_${uuidv7()}`;
    const payload = {
      workId,
      verificationId,
      expectedWorkRevision,
      summaryContent,
      successorVerificationId: successorVerificationId.current,
      verifierExecutionId: verifierExecutionId.current,
    };
    const parsed = retryVerificationSchema.safeParse(payload);
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? "请检查输入");
      return;
    }
    setValidationError(null);
    void submit("RetryVerification", projectId, parsed.data);
  };

  return (
    <Card title="重新启动验证">
      <form
        className="arbor-command-form"
        onSubmit={doSubmit}
        aria-label="重新启动验证"
      >
        <p>
          <Mono>{workId}</Mono> · <Mono>{verificationId}</Mono>{" "}
          <span className="arbor-command-static">
            revision {expectedWorkRevision}
          </span>
        </p>
        <Field
          control="textarea"
          label="重试说明"
          rows={3}
          placeholder="说明为何需要重新运行这次验证"
          value={summaryContent}
          onChange={(value) => {
            setSummaryContent(value);
            setValidationError(null);
          }}
        />
        {validationError !== null ? (
          <p className="arbor-command-error">{validationError}</p>
        ) : null}
        <FormFeedback state={state} onRetry={() => doSubmit()} />
        <Button
          variant="primary"
          type="submit"
          disabled={
            state.phase === "submitting" || summaryContent.trim() === ""
          }
        >
          提交重试
        </Button>
      </form>
    </Card>
  );
}
