import type { BlockedEvidenceError } from "@arbor/application";
import type {
  AgentLoopStepInvariantConflict,
  AgentLoopStepStoreError,
  ExecutionDriverError,
  InboxProjectionStoreError,
  LeaseFencingRejected,
  ProviderFailure,
  SandboxPolicyDecisionStoreError,
  SandboxProviderUnavailableStoreError,
  SessionEpochConflict,
  SessionRepositoryError,
  SessionSourceConflict,
  TransactionOperationalFailure,
} from "@arbor/ports";
import { toExecutionDriverError } from "../execution-driver-failure.js";
import type { ReconciliationEscalationRecorderError } from "./types.js";

/** E09: the action phase keeps its narrow typed failures while composing and
 * folds to `ExecutionDriverError` exactly once at the boundary that owns that
 * channel (the `executeAgentLoopActions` export; the ledger helpers,
 * the committed-step verifier and the blocked-settlement resolver each
 * propagate their own union into it). Each union is composed from existing
 * ports failure types plus the phase's own tagged invariants;
 * `toExecutionDriverError` already dispatches on member tags and is
 * idempotent over pre-folded members, so the boundary fold reuses it instead
 * of adding catch-all handling. */

/** Tagged invariant shared with the decision phases' replay gate (declared
 * locally: the action directory may not depend on decision/ internals). */
export interface AgentLoopStepReplayBindingMismatch {
  readonly _tag: "AgentLoopStepReplayBindingMismatch";
}

/** The shared action ledger: fenced AgentLoopStep mutations, session
 * timeline appends, the P9 reconciliation escalation callback, the durable
 * settlement-effect handoff and the transaction wrapper.
 * `ExecutionDriverError` flows in only from the legacy-`unknown`
 * `durableSettlementEffect` handoff channel, forwarded through the
 * `failure` dependency. */
export type ActionLedgerError =
  | AgentLoopStepStoreError
  | AgentLoopStepInvariantConflict
  | LeaseFencingRejected
  | SessionRepositoryError
  | SessionSourceConflict
  | SessionEpochConflict
  | ReconciliationEscalationRecorderError
  | ExecutionDriverError
  | TransactionOperationalFailure;

/** `verifyCommittedStep`: exact committed-ledger verification before replay
 * may advance. `ExecutionDriverError` flows in from the `failure` forward
 * over the legacy-`unknown` sandbox resume verifier channel. */
export type CommittedStepVerificationError =
  | AgentLoopStepReplayBindingMismatch
  | AgentLoopStepStoreError
  | ExecutionDriverError
  | ProviderFailure
  | SandboxProviderUnavailableStoreError
  | SandboxPolicyDecisionStoreError
  | SessionRepositoryError
  | TransactionOperationalFailure;

/** `makeBlockedSettlement`: blocked-episode evidence resolution over the
 * durable P9 action rows. */
export type BlockedSettlementError =
  | AgentLoopStepStoreError
  | BlockedEvidenceError
  | InboxProjectionStoreError
  | ProviderFailure
  | TransactionOperationalFailure;

/** `executeExecutableAction`: the shared ledger (the executable handler's
 * failures arrive as outcome values, not on the channel). */
export type ExecutableActionError = ActionLedgerError;

/** `executeAgentLoopActions` before the boundary fold. `ExecutionDriverError`
 * flows in from the already-folded `currentControlBasis` resolver. */
export type AgentLoopActionPhaseError =
  | ActionLedgerError
  | CommittedStepVerificationError
  | BlockedSettlementError
  | ExecutionDriverError;

export const foldAgentLoopActionPhaseError = (
  cause: AgentLoopActionPhaseError,
): ExecutionDriverError => toExecutionDriverError(cause);
