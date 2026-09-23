/**
 * P13 `02` §2 AcceptWorkOutcome — record the parent acceptance of a work
 * outcome. Frozen payload = {acceptanceId, workId, targetWorkRevision,
 * verificationId}; `acceptanceId` is caller-preallocated (`acp_<uuid-v7>`)
 * and held across transport retries like the commandId.
 */
import type { FormEvent } from "react";
import { useRef, useState } from "react";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Mono } from "../../views/shared.js";
import type { CommandReceiptView } from "../submitCommand.js";
import { useCommandSubmission } from "../useCommandSubmission.js";
import { uuidv7 } from "../uuid7.js";
import { FormFeedback } from "./FormFeedback.js";
import "./forms.css";

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
  const doSubmit = (event?: FormEvent): void => {
    event?.preventDefault();
    const acceptanceId = acceptanceIdRef.current ?? `acp_${uuidv7()}`;
    acceptanceIdRef.current = acceptanceId;
    void submit("AcceptWorkOutcome", projectId, {
      acceptanceId,
      workId,
      targetWorkRevision,
      verificationId,
    });
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
