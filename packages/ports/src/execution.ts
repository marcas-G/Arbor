import type {
  AgentExecutionState,
  CommandSubmissionContext,
  Execution,
  ExecutionFocus,
  ExecutionId,
  ExecutionSettlement,
  LeaseGeneration,
  WaitSpec,
  WakeReason,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type {
  ExecutionDriverError,
  ExecutionRepositoryError,
  ExecutionSchedulerError,
  LeaseFencingRejected,
  ReconciliationSourceError,
  RunnableWorkSourceError,
  SchedulerTimerStoreError,
  WorkerDispatchError,
  WorkWaitStoreError,
} from "./errors.js";
import type { TransactionScope } from "./session.js";

export interface LeaseRecord {
  readonly executionId: ExecutionId;
  readonly workerId: string;
  readonly generation: LeaseGeneration;
  readonly expiresAt: string;
  readonly updatedAt: string;
}

export interface ExecutionRepositoryService {
  readonly tryAdmitMainExecution: (
    execution: Execution,
  ) => Effect.Effect<
    Option.Option<Execution>,
    ExecutionRepositoryError,
    TransactionScope
  >;
  readonly admitExecution: (
    execution: Execution,
  ) => Effect.Effect<void, ExecutionRepositoryError, TransactionScope>;
  readonly findById: (
    executionId: ExecutionId,
  ) => Effect.Effect<
    Option.Option<Execution>,
    ExecutionRepositoryError,
    TransactionScope
  >;
  readonly findActiveMainByWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<
    Option.Option<Execution>,
    ExecutionRepositoryError,
    TransactionScope
  >;
  readonly requestStop: (
    executionId: ExecutionId,
    stopRequestedAt: string,
  ) => Effect.Effect<void, ExecutionRepositoryError, TransactionScope>;
  readonly settle: (
    executionId: ExecutionId,
    settlement: ExecutionSettlement,
    settledAt: string,
  ) => Effect.Effect<void, ExecutionRepositoryError, TransactionScope>;
  readonly currentLease: (
    executionId: ExecutionId,
  ) => Effect.Effect<
    Option.Option<LeaseRecord>,
    ExecutionRepositoryError,
    TransactionScope
  >;
  readonly tryAcquireLease: (
    executionId: ExecutionId,
    workerId: string,
    expiresAt: string,
  ) => Effect.Effect<
    Option.Option<LeaseRecord>,
    ExecutionRepositoryError,
    TransactionScope
  >;
  readonly renewLease: (
    executionId: ExecutionId,
    workerId: string,
    generation: LeaseGeneration,
    expiresAt: string,
  ) => Effect.Effect<
    Option.Option<LeaseRecord>,
    ExecutionRepositoryError,
    TransactionScope
  >;
  readonly releaseLease: (
    executionId: ExecutionId,
    workerId: string,
    generation: LeaseGeneration,
  ) => Effect.Effect<void, ExecutionRepositoryError, TransactionScope>;
  readonly findExpiredActiveExecutions: (
    now: string,
  ) => Effect.Effect<
    ReadonlyArray<Execution>,
    ExecutionRepositoryError,
    TransactionScope
  >;
  readonly findUnsettledExecutions: () => Effect.Effect<
    ReadonlyArray<Execution>,
    ExecutionRepositoryError,
    TransactionScope
  >;
}

export class ExecutionRepository extends Context.Service<
  ExecutionRepository,
  ExecutionRepositoryService
>()("arbor/ExecutionRepository") {}

export interface LeaseServiceService {
  readonly acquire: (
    executionId: ExecutionId,
    workerId: string,
  ) => Effect.Effect<
    LeaseRecord,
    LeaseFencingRejected | ExecutionRepositoryError,
    TransactionScope
  >;
  readonly renew: (
    executionId: ExecutionId,
    workerId: string,
    generation: LeaseGeneration,
  ) => Effect.Effect<
    LeaseRecord,
    LeaseFencingRejected | ExecutionRepositoryError,
    TransactionScope
  >;
  readonly release: (
    executionId: ExecutionId,
    workerId: string,
    generation: LeaseGeneration,
  ) => Effect.Effect<void, ExecutionRepositoryError, TransactionScope>;
  readonly invalidateExpired: (
    now: string,
  ) => Effect.Effect<number, ExecutionRepositoryError, TransactionScope>;
}

export class LeaseService extends Context.Service<
  LeaseService,
  LeaseServiceService
>()("arbor/LeaseService") {}

export interface DispatchTicket {
  readonly dispatchId: string;
  readonly acceptedAt: string;
}

export interface WorkerDispatchPortService {
  readonly dispatch: (request: {
    readonly executionId: ExecutionId;
    readonly workspaceId: WorkspaceId;
    readonly workerKind: "Agent" | "Verifier";
  }) => Effect.Effect<DispatchTicket, WorkerDispatchError>;
}

export class WorkerDispatchPort extends Context.Service<
  WorkerDispatchPort,
  WorkerDispatchPortService
>()("arbor/WorkerDispatchPort") {}

export interface ExecutionDriverPortService {
  readonly drive: (input: {
    readonly execution: Execution;
    readonly agentExecutionState: AgentExecutionState;
    readonly wakeReason: WakeReason;
    readonly context: CommandSubmissionContext;
    readonly safetyGate: RuntimeSafetyGateService;
  }) => Effect.Effect<ExecutionSettlement, ExecutionDriverError>;
}

export class ExecutionDriverPort extends Context.Service<
  ExecutionDriverPort,
  ExecutionDriverPortService
>()("arbor/ExecutionDriverPort") {}

export type ExecutionActivity =
  | { readonly _tag: "ProviderTurn"; readonly fingerprint: string }
  | { readonly _tag: "ToolInvocation"; readonly fingerprint: string }
  | { readonly _tag: "SpecialistAction"; readonly fingerprint: string };

export type SafetyDecision = "Continue" | "Stop";

export interface RuntimeSafetyGateService {
  readonly admitActivity: (
    executionId: ExecutionId,
    activity: ExecutionActivity,
  ) => Effect.Effect<SafetyDecision>;
}

export class RuntimeSafetyGate extends Context.Service<
  RuntimeSafetyGate,
  RuntimeSafetyGateService
>()("arbor/RuntimeSafetyGate") {}

export type SchedulerDecision =
  | { readonly _tag: "Noop"; readonly reason: "ActiveMainExecution" }
  | { readonly _tag: "Admit"; readonly focus: ExecutionFocus }
  | { readonly _tag: "SelectCurrentWork"; readonly workId: WorkId }
  | { readonly _tag: "Idle" };

export interface WorkWait {
  readonly workId: WorkId;
  readonly waitSpec: WaitSpec;
  readonly registeredAt: string;
  readonly updatedAt: string;
}

export interface SchedulerTimer {
  readonly timerId: string;
  readonly workspaceId: WorkspaceId;
  readonly workId: WorkId | null;
  readonly kind: "TimeReached";
  readonly fireAt: string;
  readonly createdAt: string;
}

export interface ExecutionSchedulerService {
  readonly reevaluate: (
    workspaceId: WorkspaceId,
    wakeReason: WakeReason,
  ) => Effect.Effect<SchedulerDecision, ExecutionSchedulerError>;
  readonly registerWorkWait: (
    wait: WorkWait,
  ) => Effect.Effect<void, WorkWaitStoreError, TransactionScope>;
  readonly clearWorkWait: (
    workId: WorkId,
  ) => Effect.Effect<void, WorkWaitStoreError, TransactionScope>;
  readonly scheduleTimer: (
    timer: SchedulerTimer,
  ) => Effect.Effect<void, SchedulerTimerStoreError, TransactionScope>;
  readonly dueTimers: (
    now: string,
  ) => Effect.Effect<
    ReadonlyArray<SchedulerTimer>,
    SchedulerTimerStoreError,
    TransactionScope
  >;
}

export class ExecutionScheduler extends Context.Service<
  ExecutionScheduler,
  ExecutionSchedulerService
>()("arbor/ExecutionScheduler") {}

export interface RunnableWorkSourceService {
  readonly classify: (workspaceId: WorkspaceId) => Effect.Effect<
    {
      readonly current: Option.Option<WorkId>;
      readonly runnable: ReadonlyArray<WorkId>;
    },
    RunnableWorkSourceError
  >;
}

export class RunnableWorkSource extends Context.Service<
  RunnableWorkSource,
  RunnableWorkSourceService
>()("arbor/RunnableWorkSource") {}

export interface WorkWaitStoreService {
  readonly upsert: (
    wait: WorkWait,
  ) => Effect.Effect<void, WorkWaitStoreError, TransactionScope>;
  readonly findByWork: (
    workId: WorkId,
  ) => Effect.Effect<
    Option.Option<WorkWait>,
    WorkWaitStoreError,
    TransactionScope
  >;
  readonly clear: (
    workId: WorkId,
  ) => Effect.Effect<void, WorkWaitStoreError, TransactionScope>;
  readonly listActive: () => Effect.Effect<
    ReadonlyArray<WorkWait>,
    WorkWaitStoreError,
    TransactionScope
  >;
}

export class WorkWaitStore extends Context.Service<
  WorkWaitStore,
  WorkWaitStoreService
>()("arbor/WorkWaitStore") {}

export interface SchedulerTimerStoreService {
  readonly schedule: (
    timer: SchedulerTimer,
  ) => Effect.Effect<void, SchedulerTimerStoreError, TransactionScope>;
  readonly due: (
    now: string,
  ) => Effect.Effect<
    ReadonlyArray<SchedulerTimer>,
    SchedulerTimerStoreError,
    TransactionScope
  >;
  readonly cancel: (
    timerId: string,
  ) => Effect.Effect<void, SchedulerTimerStoreError, TransactionScope>;
}

export class SchedulerTimerStore extends Context.Service<
  SchedulerTimerStore,
  SchedulerTimerStoreService
>()("arbor/SchedulerTimerStore") {}

export type InvocationRef = string;

export interface ReconciliationSourceService {
  readonly pending: (
    executionId: ExecutionId,
  ) => Effect.Effect<
    ReadonlyArray<InvocationRef>,
    ReconciliationSourceError,
    TransactionScope
  >;
}

export class ReconciliationSource extends Context.Service<
  ReconciliationSource,
  ReconciliationSourceService
>()("arbor/ReconciliationSource") {}
