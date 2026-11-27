import type { ExecutionId } from "@arbor/domain";
import type { ContextUnsatisfiable } from "@arbor/model-context";
import type {
  AgentLoopStepStoreError,
  DecisionRequestStoreError,
  ExecutionDriverError,
  ModelContextError,
  ProviderFailure,
  ToolCatalogError,
  TransactionOperationalFailure,
  VerificationRepositoryError,
} from "@arbor/ports";
import type { Effect } from "effect";
import type { runCompaction } from "../../compaction-coordinator.js";
import { toExecutionDriverError } from "../../execution-driver-failure.js";
import type { ResumeOverflowCompactionError } from "../recovery/errors.js";

/** E09: the turn-preparation phases keep their narrow typed failures while
 * composing and fold to `ExecutionDriverError` exactly once at the boundary
 * that owns that channel (the `prepareTurnForDecision` call site in
 * `runModelDecision`; the instruction assembly folds into the preparation
 * union). Each union is composed from existing ports failure types plus the
 * phase's own tagged invariants; `toExecutionDriverError` already dispatches
 * on member tags and is idempotent over pre-folded members, so the boundary
 * fold reuses it instead of adding catch-all handling. */

export interface CompactionFenceUnavailable {
  readonly _tag: "CompactionFenceUnavailable";
  readonly executionId: ExecutionId;
}

/** `assembleDecisionInstructions`: canonical instruction assembly over the
 * submitted decision request, pinned actions and settled Provider evidence.
 * `ExecutionDriverError` flows in from the already-folded `proposeSettlement`
 * boundary callback. */
export type DecisionInstructionError =
  | AgentLoopStepStoreError
  | DecisionRequestStoreError
  | ExecutionDriverError
  | ProviderFailure
  | TransactionOperationalFailure;

/** `prepareTurnForDecision`: instruction assembly, pinned-compaction resume,
 * turn-profile resolution, model-context preparation and the
 * context-limit compaction. `ExecutionDriverError` flows in from the
 * already-folded `proposeSettlement` boundary callback. */
export type TurnPreparationError =
  | CompactionFenceUnavailable
  | ContextUnsatisfiable
  | DecisionInstructionError
  | Effect.Error<ReturnType<typeof runCompaction>>
  | ExecutionDriverError
  | ModelContextError
  | ResumeOverflowCompactionError
  | ToolCatalogError
  | TransactionOperationalFailure
  | VerificationRepositoryError;

export const foldTurnPreparationError = (
  cause: TurnPreparationError,
): ExecutionDriverError => toExecutionDriverError(cause);
