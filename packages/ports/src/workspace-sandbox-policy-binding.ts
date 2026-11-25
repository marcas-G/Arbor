import type { ExecutionId } from "@arbor/domain";
import { Context, type Effect } from "effect";
import type { TransactionOperationalFailure } from "./session.js";

export type WorkspaceSandboxPolicyBindingOutcome =
  | { readonly _tag: "Ready"; readonly policyRevision: number }
  | { readonly _tag: "NotApplicable" }
  | { readonly _tag: "AuthorizationRequired" }
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "Stale" };

/** Internal orchestration only. Never grants authority or expands resources.
 * Called before policy-dependent recovery and before shell admission; final
 * P4 admission independently rereads current authority and resource sources. */
export interface WorkspaceSandboxPolicyBindingPortService {
  readonly ensureForExecution: (
    executionId: ExecutionId,
  ) => Effect.Effect<
    WorkspaceSandboxPolicyBindingOutcome,
    TransactionOperationalFailure
  >;
}

export class WorkspaceSandboxPolicyBindingPort extends Context.Service<
  WorkspaceSandboxPolicyBindingPort,
  WorkspaceSandboxPolicyBindingPortService
>()("arbor/WorkspaceSandboxPolicyBindingPort") {}
