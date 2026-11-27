import type {
  AgentLoopStepInvariantConflict,
  AgentLoopStepStoreError,
  ConversationCheckpointStoreError,
  ExecutionDriverError,
  LeaseFencingRejected,
  ProviderFailure,
  SessionRepositoryError,
  TransactionOperationalFailure,
} from "@arbor/ports";
import type { Effect } from "effect";
import type { runConversationCheckpointCompaction } from "../../checkpoint/conversation/compaction.js";
import type {
  commitRecoveredNativeCompaction,
  commitRecoveredSummaryCompaction,
  runCompaction,
  runSummaryCompaction,
} from "../../compaction-coordinator.js";
import { toExecutionDriverError } from "../../execution-driver-failure.js";
import type {
  AgentLoopStepReplayBindingMismatch,
  ConversationCheckpointRuntimeUnavailable,
} from "../errors.js";

/** E09: the overflow / native-checkpoint recovery phases keep their narrow
 * typed failures while composing and fold to `ExecutionDriverError` exactly
 * once at the boundaries that own that channel (the
 * `recoverNativeCheckpointContext` / `rebaseWorkPlanCheckpoint` call sites in
 * `runModelDecision`, the `recoverDecisionStep` phase for the two overflow
 * entry points, and `prepareTurnForDecision` for the resume sub-phase, whose
 * union composes into `TurnPreparationError`). Each union is composed from
 * existing ports failure types plus the phase's own tagged invariants;
 * `toExecutionDriverError` already dispatches on member tags and is
 * idempotent over pre-folded members, so the boundary folds reuse it instead
 * of adding catch-all handling. */

/** `recoverConversationOverflow`: the conversation-checkpoint owner read, the
 * fenced ProviderTurn links and the settled receipts of the overflow chain. */
export type ConversationOverflowError =
  | AgentLoopStepReplayBindingMismatch
  | AgentLoopStepInvariantConflict
  | AgentLoopStepStoreError
  | ConversationCheckpointRuntimeUnavailable
  | ConversationCheckpointStoreError
  | LeaseFencingRejected
  | ProviderFailure
  | TransactionOperationalFailure;

/** `recoverSettledSummaryOverflow`: the settled summary receipt validation,
 * its checkpoint promotion and the linked replacement turn. */
export type SettledSummaryOverflowError =
  | AgentLoopStepReplayBindingMismatch
  | AgentLoopStepInvariantConflict
  | AgentLoopStepStoreError
  | Effect.Error<ReturnType<typeof commitRecoveredSummaryCompaction>>
  | LeaseFencingRejected
  | SessionRepositoryError
  | TransactionOperationalFailure;

/** `recoverWorkOverflow`: non-conversation overflow against the Session
 * frontier. `ExecutionDriverError` flows in from the already-folded
 * `loadWorkCompactionPinning` phase callback. */
export type WorkOverflowError =
  | AgentLoopStepReplayBindingMismatch
  | AgentLoopStepInvariantConflict
  | AgentLoopStepStoreError
  | Effect.Error<ReturnType<typeof commitRecoveredNativeCompaction>>
  | Effect.Error<ReturnType<typeof runSummaryCompaction>>
  | ExecutionDriverError
  | LeaseFencingRejected
  | ProviderFailure
  | SessionRepositoryError
  | SettledSummaryOverflowError
  | TransactionOperationalFailure;

/** `validateNativeCheckpointSource`: the durable producer manifest/receipt
 * read and the source Step lookup. */
export type NativeCheckpointSourceError =
  | AgentLoopStepReplayBindingMismatch
  | AgentLoopStepStoreError
  | ProviderFailure
  | TransactionOperationalFailure;

/** `reconstructNativePortableFrontier`: read-only reconstruction of the
 * native producer's portable context. */
export type NativePortableFrontierError =
  | AgentLoopStepReplayBindingMismatch
  | AgentLoopStepStoreError
  | ProviderFailure
  | TransactionOperationalFailure;

/** `recoverCommittedRebaseStep`: the terminal-output verification and the
 * fenced `StepEffectsCommitted -> NextStepReady|SettlementProposed`
 * transitions. */
export type CommittedRebaseStepError =
  | AgentLoopStepReplayBindingMismatch
  | AgentLoopStepInvariantConflict
  | AgentLoopStepStoreError
  | LeaseFencingRejected
  | ProviderFailure
  | TransactionOperationalFailure;

/** `recoverNativeCheckpointContext`: binding-mismatch rebase over a native
 * checkpoint. `ExecutionDriverError` flows in from the already-folded
 * `proposeSettlement` boundary and `loadWorkCompactionPinning` callback. */
export type NativeCheckpointRecoveryError =
  | AgentLoopStepReplayBindingMismatch
  | AgentLoopStepInvariantConflict
  | AgentLoopStepStoreError
  | CommittedRebaseStepError
  | LeaseFencingRejected
  | NativeCheckpointSourceError
  | NativePortableFrontierError
  | Effect.Error<ReturnType<typeof runSummaryCompaction>>
  | ExecutionDriverError
  | ProviderFailure
  | TransactionOperationalFailure;

/** `rebaseWorkPlanCheckpoint`: local-plan binding-mismatch rebase.
 * `ExecutionDriverError` flows in from the already-folded `proposeSettlement`
 * boundary and `loadWorkCompactionPinning` callback. */
export type WorkPlanRebaseError =
  | AgentLoopStepReplayBindingMismatch
  | AgentLoopStepInvariantConflict
  | AgentLoopStepStoreError
  | LeaseFencingRejected
  | Effect.Error<ReturnType<typeof runSummaryCompaction>>
  | ExecutionDriverError
  | ProviderFailure
  | SessionRepositoryError
  | TransactionOperationalFailure;

/** `resumePinnedOverflowCompaction`: resuming a previously linked compaction
 * before inference preparation. This phase never owns the driver channel; it
 * composes into `TurnPreparationError`. `ExecutionDriverError` flows in from
 * the already-folded `proposeSettlement` boundary. */
export type ResumeOverflowCompactionError =
  | AgentLoopStepReplayBindingMismatch
  | AgentLoopStepInvariantConflict
  | AgentLoopStepStoreError
  | ConversationCheckpointRuntimeUnavailable
  | LeaseFencingRejected
  | Effect.Error<ReturnType<typeof runConversationCheckpointCompaction>>
  | Effect.Error<ReturnType<typeof runCompaction>>
  | ExecutionDriverError
  | TransactionOperationalFailure;

export const foldNativeCheckpointRecoveryError = (
  cause: NativeCheckpointRecoveryError,
): ExecutionDriverError => toExecutionDriverError(cause);

export const foldWorkPlanRebaseError = (
  cause: WorkPlanRebaseError,
): ExecutionDriverError => toExecutionDriverError(cause);
