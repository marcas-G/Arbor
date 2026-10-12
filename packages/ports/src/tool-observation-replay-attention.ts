import type {
  EventId,
  ExecutionId,
  ProjectId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type {
  DomainEventJournalError,
  LeaseFencingRejected,
  RepositoryFailure,
} from "./errors.js";
import type { TransactionScope } from "./session.js";
import type { ToolExecutionContext } from "./tool.js";
import type { ToolObservationReplayFailureCode } from "./tool-observation-evidence.js";

export interface ToolObservationReplayAttentionFact {
  readonly attentionFactId: string;
  readonly eventId: EventId;
  readonly projectId: ProjectId;
  readonly executionId: ExecutionId;
  readonly targetWorkspaceId: WorkspaceId;
  readonly logicalActionId: string;
  readonly providerTurnId: string;
  readonly callRef: string;
  readonly invocationId: ToolInvocationId;
  readonly failureCode: ToolObservationReplayFailureCode;
  readonly firstDetectedAt: string;
}

export interface RecordToolObservationReplayFailureInput
  extends Omit<
    ToolObservationReplayAttentionFact,
    "attentionFactId" | "eventId"
  > {
  readonly executionFence: NonNullable<ToolExecutionContext["executionFence"]>;
}

export type ToolObservationReplayAttentionFactStoreError =
  | RepositoryFailure<"ToolObservationReplayAttentionFactStore">
  | DomainEventJournalError
  | LeaseFencingRejected
  | {
      readonly _tag: "ToolObservationReplayAttentionFactInvariantConflict";
      readonly reason: string;
    };

export interface ToolObservationReplayAttentionFactStoreService {
  readonly recordFailure: (
    input: RecordToolObservationReplayFailureInput,
  ) => Effect.Effect<
    ToolObservationReplayAttentionFact,
    ToolObservationReplayAttentionFactStoreError,
    TransactionScope
  >;
  readonly findById: (
    attentionFactId: string,
  ) => Effect.Effect<
    Option.Option<ToolObservationReplayAttentionFact>,
    ToolObservationReplayAttentionFactStoreError,
    TransactionScope
  >;
}

export class ToolObservationReplayAttentionFactStore extends Context.Service<
  ToolObservationReplayAttentionFactStore,
  ToolObservationReplayAttentionFactStoreService
>()("arbor/ToolObservationReplayAttentionFactStore") {}
