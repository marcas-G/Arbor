import type {
  EventId,
  ExecutionEpisodeBinding,
  ExecutionId,
  ProjectId,
  SandboxProfile,
  SandboxProviderId,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect } from "effect";
import type { AgentLoopStepFence } from "./agent-loop-step.js";
import type { DomainEventJournalError, RepositoryFailure } from "./errors.js";
import type { TransactionScope } from "./session.js";

export const SANDBOX_UNAVAILABLE_ATTENTION_CLAIM_TTL_MS = 30_000;
export const SANDBOX_UNAVAILABLE_ATTENTION_BATCH_MAX = 100;

/** Immutable P9 source for a provider that could not meet the pinned process policy. */
export interface SandboxProviderUnavailableFactV1 {
  readonly attentionFactId: string;
  readonly eventId: EventId;
  readonly projectId: ProjectId;
  readonly executionId: ExecutionId;
  readonly workspaceId: WorkspaceId;
  readonly episodeBinding: ExecutionEpisodeBinding;
  readonly policyRevision: number;
  readonly policyDigest: string;
  readonly profileId: SandboxProfile;
  readonly providerId: SandboxProviderId;
  readonly providerVersion: string;
  readonly probeEvidenceRef: string | null;
  readonly failureCode: string;
  readonly firstDetectedAt: string;
}

export interface RecordSandboxProviderUnavailableInput {
  readonly outcome: Omit<
    SandboxProviderUnavailableFactV1,
    "attentionFactId" | "eventId" | "firstDetectedAt"
  >;
  readonly fence: AgentLoopStepFence;
  readonly firstDetectedAt: string;
}

export type SandboxProviderUnavailableStoreError =
  | RepositoryFailure<"SandboxProviderUnavailableStore">
  | DomainEventJournalError
  | {
      readonly _tag: "SandboxProviderUnavailableFactInvariantConflict";
      readonly reason: string;
    }
  | {
      readonly _tag: "LeaseFencingRejected";
      readonly executionId: ExecutionId;
      readonly generation: number;
    };

export interface SandboxProviderUnavailableStoreService {
  readonly record: (
    input: RecordSandboxProviderUnavailableInput,
  ) => Effect.Effect<
    SandboxProviderUnavailableFactV1,
    SandboxProviderUnavailableStoreError,
    TransactionScope
  >;
  readonly findByExecutionAndRevision: (
    executionId: ExecutionId,
    policyRevision: number,
  ) => Effect.Effect<
    SandboxProviderUnavailableFactV1 | undefined,
    SandboxProviderUnavailableStoreError,
    TransactionScope
  >;
  readonly findByEventId: (
    eventId: EventId,
  ) => Effect.Effect<
    SandboxProviderUnavailableFactV1 | undefined,
    SandboxProviderUnavailableStoreError,
    TransactionScope
  >;
  readonly list: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<SandboxProviderUnavailableFactV1>,
    SandboxProviderUnavailableStoreError,
    TransactionScope
  >;
}

export class SandboxProviderUnavailableStore extends Context.Service<
  SandboxProviderUnavailableStore,
  SandboxProviderUnavailableStoreService
>()("arbor/SandboxProviderUnavailableStore") {}

export interface SandboxProviderUnavailableAttentionQueueClaim {
  readonly projectId: ProjectId;
  readonly attentionFactId: string;
  readonly workspaceId: WorkspaceId;
  readonly claimId: string;
  readonly claimExpiresAt: string;
  readonly attemptCount: number;
  readonly enqueuedAt: string;
}

export interface SandboxProviderUnavailableAttentionQueueService {
  readonly claimBatch: (input: {
    readonly projectId: ProjectId;
    readonly now: string;
    readonly claimTtlMs: number;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<SandboxProviderUnavailableAttentionQueueClaim>,
    SandboxProviderUnavailableStoreError,
    TransactionScope
  >;
  readonly consume: (input: {
    readonly claim: SandboxProviderUnavailableAttentionQueueClaim;
    readonly now: string;
  }) => Effect.Effect<
    SandboxProviderUnavailableFactV1 | undefined,
    SandboxProviderUnavailableStoreError,
    TransactionScope
  >;
  readonly rearm: (
    fact: SandboxProviderUnavailableFactV1,
  ) => Effect.Effect<
    void,
    SandboxProviderUnavailableStoreError,
    TransactionScope
  >;
}

export class SandboxProviderUnavailableAttentionQueue extends Context.Service<
  SandboxProviderUnavailableAttentionQueue,
  SandboxProviderUnavailableAttentionQueueService
>()("arbor/SandboxProviderUnavailableAttentionQueue") {}
