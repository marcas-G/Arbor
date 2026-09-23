/**
 * W-08 — AcceptWorkOutcome form (RHF + Zod). Frozen payload
 * {acceptanceId, workId, targetWorkRevision, verificationId};
 * `acceptanceId` caller-preallocated (`acp_<uuid-v7>`) and held across
 * transport retries like the commandId.
 */
import type { FormEvent } from "react";
import { useRef } from "react";
import { type Resolver, useForm } from "react-hook-form";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Mono } from "../../views/shared.js";
import { acceptWorkOutcomeSchema, zodResolver } from "../schemas.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { uuidv7 } from "../uuid7.js";
import { FormFeedback } from "./FormFeedback.js";
import "./forms.css";

type AcceptValues = {
  workId: string;
  targetWorkRevision: number;
  verificationId: string;
};

export function AcceptWorkOutcomeForm({
  actor,
  projectId,
  workId,
  targetWorkRevision,
  verificationId,
  token,
  onSubmitted,
}: {
  readonly actor: string;
  readonly projectId: string;
  readonly workId: string;
  readonly targetWorkRevision: number;
  readonly verificationId: string;
  readonly token?: string | undefined;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
}) {
  const acceptanceIdRef = useRef<string | null>(null);
  const handleSubmitted = (receipt: CommandReceiptView): void => {
    acceptanceIdRef.current = null;
    onSubmitted(receipt);
  };
  const { state, submit } = useCommandSubmission({
    actor,
    token,
    onSubmitted: handleSubmitted,
  });
  const { handleSubmit } = useForm<AcceptValues>({
    resolver: zodResolver(acceptWorkOutcomeSchema) as Resolver<AcceptValues>,
    defaultValues: { workId, targetWorkRevision, verificationId },
  });
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    void handleSubmit(() => {
      const acceptanceId = acceptanceIdRef.current ?? `acp_${uuidv7()}`;
      acceptanceIdRef.current = acceptanceId;
      void submit("AcceptWorkOutcome", projectId, {
        acceptanceId,
        workId,
        targetWorkRevision,
        verificationId,
      });
    })();
  };
  return (
    <Card title="验收工作成果">
      <form className="arbor-command-form" onSubmit={doSubmit}>
        <p>
          <Mono>{workId}</Mono>{" "}
          <span className="arbor-command-static">
            rev {targetWorkRevision} · {verificationId}
          </span>
        </p>
        <FormFeedback state={state} onRetry={() => doSubmit()} />
        <Button
          variant="primary"
          type="submit"
          disabled={state.phase === "submitting"}
        >
          记录验收
        </Button>
      </form>
    </Card>
  );
}
