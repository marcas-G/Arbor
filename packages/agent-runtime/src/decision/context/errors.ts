import type { SessionId, WorkId, WorkspaceId } from "@arbor/domain";
import type {
  AgentLoopStepInvariantConflict,
  AgentLoopStepStoreError,
  ExecutionDriverError,
  LeaseFencingRejected,
  LocalPlanStoreError,
  ProviderFailure,
  SessionEpochConflict,
  SessionRepositoryError,
  SessionSourceConflict,
  TransactionOperationalFailure,
  WorkRepositoryError,
  WorkspaceKnowledgeReadError,
  WorkspacePlacementReadError,
  WorkspaceRepositoryError,
} from "@arbor/ports";
import { toExecutionDriverError } from "../../execution-driver-failure.js";

/** E09: the decision context phases keep their narrow typed failures while
 * composing and fold to `ExecutionDriverError` exactly once at the boundary
 * that owns that channel (the `loadDecisionSessionContext` and
 * `loadDecisionWorkspaceContext` call sites in `runModelDecision`). Each
 * union is composed from existing ports failure types plus the phase's own
 * tagged invariants; `toExecutionDriverError` already dispatches on member
 * tags and is idempotent over pre-folded members, so the boundary folds
 * reuse it instead of adding catch-all handling. */

export interface SessionContextMissing {
  readonly _tag: "SessionContextMissing";
  readonly sessionId: SessionId;
}

export interface WorkspaceContextMissing {
  readonly _tag: "WorkspaceContextMissing";
  readonly workspaceId: WorkspaceId;
}

export interface WorkContextMissing {
  readonly _tag: "WorkContextMissing";
  readonly workId: WorkId;
}

/** `loadDecisionSessionContext`: the exact Session frontier projection, the
 * provenance-bound frontier repair and the fenced blocked-step
 * terminalization. `ExecutionDriverError` flows in from the already-folded
 * `loadReasoningAttachmentBlobs` driver callback. */
export type DecisionSessionContextError =
  | AgentLoopStepInvariantConflict
  | AgentLoopStepStoreError
  | ExecutionDriverError
  | LeaseFencingRejected
  | ProviderFailure
  | SessionContextMissing
  | SessionEpochConflict
  | SessionRepositoryError
  | SessionSourceConflict
  | TransactionOperationalFailure;

/** `loadDecisionWorkspaceContext`: the bound workspace, accepted knowledge,
 * placement and work plan reads. */
export type DecisionWorkspaceContextError =
  | LocalPlanStoreError
  | TransactionOperationalFailure
  | WorkContextMissing
  | WorkRepositoryError
  | WorkspaceContextMissing
  | WorkspaceKnowledgeReadError
  | WorkspacePlacementReadError
  | WorkspaceRepositoryError;

export const foldDecisionSessionContextError = (
  cause: DecisionSessionContextError,
): ExecutionDriverError => toExecutionDriverError(cause);

export const foldDecisionWorkspaceContextError = (
  cause: DecisionWorkspaceContextError,
): ExecutionDriverError => toExecutionDriverError(cause);
