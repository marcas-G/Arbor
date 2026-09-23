/**
 * P13-005 shared command-form feedback: transport-level Problem → ProblemCard
 * (unavailable/invalid-request treatments, retry affordance reuses the held
 * commandId); TerminalRejected receipt → CommandInlineError, form stays
 * editable and resubmittable under a new commandId (`03` §5).
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
  return null;
}
