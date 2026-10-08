import type {
  ExecutionId,
  ExecutionSettlement,
  LeaseGeneration,
  ProviderTurnId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type {
  LeaseFencingRejected,
  ProviderFailure,
  RepositoryFailure,
} from "./errors.js";
import type { TransactionScope } from "./session.js";

export interface AgentLoopStepIdentity {
  readonly executionId: ExecutionId;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
}

export type AgentLoopStepState =
  | "Prepared"
  | "ProviderResultAvailable"
  | "OutputRejected"
  | "OutputAccepted"
  | "ActionsInProgress"
  | "StepEffectsCommitted"
  | "NextStepReady"
  | "SettlementProposed";

export interface AgentLoopStepRecord {
  readonly identity: AgentLoopStepIdentity;
  readonly predecessor?: AgentLoopStepIdentity;
  readonly providerTurnId: ProviderTurnId;
  readonly manifestId?: string;
  readonly state: AgentLoopStepState;
  readonly decoderVersion?: string;
  readonly providerFailure?: ProviderFailure;
  readonly repairDisposition?: unknown;
  readonly successor?: AgentLoopStepIdentity & {
    readonly providerTurnId: ProviderTurnId;
  };
  readonly nextStepReason?: string;
  readonly decodedOutputHash?: string;
  readonly modelOutputSessionSequence?: number;
  readonly nextActionIndex: number;
  readonly settlement?: ExecutionSettlement;
  readonly migrationProvenance?: unknown;
  readonly revision: number;
  readonly updatedAt: string;
}

export type AgentLoopStepActionState =
  | "Pending"
  | "Applied"
  | "SkippedStale"
  | "SkippedEarlySettlement"
  | "TerminalRejected"
  | "ReconciliationPending";

export interface AgentLoopStepActionRecord {
  readonly identity: AgentLoopStepIdentity;
  readonly actionIndex: number;
  readonly logicalActionId: string;
  readonly callRef: string;
  readonly routeKind: "Executable" | "Control";
  readonly actionKind: string;
  readonly inputHash: string;
  readonly state: AgentLoopStepActionState;
  readonly resultRef?: string;
  readonly settlementRef?: string;
  readonly disposition?: unknown;
  readonly observationSourceRef?: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface AgentLoopStepFence {
  readonly executionId: ExecutionId;
  readonly workerId: string;
  readonly workerIncarnationId: string;
  readonly fencingGeneration: LeaseGeneration;
}

export interface AgentLoopStepProviderTurnLink {
  readonly identity: AgentLoopStepIdentity;
  readonly overflowOrdinal: 0;
  readonly role: "Inference" | "OverflowCompaction" | "OverflowReplacement";
  readonly providerTurnId: ProviderTurnId;
  readonly predecessorProviderTurnId?: ProviderTurnId;
  readonly contextEpoch: import("@arbor/domain").ContextEpochNumber;
  readonly manifestId?: string;
  readonly state: "Prepared" | "SettledSuccess" | "SettledFailure";
  readonly createdAt: string;
}

export type AgentLoopStepStoreError = RepositoryFailure<"AgentLoopStepStore">;

export interface AgentLoopStepInvariantConflict {
  readonly _tag: "AgentLoopStepInvariantConflict";
  readonly reason: string;
}

type StepMutationError =
  | AgentLoopStepStoreError
  | AgentLoopStepInvariantConflict
  | LeaseFencingRejected;

export interface AgentLoopStepStoreService {
  readonly isAvailable: () => Effect.Effect<
    boolean,
    AgentLoopStepStoreError,
    TransactionScope
  >;
  readonly find: (
    identity: AgentLoopStepIdentity,
  ) => Effect.Effect<
    Option.Option<AgentLoopStepRecord>,
    AgentLoopStepStoreError,
    TransactionScope
  >;
  readonly findCurrent: (
    executionId: ExecutionId,
  ) => Effect.Effect<
    Option.Option<AgentLoopStepRecord>,
    AgentLoopStepStoreError,
    TransactionScope
  >;
  readonly createPrepared: (
    record: AgentLoopStepRecord,
    fence: AgentLoopStepFence,
  ) => Effect.Effect<AgentLoopStepRecord, StepMutationError, TransactionScope>;
  readonly transition: (
    input: {
      readonly identity: AgentLoopStepIdentity;
      readonly expectedRevision: number;
      readonly expectedState: AgentLoopStepState;
      readonly next: AgentLoopStepRecord;
    },
    fence: AgentLoopStepFence,
  ) => Effect.Effect<AgentLoopStepRecord, StepMutationError, TransactionScope>;
  readonly ensureSuccessor: (
    predecessor: AgentLoopStepIdentity,
    successor: AgentLoopStepRecord,
    fence: AgentLoopStepFence,
  ) => Effect.Effect<AgentLoopStepRecord, StepMutationError, TransactionScope>;
  readonly createAction: (
    record: AgentLoopStepActionRecord,
    fence: AgentLoopStepFence,
  ) => Effect.Effect<
    AgentLoopStepActionRecord,
    StepMutationError,
    TransactionScope
  >;
  readonly transitionAction: (
    input: {
      readonly identity: AgentLoopStepIdentity;
      readonly actionIndex: number;
      readonly expectedRevision: number;
      readonly expectedState: AgentLoopStepActionState;
      readonly next: AgentLoopStepActionRecord;
    },
    fence: AgentLoopStepFence,
  ) => Effect.Effect<
    AgentLoopStepActionRecord,
    StepMutationError,
    TransactionScope
  >;
  readonly listActions: (
    identity: AgentLoopStepIdentity,
  ) => Effect.Effect<
    ReadonlyArray<AgentLoopStepActionRecord>,
    AgentLoopStepStoreError,
    TransactionScope
  >;
  readonly ensureProviderTurnLink: (
    link: AgentLoopStepProviderTurnLink,
    fence: AgentLoopStepFence,
  ) => Effect.Effect<
    AgentLoopStepProviderTurnLink,
    StepMutationError,
    TransactionScope
  >;
  readonly listProviderTurnLinks: (
    identity: AgentLoopStepIdentity,
  ) => Effect.Effect<
    ReadonlyArray<AgentLoopStepProviderTurnLink>,
    AgentLoopStepStoreError,
    TransactionScope
  >;
  readonly findProviderTurnLinkByProviderTurnId: (
    providerTurnId: ProviderTurnId,
  ) => Effect.Effect<
    Option.Option<AgentLoopStepProviderTurnLink>,
    AgentLoopStepStoreError,
    TransactionScope
  >;
}

export class AgentLoopStepStore extends Context.Service<
  AgentLoopStepStore,
  AgentLoopStepStoreService
>()("arbor/AgentLoopStepStore") {}
