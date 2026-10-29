import type {
  ContextEpochNumber,
  ExecutionId,
  ProviderTurnId,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { LeaseFencingRejected, RepositoryFailure } from "./errors.js";
import type { TransactionScope } from "./session.js";
import type { SessionWriteFence } from "./session-timeline.js";

export interface ConversationCheckpointFrontier {
  readonly createdAt: string;
  readonly messageId: string;
}

export type ConversationCheckpointKind = "Summary" | "ProviderNative";

export const isConversationCheckpointKind = (
  value: unknown,
): value is ConversationCheckpointKind =>
  value === "Summary" || value === "ProviderNative";

/** Shared strict codec for persisted and projected owner checkpoint bindings. */
export const isValidConversationCheckpointBinding = (
  kind: unknown,
  checkpointRef: unknown,
  bindingFingerprint: unknown,
): kind is ConversationCheckpointKind => {
  if (kind === "Summary") {
    return (
      typeof checkpointRef === "string" &&
      /^[0-9a-f]{64}$/u.test(checkpointRef) &&
      bindingFingerprint === null
    );
  }
  if (kind === "ProviderNative") {
    return (
      typeof checkpointRef === "string" &&
      checkpointRef.length > 0 &&
      typeof bindingFingerprint === "string" &&
      /^p16fp_[0-9a-f]{64}$/u.test(bindingFingerprint)
    );
  }
  return false;
};

export interface ConversationCheckpointSourceMessageV1 {
  readonly createdAt: string;
  readonly messageId: string;
  readonly bodyRef: string;
  readonly bodySha256: string;
  readonly responseBodySha256: string;
  readonly answeredJobRevision: number;
  readonly responseExecutionId: ExecutionId;
  readonly attemptNo: number;
  /** Job revision recorded on the exact ConversationResponseEpisode at
   * admission; it is related to answeredJobRevision by P17 transitions and
   * must not be assumed equal. */
  readonly admissionJobRevision: number;
}

/** Canonical source manifest for one immutable owner checkpoint. The current
 * Running input is recorded separately and is never part of coveredSources. */
export interface ConversationCheckpointSourceManifestV1 {
  readonly version: 1;
  readonly rootWorkspaceId: WorkspaceId;
  readonly fromEpoch: ContextEpochNumber;
  readonly toEpoch: ContextEpochNumber;
  readonly fromFrontier: ConversationCheckpointFrontier | null;
  readonly coveredThrough: ConversationCheckpointFrontier | null;
  readonly coveredSources: ReadonlyArray<ConversationCheckpointSourceMessageV1>;
  readonly currentMessageId: string;
  readonly currentRunningJobRevision: number;
  readonly currentRunningAttemptNo: number;
  readonly currentAdmissionJobRevision: number;
  readonly checkpointKind: ConversationCheckpointKind;
  readonly producerExecutionId: ExecutionId;
  readonly producerProviderTurnId: ProviderTurnId;
  readonly producerManifestId: string;
}

export interface ConversationCheckpointOwner {
  readonly rootWorkspaceId: WorkspaceId;
  readonly contextEpoch: ContextEpochNumber;
  readonly coveredThrough: ConversationCheckpointFrontier | null;
  readonly checkpointKind: ConversationCheckpointKind | null;
  readonly checkpointRef: string | null;
  readonly bindingFingerprint: string | null;
  readonly sourceManifestJson: string | null;
  readonly producerExecutionId: ExecutionId | null;
  readonly producerProviderTurnId: ProviderTurnId | null;
  readonly updatedAt: string;
}

export interface InitializeConversationCheckpointOwnerInput {
  readonly rootWorkspaceId: WorkspaceId;
  readonly initializedAt: string;
  readonly fence: SessionWriteFence;
}

export interface CommitConversationCheckpointOwnerInput {
  readonly rootWorkspaceId: WorkspaceId;
  readonly expectedContextEpoch: ContextEpochNumber;
  readonly expectedCoveredThrough: ConversationCheckpointFrontier | null;
  readonly nextContextEpoch: ContextEpochNumber;
  readonly coveredThrough: ConversationCheckpointFrontier | null;
  readonly checkpointKind: ConversationCheckpointKind;
  readonly checkpointRef: string;
  readonly bindingFingerprint: string | null;
  readonly sourceManifest: ConversationCheckpointSourceManifestV1;
  readonly producerExecutionId: ExecutionId;
  readonly producerProviderTurnId: ProviderTurnId;
  readonly updatedAt: string;
  readonly fence: SessionWriteFence;
}

export interface ConversationCheckpointOwnerConflict {
  readonly _tag: "ConversationCheckpointOwnerConflict";
  readonly reason:
    | "MalformedOwner"
    | "FenceOwnerMismatch"
    | "ExpectedEpochMismatch"
    | "ExpectedFrontierMismatch"
    | "InvalidEpochTransition"
    | "InvalidFrontierTransition"
    | "InvalidCheckpointBinding"
    | "InvalidSourceManifest";
}

export type ConversationCheckpointStoreError =
  | RepositoryFailure<"ConversationCheckpointStore">
  | ConversationCheckpointOwnerConflict
  | LeaseFencingRejected;

export interface ConversationCheckpointStoreService {
  readonly findOwner: (
    rootWorkspaceId: WorkspaceId,
  ) => Effect.Effect<
    Option.Option<ConversationCheckpointOwner>,
    ConversationCheckpointStoreError,
    TransactionScope
  >;
  readonly initializeIfAbsent: (
    input: InitializeConversationCheckpointOwnerInput,
  ) => Effect.Effect<
    ConversationCheckpointOwner,
    ConversationCheckpointStoreError,
    TransactionScope
  >;
  readonly commit: (
    input: CommitConversationCheckpointOwnerInput,
  ) => Effect.Effect<
    ConversationCheckpointOwner,
    ConversationCheckpointStoreError,
    TransactionScope
  >;
}

export class ConversationCheckpointStore extends Context.Service<
  ConversationCheckpointStore,
  ConversationCheckpointStoreService
>()("arbor/ConversationCheckpointStore") {}
