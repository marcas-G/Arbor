import type { ProjectId } from "@arbor/domain";
import { Context, type Effect } from "effect";
import type { RepositoryFailure } from "./errors.js";
import type { TransactionScope } from "./session.js";

export type AttentionPollFailureCode =
  | "PollLeaseExpired"
  | "JournalIdentityUnprovable"
  | "MissingP9Fact"
  | "FactTupleMismatch"
  | "FactProjectMismatch"
  | "EventBindingMismatch"
  | "QueueFactMismatch"
  | "MarkerBindingMismatch"
  | "QueueDeleteWithoutMarker";

export interface AttentionPollBackoff {
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly backoffExponentCap: number;
}

export interface AttentionPollClaim {
  readonly projectId: ProjectId;
  readonly leaseOwner: string;
  readonly leaseGeneration: number;
  readonly attemptSequence: number;
  readonly leaseExpiresAt: string;
}

export type AttentionPollClaimResult =
  | { readonly _tag: "NoClaim" }
  | { readonly _tag: "Claimed"; readonly claim: AttentionPollClaim };

export interface AcquireAttentionPollInput extends AttentionPollBackoff {
  readonly leaseOwner: string;
  readonly now: string;
  readonly leaseTtlMs: number;
}

export type AttentionPollStoreError = RepositoryFailure<"AttentionPollStore">;

/** Durable global Attention dispatcher and per-Project fair retry state.
 * Every operation participates in the caller's P1 BEGIN IMMEDIATE scope. */
export interface AttentionPollStoreService {
  readonly tryClaim: (
    input: AcquireAttentionPollInput,
  ) => Effect.Effect<
    AttentionPollClaimResult,
    AttentionPollStoreError,
    TransactionScope
  >;
  readonly isCurrentClaim: (
    claim: AttentionPollClaim,
    now: string,
  ) => Effect.Effect<boolean, AttentionPollStoreError, TransactionScope>;
  readonly completeSuccess: (
    claim: AttentionPollClaim,
    completedAt: string,
  ) => Effect.Effect<boolean, AttentionPollStoreError, TransactionScope>;
  readonly recordFailure: (
    claim: AttentionPollClaim,
    failureCode: Exclude<AttentionPollFailureCode, "PollLeaseExpired">,
    failedAt: string,
    backoff: AttentionPollBackoff,
  ) => Effect.Effect<boolean, AttentionPollStoreError, TransactionScope>;
}

export class AttentionPollStore extends Context.Service<
  AttentionPollStore,
  AttentionPollStoreService
>()("arbor/AttentionPollStore") {}
