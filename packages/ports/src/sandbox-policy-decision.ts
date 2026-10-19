import type {
  ExecutionId,
  ProjectId,
  SandboxPolicyDecision,
  SandboxPolicyDecisionCommittedInternalV1,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { RepositoryFailure } from "./errors.js";
import type { TransactionScope } from "./session.js";

export type SandboxPolicyDecisionStoreError =
  RepositoryFailure<"SandboxPolicyDecisionStore">;

/** A policy row is usable only together with its exact committed P1 result.
 * The SQLite adapter verifies the command receipt and snapshot digest before
 * returning this joined value. */
export interface CommittedSandboxPolicyDecisionV1 {
  readonly decision: SandboxPolicyDecision;
  readonly result: SandboxPolicyDecisionCommittedInternalV1;
}

export interface SandboxPolicyDecisionStoreService {
  /** Exact P1 key lookup. Used by P9 to rehydrate the durable decision and by
   * the Gateway to perform revision/CAS checks inside its transaction. */
  readonly findExact: (
    decision: Pick<
      SandboxPolicyDecision,
      | "projectId"
      | "workspaceId"
      | "executionId"
      | "episodeBinding"
      | "policyRevision"
    >,
  ) => Effect.Effect<
    Option.Option<CommittedSandboxPolicyDecisionV1>,
    SandboxPolicyDecisionStoreError,
    TransactionScope
  >;
  /** Current policy head for one exact canonical Execution. Absence means
   * policy revision 0; callers must separately compare the current Episode. */
  readonly findCurrentForExecution: (
    projectId: ProjectId,
    workspaceId: WorkspaceId,
    executionId: ExecutionId,
  ) => Effect.Effect<
    Option.Option<CommittedSandboxPolicyDecisionV1>,
    SandboxPolicyDecisionStoreError,
    TransactionScope
  >;
  /** Immutable insert, callable only by DecideSandboxPolicy within Gateway's
   * transaction. Unique/CAS failures remain typed and are never overwritten. */
  readonly insertCommitted: (
    decision: SandboxPolicyDecision,
  ) => Effect.Effect<void, SandboxPolicyDecisionStoreError, TransactionScope>;
}

export class SandboxPolicyDecisionStore extends Context.Service<
  SandboxPolicyDecisionStore,
  SandboxPolicyDecisionStoreService
>()("arbor/SandboxPolicyDecisionStore") {}
