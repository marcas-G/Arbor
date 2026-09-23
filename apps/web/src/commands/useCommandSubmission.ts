/**
 * P13 `02` §3 shared submission state for human-actionable forms.
 *
 * commandId lifecycle (frozen): the form holds the pending commandId until a
 * server receipt arrives — transport failure (network error / 5xx / Problem
 * envelope) keeps the SAME commandId for retry (server idempotency); a receipt
 * (Committed or TerminalRejected) releases it, so the next submit generates a
 * new commandId. TerminalRejected keeps the form editable and resubmittable;
 * the server Authority is the only enforcement — no client-side permission
 * guessing.
 */

import type { Problem } from "@arbor/api-contracts";
import { useCallback, useRef, useState } from "react";
import type { HumanActionableCommand } from "./catalog.js";
import { isHumanActionableCommand } from "./catalog.js";
import { buildEnvelope, newCommandId } from "./envelope.js";
import type { CommandReceiptView } from "./submitCommand.js";
import { submitCommand } from "./submitCommand.js";

export type CommandSubmissionPhase =
  | "idle"
  | "submitting"
  | "committed"
  | "terminal-rejected"
  | "transport-failed";

export interface CommandSubmissionState {
  readonly phase: CommandSubmissionPhase;
  readonly problem: Problem | null;
  readonly rejection: string | null;
  /** The last server receipt (set once Committed) — presented inline so a
   * successful submit is never silent (`03` §5 receipt presentation). */
  readonly receipt: CommandReceiptView | null;
}

export interface UseCommandSubmissionArgs {
  readonly actor: string;
  readonly token?: string | undefined;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
}

const forbiddenCommandProblem = (commandType: string): Problem => ({
  code: "ui/forbidden-command",
  category: "invalid-request",
  message: `commandType 不在 Human-actionable 暴露集合内：${commandType}`,
  correlationId: null,
  retryDisposition: "non-retryable",
  safeDetails: { commandType },
});

const IDLE: CommandSubmissionState = {
  phase: "idle",
  problem: null,
  rejection: null,
  receipt: null,
};

export function useCommandSubmission({
  actor,
  token,
  onSubmitted,
}: UseCommandSubmissionArgs): {
  readonly state: CommandSubmissionState;
  readonly submit: (
    commandType: HumanActionableCommand,
    projectId: string,
    payload: unknown,
  ) => Promise<void>;
} {
  const pendingCommandIdRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const [state, setState] = useState<CommandSubmissionState>(IDLE);

  const submit = useCallback(
    async (
      commandType: HumanActionableCommand,
      projectId: string,
      payload: unknown,
    ): Promise<void> => {
      if (inFlightRef.current) {
        return;
      }
      if (!isHumanActionableCommand(commandType)) {
        setState({
          phase: "idle",
          problem: forbiddenCommandProblem(commandType),
          rejection: null,
          receipt: null,
        });
        return;
      }
      const commandId = pendingCommandIdRef.current ?? newCommandId();
      pendingCommandIdRef.current = commandId;
      inFlightRef.current = true;
      setState({
        phase: "submitting",
        problem: null,
        rejection: null,
        receipt: null,
      });
      const response = await submitCommand(
        buildEnvelope({ commandType, commandId, projectId, actor, payload }),
        token,
      );
      inFlightRef.current = false;
      if (!response.ok) {
        setState({
          phase: "transport-failed",
          problem: response.problem,
          rejection: null,
          receipt: null,
        });
        return;
      }
      pendingCommandIdRef.current = null;
      if (response.body.resolution === "Committed") {
        setState({
          phase: "committed",
          problem: null,
          rejection: null,
          receipt: response.body,
        });
        onSubmitted(response.body);
        return;
      }
      setState({
        phase: "terminal-rejected",
        problem: null,
        rejection: response.body.rejection ?? "TerminalRejected",
        receipt: null,
      });
    },
    [actor, token, onSubmitted],
  );

  return { state, submit };
}
