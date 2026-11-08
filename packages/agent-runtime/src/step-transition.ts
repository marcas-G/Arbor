export type ActionTransitionInput = {
  readonly freshness: "Fresh" | "Stale";
  readonly effect: "Applied" | "Rejected" | "Unknown";
  readonly settlementRequested: boolean;
};

export type ActionTransition =
  | { readonly _tag: "Applied"; readonly next: "Continue" | "Settle" }
  | { readonly _tag: "SkippedStale" }
  | { readonly _tag: "TerminalRejected" }
  | { readonly _tag: "OutcomeUnknown" }
  | { readonly _tag: "RepairRequired" };

/** Pure classification for one action result. Persistence and effects remain
 * in agent-loop-actions' fenced transaction owner. */
export const decideActionTransition = (
  input: ActionTransitionInput,
): ActionTransition => {
  if (input.freshness === "Stale") return { _tag: "SkippedStale" };
  if (input.effect === "Unknown") return { _tag: "OutcomeUnknown" };
  if (input.effect === "Rejected") return { _tag: "TerminalRejected" };
  return {
    _tag: "Applied",
    next: input.settlementRequested ? "Settle" : "Continue",
  };
};
