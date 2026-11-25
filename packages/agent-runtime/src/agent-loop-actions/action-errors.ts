import type { BoundedObservation, LeaseFencingRejected } from "@arbor/ports";
import type { AgentActionError } from "../control.js";

export const actionRejectionObservation = (
  error: Extract<AgentActionError, { readonly _tag: "AgentActionRejected" }>,
): BoundedObservation => ({
  text: JSON.stringify({
    code: error.code,
    message: error.safeMessage,
    correction: error.correction,
  }),
  truncated: false,
});

export const isLeaseFencingRejected = (
  cause: unknown,
): cause is LeaseFencingRejected =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "LeaseFencingRejected";
