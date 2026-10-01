import type {
  ExecutionId,
  MessageId,
  ProjectId,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { ReasoningAttachment } from "./provider-extension.js";
import type { TransactionScope } from "./session.js";

export type ConversationFailureClass =
  | "TransientProviderUnavailable"
  | "AuthenticationFailed"
  | "RequestRejected"
  | "DeterministicModelFailure"
  | "ContextBlocked"
  | "ReconciliationRequired"
  | "ControlledInterruption"
  | "UnknownFailure";

export type ConversationAttentionReason =
  | "RetryBudgetExhausted"
  | "AuthenticationFailed"
  | "RequestRejected"
  | "DeterministicModelFailure"
  | "ContextBlocked"
  | "ReconciliationRequired"
  | "UnknownFailure"
  | "LegacyInterrupted";

export type ConversationResponseJobState =
  | { readonly _tag: "Queued" }
  | {
      readonly _tag: "Running";
      readonly attemptNo: number;
      readonly executionId: ExecutionId;
    }
  | {
      readonly _tag: "RetryScheduled";
      readonly attemptNo: number;
      readonly nextEligibleAt: string;
      readonly failureFingerprint: string;
    }
  | {
      readonly _tag: "NeedsAttention";
      readonly reason: ConversationAttentionReason;
      readonly failureFingerprint: string;
      readonly lastExecutionId?: ExecutionId;
    }
  | {
      readonly _tag: "Answered";
      readonly executionId: ExecutionId;
      readonly responseBody: string;
    }
  | {
      readonly _tag: "Cancelled";
      readonly reason: "HumanCancelled" | "ProjectClosed" | "ControlledStop";
    };

export interface ConversationResponseJob {
  readonly messageId: MessageId;
  readonly projectId: ProjectId;
  readonly rootWorkspaceId: WorkspaceId;
  readonly state: ConversationResponseJobState;
  readonly nextAttemptNo: number;
  readonly policyVersion: string;
  readonly providerReasoning: ReasoningAttachment | null;
  readonly lastFailureClass: ConversationFailureClass | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ConversationRetryDecision =
  | { readonly _tag: "Answer" }
  | { readonly _tag: "RetryAt"; readonly nextEligibleAt: string }
  | { readonly _tag: "Attention"; readonly reason: string }
  | { readonly _tag: "Cancel"; readonly reason: string };

export interface ConversationAttempt {
  readonly messageId: MessageId;
  readonly attemptNo: number;
  readonly executionId: ExecutionId;
  readonly admittedAt: string;
  readonly settledAt: string | null;
  readonly settlementKind: string | null;
  readonly failureClass: ConversationFailureClass | null;
  readonly failureFingerprint: string | null;
  readonly retryDecision: ConversationRetryDecision | null;
  readonly policyVersion: string;
}

export interface ConversationJobStoreError {
  readonly _tag: "ConversationJobStoreError";
  readonly cause: unknown;
}

export interface ConversationJobConflict {
  readonly _tag: "ConversationJobConflict";
  readonly messageId: MessageId;
  readonly reason: "AlreadyExists" | "RevisionOrStateMismatch";
}

export interface ConversationAttemptStoreError {
  readonly _tag: "ConversationAttemptStoreError";
  readonly cause: unknown;
}

export interface ConversationAttemptConflict {
  readonly _tag: "ConversationAttemptConflict";
  readonly messageId: MessageId;
  readonly attemptNo: number;
}

export interface ConversationResponseJobStoreService {
  readonly insert: (
    job: ConversationResponseJob,
  ) => Effect.Effect<
    void,
    ConversationJobConflict | ConversationJobStoreError,
    TransactionScope
  >;
  readonly find: (
    messageId: MessageId,
  ) => Effect.Effect<
    Option.Option<ConversationResponseJob>,
    ConversationJobStoreError,
    TransactionScope
  >;
  readonly findByExecution: (
    executionId: ExecutionId,
  ) => Effect.Effect<
    Option.Option<ConversationResponseJob>,
    ConversationJobStoreError,
    TransactionScope
  >;
  readonly listEligible: (
    now: string,
  ) => Effect.Effect<
    ReadonlyArray<ConversationResponseJob>,
    ConversationJobStoreError,
    TransactionScope
  >;
  readonly listRunning: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<ConversationResponseJob>,
    ConversationJobStoreError,
    TransactionScope
  >;
  readonly listForWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<
    ReadonlyArray<ConversationResponseJob>,
    ConversationJobStoreError,
    TransactionScope
  >;
  readonly projectsWithWork: () => Effect.Effect<
    ReadonlyArray<ProjectId>,
    ConversationJobStoreError,
    TransactionScope
  >;
  readonly transition: (input: {
    readonly messageId: MessageId;
    readonly expectedRevision: number;
    readonly expectedState: ConversationResponseJobState["_tag"];
    readonly next: ConversationResponseJob;
  }) => Effect.Effect<
    ConversationResponseJob,
    ConversationJobConflict | ConversationJobStoreError,
    TransactionScope
  >;
}

export class ConversationResponseJobStore extends Context.Service<
  ConversationResponseJobStore,
  ConversationResponseJobStoreService
>()("arbor/ConversationResponseJobStore") {}

export interface ConversationAttemptStoreService {
  readonly insert: (
    attempt: ConversationAttempt,
  ) => Effect.Effect<
    void,
    ConversationAttemptConflict | ConversationAttemptStoreError,
    TransactionScope
  >;
  readonly settle: (input: {
    readonly messageId: MessageId;
    readonly attemptNo: number;
    readonly settledAt: string;
    readonly settlementKind: string;
    readonly failureClass: ConversationFailureClass | null;
    readonly failureFingerprint: string | null;
    readonly retryDecision: ConversationRetryDecision;
  }) => Effect.Effect<
    void,
    ConversationAttemptConflict | ConversationAttemptStoreError,
    TransactionScope
  >;
  readonly list: (
    messageId: MessageId,
  ) => Effect.Effect<
    ReadonlyArray<ConversationAttempt>,
    ConversationAttemptStoreError,
    TransactionScope
  >;
}

export class ConversationAttemptStore extends Context.Service<
  ConversationAttemptStore,
  ConversationAttemptStoreService
>()("arbor/ConversationAttemptStore") {}

export type ProviderBreakerAdmission =
  | { readonly _tag: "Admitted"; readonly probe: boolean }
  | {
      readonly _tag: "Denied";
      readonly failureClass: ConversationFailureClass;
      readonly retryAt?: string;
    };

export interface ProviderDeploymentBreakerService {
  readonly admit: (input: {
    readonly bindingFingerprint: string;
    readonly configurationRevision: string;
    readonly executionId: ExecutionId;
    readonly now: string;
  }) => Effect.Effect<
    ProviderBreakerAdmission,
    ConversationJobStoreError,
    TransactionScope
  >;
  readonly recordSuccess: (input: {
    readonly bindingFingerprint: string;
    readonly configurationRevision: string;
    readonly now: string;
  }) => Effect.Effect<void, ConversationJobStoreError, TransactionScope>;
  readonly recordFailure: (input: {
    readonly bindingFingerprint: string;
    readonly configurationRevision: string;
    readonly failureClass: ConversationFailureClass;
    readonly now: string;
  }) => Effect.Effect<void, ConversationJobStoreError, TransactionScope>;
}

export class ProviderDeploymentBreaker extends Context.Service<
  ProviderDeploymentBreaker,
  ProviderDeploymentBreakerService
>()("arbor/ProviderDeploymentBreaker") {}
