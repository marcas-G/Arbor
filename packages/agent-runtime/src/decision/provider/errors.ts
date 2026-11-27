import type {
  AgentLoopStepInvariantConflict,
  AgentLoopStepStoreError,
  ExecutionDriverError,
  LeaseFencingRejected,
  ProviderExecutionTimeout,
  ProviderFailure,
  RecoveryAttentionFactStoreError,
  SecretStoreError,
  TransactionOperationalFailure,
} from "@arbor/ports";
import type { Effect } from "effect";
import type { runConversationCheckpointCompaction } from "../../checkpoint/conversation/compaction.js";
import type { runCompaction } from "../../compaction-coordinator.js";
import { toExecutionDriverError } from "../../execution-driver-failure.js";
import type {
  AgentLoopStepReplayBindingMismatch,
  ConversationCheckpointRuntimeUnavailable,
} from "../errors.js";

/** E09: the provider-turn phases keep their narrow typed failures while
 * composing and fold to `ExecutionDriverError` exactly once at the boundary
 * that owns that channel (the `replayPreparedProviderTurn` and
 * `invokePreparedProviderTurn` call sites in `runModelDecision`). Each union
 * is composed from existing ports failure types plus the phase's own tagged
 * invariants; `toExecutionDriverError` already dispatches on member tags and
 * is idempotent over pre-folded members, so the boundary folds reuse it
 * instead of adding catch-all handling. */

export interface AgentLoopStepReplayManifestInvalid {
  readonly _tag: "AgentLoopStepReplayManifestInvalid";
}

export interface LegacyProviderResultRequiresAttention {
  readonly _tag: "LegacyProviderResultRequiresAttention";
  readonly reason: string;
}

export interface SettledProviderEvidenceInvalid {
  readonly _tag: "SettledProviderEvidenceInvalid";
  readonly reason: string;
}

/** `processSuccessfulProviderResult`: the settled-result read, the
 * `Prepared -> ProviderResultAvailable` transition, the repair transitions
 * and the retry successor creation. The admission end-bracket never fails on
 * its channel. */
export type ProviderResultError =
  | AgentLoopStepInvariantConflict
  | AgentLoopStepStoreError
  | LeaseFencingRejected
  | ProviderFailure
  | TransactionOperationalFailure;

/** `replayPreparedProviderTurn`: durable Provider evidence resolution, legacy
 * adoption recording and the fenced Step transitions. `RecoveryAttentionFactStore`
 * failures arrive through the legacy-adoption record/resolve calls. */
export type ProviderReplayError =
  | AgentLoopStepReplayBindingMismatch
  | AgentLoopStepReplayManifestInvalid
  | AgentLoopStepInvariantConflict
  | AgentLoopStepStoreError
  | LeaseFencingRejected
  | LegacyProviderResultRequiresAttention
  | SettledProviderEvidenceInvalid
  | RecoveryAttentionFactStoreError
  | ProviderFailure
  | TransactionOperationalFailure;

/** `invokePreparedProviderTurn`: admission, the bracketed provider call, the
 * overflow link/compaction chain and the result handoff.
 * `ExecutionDriverError` flows in from the already-folded `proposeSettlement`
 * boundary callback. */
export type ProviderInvocationError =
  | AgentLoopStepInvariantConflict
  | AgentLoopStepStoreError
  | ConversationCheckpointRuntimeUnavailable
  | LeaseFencingRejected
  | Effect.Error<ReturnType<typeof runConversationCheckpointCompaction>>
  | Effect.Error<ReturnType<typeof runCompaction>>
  | ExecutionDriverError
  | ProviderFailure
  | ProviderExecutionTimeout
  | ProviderResultError
  | SecretStoreError
  | TransactionOperationalFailure;

export const foldProviderReplayError = (
  cause: ProviderReplayError,
): ExecutionDriverError => toExecutionDriverError(cause);

export const foldProviderInvocationError = (
  cause: ProviderInvocationError,
): ExecutionDriverError => toExecutionDriverError(cause);
