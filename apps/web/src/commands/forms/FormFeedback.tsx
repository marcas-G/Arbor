import { cn } from "../../lib/utils.js";
/**
 * P13-005 shared command-form feedback: transport-level Problem → ProblemCard
 * (unavailable/invalid-request treatments, retry affordance reuses the held
 * commandId); TerminalRejected receipt → CommandInlineError, form stays
 * editable and resubmittable under a new commandId (`03` §5). A Committed
 * receipt is presented inline (leaf tone + mono commandId) so a successful
 * submit is never silent.
 */
import { CommandInlineError } from "../../problems/CommandInlineError.js";
import { ProblemCard } from "../../problems/ProblemCard.js";
import type { CommandSubmissionState } from "../useCommandSubmission.js";

export function FormFeedback({
  state,
  onRetry,
}: {
  readonly state: CommandSubmissionState;
  readonly onRetry: () => void;
}) {
  if (state.problem !== null) {
    return <ProblemCard problem={state.problem} onRetry={onRetry} />;
  }
  if (state.rejection !== null) {
    return <CommandInlineError rejection={state.rejection} />;
  }
  if (state.phase === "committed" && state.receipt !== null) {
    return (
      <p
        className={cn(
          "arbor-command-receipt arbor-command-receipt-committed",
          "m-0 p-[var(--arbor-space-2)_var(--arbor-space-3)] border-l-[3px] border-solid border-primary bg-accent text-foreground text-small [&_.arbor-mono]:text-muted-foreground [&_.arbor-mono]:ml-ui-1",
        )}
      >
        已完成提交
      </p>
    );
  }
  return null;
}
