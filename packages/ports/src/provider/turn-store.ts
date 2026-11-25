import type { ContextEpochNumber, ExecutionId, ProjectId, ProviderTurnId, SessionId } from "@arbor/domain";
import { Context, type Effect } from "effect";
import type { ProviderFailure, ProviderFailureKind, ProviderFailureTaxonomyVersion } from "../errors.js";
import type { TransactionScope } from "../session.js";
import type { CanonicalProviderEvent, ProviderAttemptObservation, ProviderContinuationCheckpoint, ProviderRecoveryDecisionEvidence, ProviderRetryDecisionRecord, ProviderRuntimeExecutionPolicy } from "./protocol.js";

export interface ProviderTurnRecord {
  readonly providerTurnId: ProviderTurnId;
  readonly executionId: ExecutionId;
  readonly sessionId: SessionId;
  readonly contextEpoch: ContextEpochNumber;
  readonly modelRef: string;
  readonly outputContractRef: string;
  readonly manifestId: string;
  readonly executionPolicy?: ProviderRuntimeExecutionPolicy;
  readonly turnDeadlineAt?: string;
}

export interface ProviderAttemptOutcome {
  readonly _tag:
    | "InProgress"
    | "Success"
    | "RetryableFailure"
    | "TerminalFailure"
    | "Cancelled"
    | "TimedOut";
  readonly providerErrorKind?: ProviderFailureKind;
  readonly taxonomyVersion?: ProviderFailureTaxonomyVersion;
}

/** P9 `04` §2.2 read face: a dangling ProviderTurn (`settled_at IS NULL`)
 * plus its append-only attempt history, for the unsettled-Turn recovery
 * decision table. */
export interface ProviderAttemptSummary {
  readonly attemptNo: number;
  readonly outcome: ProviderAttemptOutcome["_tag"];
  readonly providerErrorKind: string | null;
  readonly taxonomyVersion?: ProviderFailureTaxonomyVersion;
  readonly observation?: ProviderAttemptObservation | null;
  readonly continuationCheckpoint?: ProviderContinuationCheckpoint | null;
  readonly retryDecision?: ProviderRetryDecisionRecord | null;
  readonly canonicalEventPrefixJson?: string;
  readonly deliveredPosition?: number | null;
}

export interface ProviderTurnManifestReceipt {
  readonly providerTurnId: ProviderTurnId;
  readonly manifestId: string;
}

export interface ProviderAttemptSettlement {
  readonly outcome: Exclude<ProviderAttemptOutcome["_tag"], "InProgress">;
  readonly providerErrorKind?: ProviderFailureKind;
  readonly taxonomyVersion: ProviderFailureTaxonomyVersion;
  readonly observation: ProviderAttemptObservation;
  readonly continuationCheckpoint?: ProviderContinuationCheckpoint;
  readonly canonicalEventPrefixJson: string;
  readonly deliveredPosition: number;
  readonly retryDecision?: ProviderRetryDecisionRecord;
}

export type SettledProviderTurnResult =
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Unsettled"; readonly turn: ProviderTurnRecord }
  | {
      readonly _tag: "SettledSuccess";
      readonly turn: ProviderTurnRecord;
      readonly manifestId: string;
      readonly manifestJson: string;
      readonly canonicalEvents: ReadonlyArray<CanonicalProviderEvent>;
      readonly attemptNo: number;
      readonly finishReason: string;
      /** P9 evidence timestamp. Optional for source-compatible test adapters;
       * production SQLite returns the exact settled ProviderAttempt time. */
      readonly settledAt?: string;
      readonly usageJson: string;
      readonly evidenceVersion: string;
    }
  | {
      readonly _tag: "SettledFailure";
      readonly turn: ProviderTurnRecord;
      readonly finishReason: string;
      readonly failureKind?: ProviderFailureKind;
      readonly failureAttemptNo?: number;
      readonly failureTaxonomyVersion?: ProviderFailureTaxonomyVersion;
    }
  | {
      readonly _tag: "SettledEvidenceInvalid";
      readonly turn: ProviderTurnRecord;
      readonly reason: string;
    };

export interface UnsettledProviderTurn {
  readonly turn: ProviderTurnRecord;
  readonly attempts: ReadonlyArray<ProviderAttemptSummary>;
  readonly manifestJson: string | null;
  readonly portableRequestJson: string | null;
}

/** Internal adapter/runtime signal: the durable Execution stop fence won the
 * commit order before a new ProviderTurn intent could be admitted. */
export const PROVIDER_TURN_ADMISSION_EXECUTION_STOPPING =
  "provider-turn-admission-execution-stopping";

export interface ProviderTurnStoreService {
  readonly startTurnWithManifest: (
    record: ProviderTurnRecord,
    manifestJson: string,
    portableRequestJson: string,
    startedAt: string,
  ) => Effect.Effect<
    ProviderTurnManifestReceipt,
    ProviderFailure,
    TransactionScope
  >;
  readonly findManifestByTurn: (
    providerTurnId: ProviderTurnId,
  ) => Effect.Effect<
    {
      readonly manifestId: string;
      readonly manifestJson: string;
      readonly portableRequestJson: string;
    } | null,
    ProviderFailure,
    TransactionScope
  >;
  /** Find explicit Native compaction turns durably bound to one source
   * AgentLoopStep. Multiple rows are returned so the Runtime can fail closed
   * on duplicate history instead of selecting by id text or recency. */
  readonly findNativeCompactionsBySessionEpoch: (input: {
    readonly sessionId: SessionId;
    readonly contextEpoch: ContextEpochNumber;
  }) => Effect.Effect<
    ReadonlyArray<{
      readonly providerTurnId: ProviderTurnId;
      readonly manifestId: string;
      readonly executionId: string;
      readonly sessionId: SessionId;
      readonly contextEpoch: ContextEpochNumber;
      readonly modelRef: string;
      readonly outputContractRef: string;
      readonly manifestJson: string;
      readonly portableRequestJson: string;
    }>,
    ProviderFailure,
    TransactionScope
  >;
  readonly startAttempt: (
    providerTurnId: ProviderTurnId,
    attemptNo: number,
    observation: ProviderAttemptObservation,
    startedAt: string,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  readonly updateAttemptObservation: (
    providerTurnId: ProviderTurnId,
    attemptNo: number,
    observation: ProviderAttemptObservation,
    canonicalEventPrefixJson: string,
    deliveredPosition: number,
    continuationCheckpoint: ProviderContinuationCheckpoint | null,
    updatedAt: string,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  readonly settleAttempt: (
    providerTurnId: ProviderTurnId,
    attemptNo: number,
    settlement: ProviderAttemptSettlement,
    settledAt: string,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  readonly settleSuccessAtomically: (
    providerTurnId: ProviderTurnId,
    attemptNo: number,
    settlement: ProviderAttemptSettlement & { readonly outcome: "Success" },
    finishReason: string,
    usageJson: string,
    settledAt: string,
    evidenceVersion: "provider-success-v1",
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  readonly findSettledResult: (
    providerTurnId: ProviderTurnId,
  ) => Effect.Effect<
    SettledProviderTurnResult,
    ProviderFailure,
    TransactionScope
  >;
  readonly adoptSettledSuccessEvidence: (
    providerTurnId: ProviderTurnId,
    attemptNo: number,
    fromVersion: "legacy-success-v1",
    toVersion: "provider-success-v1",
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  readonly startTurn: (
    record: ProviderTurnRecord,
    startedAt: string,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  readonly recordAttempt: (
    providerTurnId: ProviderTurnId,
    attemptNo: number,
    outcome: ProviderAttemptOutcome,
    startedAt: string,
    settledAt: string,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  readonly settleTurn: (
    providerTurnId: ProviderTurnId,
    finishReason: string,
    usageJson: string,
    settledAt: string,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  /** P9 `04` §2.2: enumerate dangling turns of a project (Turn intent +
   * Manifest persisted before the request, so every dangling Turn is
   * visible) together with their recorded attempts. */
  readonly findUnsettledByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<UnsettledProviderTurn>,
    ProviderFailure,
    TransactionScope
  >;
  readonly findUnsettledByTurn: (
    providerTurnId: ProviderTurnId,
  ) => Effect.Effect<
    UnsettledProviderTurn | null,
    ProviderFailure,
    TransactionScope
  >;
  /** Append the shared retry-policy result before Recovery returns a retry
   * plan or marks the ProviderTurn failed. */
  readonly recordRecoveryDecision: (
    providerTurnId: ProviderTurnId,
    evidence: ProviderRecoveryDecisionEvidence,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  /** P9 `04` §2.2 case 2: mark a dangling Turn settled failed (driver
   * Turn-failure semantics, P3 `06` §2) when the retry bound is exhausted
   * or the failure class is terminal. No-op if already settled. */
  readonly failTurn: (
    providerTurnId: ProviderTurnId,
    settledAt: string,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  /** P10-007 read-only extension (observe-only, invariant 45): settled
   * provider turns with their usage_json and executing workspace — the
   * Usage aggregation source. Never feeds budget or any mutation. */
  readonly listUsageByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<ProviderTurnUsageRow>,
    ProviderFailure,
    TransactionScope
  >;
}

/** P10-007: one settled-or-unsettled provider_turns usage fact, workspace
 * attributed (usage_json raw; parsing belongs to the projection). */
export interface ProviderTurnUsageRow {
  readonly workspaceId: import("@arbor/domain").WorkspaceId;
  readonly usageJson: string | null;
  readonly settledAt: string | null;
}

export class ProviderTurnStore extends Context.Service<
  ProviderTurnStore,
  ProviderTurnStoreService
>()("arbor/ProviderTurnStore") {}
