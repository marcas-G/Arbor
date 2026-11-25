import type { CanonicalToolObservation, ToolRuntimeError } from "@arbor/ports";
import type { Effect } from "effect";
import type { resolveInvocationAuthority } from "./invocation-authority.js";
import type { makeNoEffectSettlement } from "./no-effect-settlement.js";
import type { resolveInvocationResources } from "./resources.js";

export type ResourceCapture = Extract<
  Effect.Success<ReturnType<typeof resolveInvocationResources>>,
  { readonly _tag: "Ready" }
>;
export type AuthorityCapture = Extract<
  Effect.Success<ReturnType<typeof resolveInvocationAuthority>>,
  { readonly _tag: "Ready" }
>;
export type NoEffectSettlement = ReturnType<typeof makeNoEffectSettlement>;
export type RefreshAfterStale = (
  cause: unknown,
) => Effect.Effect<CanonicalToolObservation, ToolRuntimeError>;
export type TerminalObservation = {
  readonly _tag: "Terminal";
  readonly observation: CanonicalToolObservation;
};
export type ReconciliationProbe = (
  boundary:
    | "AH7BeforeReconciliationFactCommit"
    | "AH7AfterReconciliationFactCommit"
    | "AH7ReconciliationResultFenceRejected",
  input: {
    readonly attemptNo: 0 | 1;
    readonly outcomeTag: "NotOccurred" | "Occurred" | "StillUnknown";
    readonly factId?: string;
  },
) => Effect.Effect<void>;
