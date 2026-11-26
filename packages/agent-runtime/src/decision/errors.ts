import type { ExecutionId, MessageId } from "@arbor/domain";
import type {
  AgentLoopStepInvariantConflict,
  AgentLoopStepStoreError,
  BlobStoreError,
  ConversationAttemptStoreError,
  ConversationCheckpointStoreError,
  ConversationJobStoreError,
  ExecutionDriverError,
  ExecutionRepositoryError,
  HumanMessageStoreError,
  LeaseFencingRejected,
  ProviderFailure,
  SessionRepositoryError,
  TransactionOperationalFailure,
} from "@arbor/ports";
import type { Effect } from "effect";
import type { runConversationCheckpointCompaction } from "../checkpoint/conversation/compaction.js";
import type { ConversationCheckpointProjectionResult } from "../checkpoint/conversation/projection.js";
import type {
  commitRecoveredNativeCompaction,
  runCompaction,
  runSummaryCompaction,
} from "../compaction-coordinator.js";
import { toExecutionDriverError } from "../execution-driver-failure.js";

/** E09: the decision phases keep their narrow typed failures while composing
 * and fold to `ExecutionDriverError` exactly once at the boundary that owns
 * that channel (the `proposeSettlement` closure for settlement, the
 * `runModelDecision` export for startup recovery and conversation context).
 * Each union is composed from existing ports failure types plus the phase's
 * own tagged invariants; `toExecutionDriverError` already dispatches on
 * member tags and is idempotent over pre-folded members, so the boundary
 * folds reuse it instead of adding catch-all handling. */

export interface AgentLoopStepReplayBindingMismatch {
  readonly _tag: "AgentLoopStepReplayBindingMismatch";
}

export interface ConversationCheckpointStoreUnavailable {
  readonly _tag: "ConversationCheckpointStoreUnavailable";
  readonly executionId: ExecutionId;
}

export interface ConversationResponseJobNotCurrent {
  readonly _tag: "ConversationResponseJobNotCurrent";
  readonly messageId: MessageId;
  readonly executionId: ExecutionId;
}

type ConversationCheckpointBlockedReason = Extract<
  ConversationCheckpointProjectionResult,
  { readonly _tag: "Blocked" }
>["reason"];

export interface ConversationCheckpointProjectionBlocked {
  readonly _tag: "ConversationCheckpointProjectionBlocked";
  readonly reason: ConversationCheckpointBlockedReason;
  readonly messageId: MessageId;
}

export interface ConversationCheckpointEvidenceInvalid {
  readonly _tag: "ConversationCheckpointEvidenceInvalid";
}

export interface ConversationCheckpointBlobStoreUnavailable {
  readonly _tag: "ConversationCheckpointBlobStoreUnavailable";
}

export interface ConversationCheckpointBlobInvalid {
  readonly _tag: "ConversationCheckpointBlobInvalid";
}

export interface ConversationCheckpointBlobMismatch {
  readonly _tag: "ConversationCheckpointBlobMismatch";
}

export interface ConversationCheckpointNativeBindingInvalid {
  readonly _tag: "ConversationCheckpointNativeBindingInvalid";
}

export interface ProviderTurnStoreUnavailable {
  readonly _tag: "ProviderTurnStoreUnavailable";
}

export interface ConversationCheckpointRebaseMismatch {
  readonly _tag: "ConversationCheckpointRebaseMismatch";
}

/** `proposePreparedStepSettlement`: the fenced Prepared-to-SettlementProposed
 * transition plus a dangling failed-turn close, both inside one transaction. */
export type SettlementProposalError =
  | AgentLoopStepInvariantConflict
  | AgentLoopStepStoreError
  | LeaseFencingRejected
  | ProviderFailure
  | TransactionOperationalFailure;

/** `recoverStartupDecision`: durable checkpoint-owner recovery before a fresh
 * Prepared step. `ExecutionDriverError` flows in from the already-folded
 * `loadWorkCompactionPinning` phase callback. */
export type StartupRecoveryError =
  | AgentLoopStepReplayBindingMismatch
  | AgentLoopStepStoreError
  | Effect.Error<ReturnType<typeof commitRecoveredNativeCompaction>>
  | ExecutionDriverError
  | ProviderFailure
  | Effect.Error<ReturnType<typeof runCompaction>>
  | Effect.Error<ReturnType<typeof runSummaryCompaction>>
  | SessionRepositoryError
  | TransactionOperationalFailure;

/** `loadConversationDecisionContext`: exact ConversationResponseEpisode
 * context assembly. `ExecutionDriverError` flows in from the already-folded
 * `proposeSettlement` and checkpoint receipt validation boundaries. */
export type ConversationDecisionContextError =
  | AgentLoopStepReplayBindingMismatch
  | AgentLoopStepInvariantConflict
  | AgentLoopStepStoreError
  | BlobStoreError
  | ConversationAttemptStoreError
  | ConversationCheckpointBlobInvalid
  | ConversationCheckpointBlobMismatch
  | ConversationCheckpointBlobStoreUnavailable
  | ConversationCheckpointEvidenceInvalid
  | ConversationCheckpointNativeBindingInvalid
  | ConversationCheckpointProjectionBlocked
  | ConversationCheckpointRebaseMismatch
  | ConversationCheckpointStoreError
  | ConversationCheckpointStoreUnavailable
  | ConversationResponseJobNotCurrent
  | Effect.Error<ReturnType<typeof runConversationCheckpointCompaction>>
  | ConversationJobStoreError
  | ExecutionDriverError
  | ExecutionRepositoryError
  | HumanMessageStoreError
  | LeaseFencingRejected
  | ProviderFailure
  | ProviderTurnStoreUnavailable
  | SessionRepositoryError
  | TransactionOperationalFailure;

export const foldSettlementProposalError = (
  cause: SettlementProposalError,
): ExecutionDriverError => toExecutionDriverError(cause);

export const foldStartupRecoveryError = (
  cause: StartupRecoveryError,
): ExecutionDriverError => toExecutionDriverError(cause);

export const foldConversationDecisionContextError = (
  cause: ConversationDecisionContextError,
): ExecutionDriverError => toExecutionDriverError(cause);
