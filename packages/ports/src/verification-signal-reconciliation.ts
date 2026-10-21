import type { EventId, ProjectId, WorkspaceId } from "@arbor/domain";
import { Context, type Effect } from "effect";
import type { RepositoryFailure } from "./errors.js";
import type { RawJournalEventCandidate } from "./journal.js";
import type { TransactionScope } from "./session.js";

export type VerificationSignalReconciliationPhase =
  | "Pending"
  | "VerificationWakeDelivered"
  | "ParentInboxCommitted"
  | "ParentWakeDelivered"
  | "Completed"
  | "Attention";

export type VerificationSignalReconciliationFailureCode =
  | "DeadLetterBindingMismatch"
  | "EventEnvelopeMalformed"
  | "UnsupportedSourcePair"
  | "EventDecodeFailed"
  | "ReceiptMissing"
  | "ReceiptMismatch"
  | "CanonicalMismatch"
  | "RouteMismatch"
  | "InboxConflict"
  | "StateCorruption"
  | "GenerationRegression";

export interface VerificationSignalReconciliationIdentity {
  readonly consumerId: "workflow-signals";
  readonly projectId: ProjectId;
  readonly eventSequence: number;
}

/** Prevalidated source projection frozen before Pending can be inserted. */
export interface VerificationSignalReconciliationSource {
  readonly identity: VerificationSignalReconciliationIdentity;
  readonly eventId: EventId;
  readonly sourceCommandId: string;
  readonly verificationId: string;
  readonly workId: string;
  readonly workRevision: number;
  readonly verdict: "Pass" | "Fail" | "Unknown";
  readonly ownerWorkspaceId: WorkspaceId;
  readonly parentWorkspaceId: WorkspaceId | null;
  readonly sourceDigest: string;
  readonly effectPlanDigest: string;
}

export interface VerificationSignalReconciliationRow
  extends VerificationSignalReconciliationIdentity {
  readonly eventId: EventId | null;
  readonly sourceCommandId: string | null;
  readonly verificationId: string | null;
  readonly workId: string | null;
  readonly workRevision: number | null;
  readonly verdict: "Pass" | "Fail" | "Unknown" | null;
  readonly ownerWorkspaceId: WorkspaceId | null;
  readonly parentWorkspaceId: WorkspaceId | null;
  readonly sourceDigest: string | null;
  readonly effectPlanDigest: string | null;
  readonly phase: VerificationSignalReconciliationPhase;
  readonly failureCode: VerificationSignalReconciliationFailureCode | null;
  readonly attentionFactId: string | null;
  readonly leaseOwner: string | null;
  readonly leaseGeneration: number;
  readonly leaseExpiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface VerificationSignalReconciliationAttentionFact {
  readonly attentionFactId: string;
  readonly sourceIdentity: string;
  readonly identity: VerificationSignalReconciliationIdentity;
  readonly eventId: EventId | null;
  readonly failureCode: VerificationSignalReconciliationFailureCode;
  readonly evidenceDigest: string;
  readonly targetWorkspaceId: WorkspaceId;
  readonly firstDetectedAt: string;
}

export interface VerificationSignalReconciliationAttentionClaim {
  readonly projectId: ProjectId;
  readonly attentionFactId: string;
  readonly leaseOwner: string;
  readonly leaseGeneration: number;
  readonly leaseExpiresAt: string;
}

export interface VerificationSignalReconciliationCandidate
  extends RawJournalEventCandidate {
  readonly deadLetterReason: string;
}

export type VerificationSignalReconciliationStoreError =
  RepositoryFailure<"VerificationSignalReconciliationStore">;

export interface VerificationSignalReconciliationStoreService {
  readonly listDeadLetterCandidates: (input: {
    readonly projectId: ProjectId;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<VerificationSignalReconciliationCandidate>,
    VerificationSignalReconciliationStoreError,
    TransactionScope
  >;
  readonly activationHighwater: (
    projectId: ProjectId,
  ) => Effect.Effect<
    number | null,
    VerificationSignalReconciliationStoreError,
    TransactionScope
  >;
  readonly find: (
    identity: VerificationSignalReconciliationIdentity,
  ) => Effect.Effect<
    VerificationSignalReconciliationRow | null,
    VerificationSignalReconciliationStoreError,
    TransactionScope
  >;
  readonly insertPending: (
    source: VerificationSignalReconciliationSource,
    leaseOwner: string,
    leaseExpiresAt: string,
    now: string,
  ) => Effect.Effect<
    VerificationSignalReconciliationRow,
    VerificationSignalReconciliationStoreError,
    TransactionScope
  >;
  readonly claimBatch: (input: {
    readonly projectId: ProjectId;
    readonly leaseOwner: string;
    readonly now: string;
    readonly leaseTtlMs: number;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<VerificationSignalReconciliationRow>,
    VerificationSignalReconciliationStoreError,
    TransactionScope
  >;
  readonly claim: (input: {
    readonly identity: VerificationSignalReconciliationIdentity;
    readonly leaseOwner: string;
    readonly now: string;
    readonly leaseTtlMs: number;
  }) => Effect.Effect<
    VerificationSignalReconciliationRow | null,
    VerificationSignalReconciliationStoreError,
    TransactionScope
  >;
  readonly advance: (input: {
    readonly identity: VerificationSignalReconciliationIdentity;
    readonly expectedPhase: Exclude<
      VerificationSignalReconciliationPhase,
      "Completed" | "Attention"
    >;
    readonly nextPhase: VerificationSignalReconciliationPhase;
    readonly leaseOwner: string;
    readonly leaseGeneration: number;
    readonly now: string;
  }) => Effect.Effect<
    boolean,
    VerificationSignalReconciliationStoreError,
    TransactionScope
  >;
  readonly recordAttention: (input: {
    readonly identity: VerificationSignalReconciliationIdentity;
    readonly eventId: EventId | null;
    readonly failureCode: VerificationSignalReconciliationFailureCode;
    readonly evidenceDigest: string;
    readonly targetWorkspaceId: WorkspaceId;
    readonly firstDetectedAt: string;
    readonly sourceIdentity: string;
    readonly attentionFactId: string;
  }) => Effect.Effect<
    void,
    VerificationSignalReconciliationStoreError,
    TransactionScope
  >;
  readonly claimAttentionQueue: (input: {
    readonly projectId: ProjectId;
    readonly leaseOwner: string;
    readonly now: string;
    readonly leaseTtlMs: number;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<VerificationSignalReconciliationAttentionClaim>,
    VerificationSignalReconciliationStoreError,
    TransactionScope
  >;
  readonly projectAttentionClaim: (
    claim: VerificationSignalReconciliationAttentionClaim,
    now: string,
  ) => Effect.Effect<
    boolean,
    VerificationSignalReconciliationStoreError,
    TransactionScope
  >;
}

export class VerificationSignalReconciliationStore extends Context.Service<
  VerificationSignalReconciliationStore,
  VerificationSignalReconciliationStoreService
>()("arbor/VerificationSignalReconciliationStore") {}
