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
  SessionEpochConflict,
  SessionRepositoryError,
  SessionSourceConflict,
  TransactionOperationalFailure,
} from "@arbor/ports";
import type { Effect } from "effect";
import type { runConversationCheckpointCompaction } from "../checkpoint/conversation/compaction.js";
import type { ConversationCheckpointProjectionResult } from "../checkpoint/conversation/projection.js";
import type {
  commitRecoveredNativeCompaction,
  commitRecoveredSummaryCompaction,
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

/** Shared tagged invariant of the provider-invocation and overflow-recovery
 * phases: the conversation checkpoint runtime dependencies are absent for an
 * execution whose episode requires them. */
export interface ConversationCheckpointRuntimeUnavailable {
  readonly _tag: "ConversationCheckpointRuntimeUnavailable";
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

export interface SessionTimelineContextMissing {
  readonly _tag: "SessionTimelineContextMissing";
}

export interface ReasoningRoundTripBindingUnavailable {
  readonly _tag: "ReasoningRoundTripBindingUnavailable";
}

export interface ReasoningRoundTripTimelineUnavailable {
  readonly _tag: "ReasoningRoundTripTimelineUnavailable";
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

/** `completeAgentLoopStep`: the post-action observation append and the
 * loop-step transitions `ActionsInProgress -> StepEffectsCommitted ->
 * NextStepReady|SettlementProposed`. The session timeline is touched only
 * through `appendEntry` and the loop-step store through `transition` /
 * `ensureSuccessor`, so the phase never sees a wider surface. */
export type AgentLoopStepCompletionError =
  | AgentLoopStepInvariantConflict
  | AgentLoopStepStoreError
  | LeaseFencingRejected
  | SessionRepositoryError
  | TransactionOperationalFailure;

/** `recordAcceptedModelOutput`: the reasoning-attachment blob write, the
 * idempotent assistant/timeline appends inside the output-acceptance
 * transaction, the legacy append path, and the `OutputAccepted ->
 * ActionsInProgress` transition. The tagged invariants are the exact
 * fail-closed reasons the phase already produced through the eager fold. */
export type ModelOutputJournalError =
  | BlobStoreError
  | LeaseFencingRejected
  | ReasoningRoundTripBindingUnavailable
  | ReasoningRoundTripTimelineUnavailable
  | SessionEpochConflict
  | SessionRepositoryError
  | SessionSourceConflict
  | SessionTimelineContextMissing
  | TransactionOperationalFailure
  | AgentLoopStepInvariantConflict
  | AgentLoopStepStoreError;

/** `recoverDecisionStep`: the Prepared-step find-or-create, the exhausted
 * repair `OutputRejected -> SettlementProposed` transition, the settled-result
 * chain read and the overflow sub-phases (`recoverConversationOverflow` /
 * `recoverWorkOverflow` / `recoverSettledSummaryOverflow`, whose members are
 * flattened here). `ExecutionDriverError` flows in from the already-folded
 * `loadWorkCompactionPinning` callback through the work overflow phase. */
export type StepRecoveryError =
  | AgentLoopStepInvariantConflict
  | AgentLoopStepStoreError
  | AgentLoopStepReplayBindingMismatch
  | ConversationCheckpointRuntimeUnavailable
  | ConversationCheckpointStoreError
  | Effect.Error<ReturnType<typeof commitRecoveredNativeCompaction>>
  | Effect.Error<ReturnType<typeof commitRecoveredSummaryCompaction>>
  | Effect.Error<ReturnType<typeof runSummaryCompaction>>
  | ExecutionDriverError
  | LeaseFencingRejected
  | ProviderFailure
  | SessionRepositoryError
  | TransactionOperationalFailure;

export const foldAgentLoopStepCompletionError = (
  cause: AgentLoopStepCompletionError,
): ExecutionDriverError => toExecutionDriverError(cause);

export const foldModelOutputJournalError = (
  cause: ModelOutputJournalError,
): ExecutionDriverError => toExecutionDriverError(cause);

export const foldStepRecoveryError = (
  cause: StepRecoveryError,
): ExecutionDriverError => toExecutionDriverError(cause);
