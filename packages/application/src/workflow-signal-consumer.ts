import type {
  DependencyId,
  ExecutionId,
  ExecutionSettlement,
  MessageId,
  VerificationId,
  VerificationVerdict,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
import type {
  DependencyRepositoryError,
  DependencyRepositoryService,
  ExecutionRepositoryError,
  ExecutionRepositoryService,
  ExecutionSchedulerService,
  InboxProjectionStoreError,
  InboxProjectionStoreService,
  MessageStoreError,
  MessageStoreService,
  TransactionOperationalFailure,
  TransactionPortService,
  WorkRepositoryError,
  WorkRepositoryService,
  WorkWaitStoreError,
  WorkWaitStoreService,
} from "@arbor/ports";
import {
  DependencyRepository,
  ExecutionRepository,
  ExecutionScheduler,
  InboxProjectionStore,
  MessageStore,
  TransactionPort,
  WorkRepository,
  WorkWaitStore,
} from "@arbor/ports";
import { Context, Effect, Layer, Option } from "effect";
import {
  admitSpecialistSettlement,
  type SpecialistSettlementAdmissionInput,
} from "./specialist-settlement.js";
import {
  deliverVerificationWake,
  type VerificationWakeError,
} from "./verification-wake.js";
import { deliverWakeSignal, type WakeSinkError } from "./wake-sink.js";

export interface WorkflowSignalEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly payload: unknown;
}

export type WorkflowSignalKind =
  | "DependencyRequested"
  | "DependencySatisfied"
  | "VerificationConcluded"
  | "DecisionRequested"
  | "ChildDelivered"
  | "SpecialistSettled";

export type WorkflowSignalOutcome =
  | { readonly _tag: "Ignored"; readonly eventId: string }
  | {
      readonly _tag: "Delivered";
      readonly eventId: string;
      readonly kind: WorkflowSignalKind;
      readonly workspaceId: WorkspaceId;
    };

export interface WorkflowSignalInvariantViolation {
  readonly _tag: "WorkflowSignalInvariantViolation";
  readonly eventId: string;
  readonly reason: string;
}

export type WorkflowSignalConsumerError =
  | WorkflowSignalInvariantViolation
  | DependencyRepositoryError
  | WorkRepositoryError
  | WorkWaitStoreError
  | MessageStoreError
  | ExecutionRepositoryError
  | InboxProjectionStoreError
  | TransactionOperationalFailure
  | WakeSinkError
  | VerificationWakeError;

export interface WorkflowSignalConsumerDependencies {
  readonly tx: Pick<TransactionPortService, "transact">;
  readonly waits: Pick<
    WorkWaitStoreService,
    "findByWork" | "listActive" | "clear"
  >;
  readonly works: Pick<WorkRepositoryService, "findById" | "listByWorkspace">;
  readonly scheduler: Pick<ExecutionSchedulerService, "reevaluate">;
  readonly dependencies: Pick<DependencyRepositoryService, "findById">;
  readonly messages: Pick<MessageStoreService, "findById">;
  readonly executions: Pick<ExecutionRepositoryService, "findById">;
  readonly inbox: Pick<
    InboxProjectionStoreService,
    "admitUpsert" | "countByKey"
  >;
}

export interface WorkflowSignalConsumerService {
  readonly consume: (
    events: ReadonlyArray<WorkflowSignalEvent>,
  ) => Effect.Effect<
    ReadonlyArray<WorkflowSignalOutcome>,
    WorkflowSignalConsumerError
  >;
}

export class WorkflowSignalConsumer extends Context.Service<
  WorkflowSignalConsumer,
  WorkflowSignalConsumerService
>()("arbor/WorkflowSignalConsumer") {}

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

const invariant = (
  event: WorkflowSignalEvent,
  reason: string,
): WorkflowSignalInvariantViolation => ({
  _tag: "WorkflowSignalInvariantViolation",
  eventId: event.eventId,
  reason,
});

const delivered = (
  event: WorkflowSignalEvent,
  kind: WorkflowSignalKind,
  workspaceId: WorkspaceId,
): WorkflowSignalOutcome => ({
  _tag: "Delivered",
  eventId: event.eventId,
  kind,
  workspaceId,
});

const deliverDependencySatisfied = (
  event: WorkflowSignalEvent,
  deps: WorkflowSignalConsumerDependencies,
): Effect.Effect<WorkflowSignalOutcome, WorkflowSignalConsumerError> =>
  Effect.gen(function* () {
    const payload = recordOf(event.payload);
    if (payload === null || typeof payload.dependencyId !== "string") {
      return yield* Effect.fail(invariant(event, "missing dependencyId"));
    }
    const dependencyId = payload.dependencyId as DependencyId;
    const dependency = yield* deps.tx.transact(
      deps.dependencies.findById(dependencyId),
    );
    if (Option.isNone(dependency)) {
      return yield* Effect.fail(
        invariant(event, `dependency not found: ${dependencyId}`),
      );
    }
    const work = yield* deps.tx.transact(
      deps.works.findById(dependency.value.consumerWorkId),
    );
    if (Option.isNone(work)) {
      return yield* Effect.fail(
        invariant(
          event,
          `consumer work not found: ${dependency.value.consumerWorkId}`,
        ),
      );
    }
    yield* deliverWakeSignal(
      {
        workspaceId: work.value.workspaceId,
        reason: "DependencySatisfied",
        detail: {
          dependencyId,
          toRevision:
            typeof payload.satisfiedAtDependencyRevision === "number"
              ? payload.satisfiedAtDependencyRevision
              : Number(dependency.value.revision),
        },
      },
      deps,
    );
    return delivered(event, "DependencySatisfied", work.value.workspaceId);
  });

const deliverDependencyRequested = (
  event: WorkflowSignalEvent,
  deps: WorkflowSignalConsumerDependencies,
): Effect.Effect<WorkflowSignalOutcome, WorkflowSignalConsumerError> =>
  Effect.gen(function* () {
    const payload = recordOf(event.payload);
    if (
      payload === null ||
      typeof payload.dependencyId !== "string" ||
      typeof payload.producerBinding !== "object" ||
      payload.producerBinding === null
    ) {
      return yield* Effect.fail(
        invariant(event, "missing dependencyId/producerBinding"),
      );
    }
    const binding = payload.producerBinding as Record<string, unknown>;
    let producerWorkspaceId: WorkspaceId | null = null;
    if (
      binding._tag === "WorkspaceBound" &&
      typeof binding.workspaceId === "string"
    ) {
      producerWorkspaceId = binding.workspaceId as WorkspaceId;
    } else if (
      binding._tag === "WorkBound" &&
      typeof binding.workId === "string"
    ) {
      const producerWork = yield* deps.tx.transact(
        deps.works.findById(binding.workId as WorkId),
      );
      if (Option.isSome(producerWork)) {
        producerWorkspaceId = producerWork.value.workspaceId;
      }
    }
    if (producerWorkspaceId === null) {
      return { _tag: "Ignored", eventId: event.eventId };
    }
    const dependencyId = payload.dependencyId as DependencyId;
    yield* deps.tx.transact(
      deps.inbox.admitUpsert({
        recipientWorkspaceId: producerWorkspaceId,
        entryKey: `dep-request:${dependencyId}:${String(payload.revision ?? 0)}`,
        kind: "Message",
        summary: `Dependency request ${dependencyId}: ${JSON.stringify(payload.expectedDeliverable ?? {})}`,
        admittedAt: event.occurredAt,
      }),
    );
    yield* deliverWakeSignal(
      {
        workspaceId: producerWorkspaceId,
        reason: "InputArrived",
        detail: { dependencyId },
      },
      deps,
    );
    return delivered(event, "DependencyRequested", producerWorkspaceId);
  });

const deliverVerificationConcluded = (
  event: WorkflowSignalEvent,
  deps: WorkflowSignalConsumerDependencies,
): Effect.Effect<WorkflowSignalOutcome, WorkflowSignalConsumerError> =>
  Effect.gen(function* () {
    const payload = recordOf(event.payload);
    if (
      payload === null ||
      typeof payload.verificationId !== "string" ||
      typeof payload.workId !== "string" ||
      typeof payload.targetWorkRevision !== "number" ||
      (payload.verdict !== "Pass" &&
        payload.verdict !== "Fail" &&
        payload.verdict !== "Unknown")
    ) {
      return yield* Effect.fail(
        invariant(event, "invalid VerificationConcluded payload"),
      );
    }
    const workId = payload.workId as WorkId;
    const work = yield* deps.tx.transact(deps.works.findById(workId));
    if (Option.isNone(work)) {
      return yield* Effect.fail(invariant(event, `work not found: ${workId}`));
    }
    yield* deliverVerificationWake(
      {
        verificationId: payload.verificationId as VerificationId,
        workId,
        targetWorkRevision: payload.targetWorkRevision as WorkRevision,
        verdict: payload.verdict as VerificationVerdict,
        ownerWorkspaceId: work.value.workspaceId,
      },
      deps,
    );
    return delivered(event, "VerificationConcluded", work.value.workspaceId);
  });

const deliverMessageSignal = (
  event: WorkflowSignalEvent,
  deps: WorkflowSignalConsumerDependencies,
): Effect.Effect<WorkflowSignalOutcome, WorkflowSignalConsumerError> =>
  Effect.gen(function* () {
    const payload = recordOf(event.payload);
    if (payload === null || typeof payload.messageId !== "string") {
      return yield* Effect.fail(invariant(event, "missing messageId"));
    }
    const messageId = payload.messageId as MessageId;
    const stored = yield* deps.tx.transact(deps.messages.findById(messageId));
    if (Option.isNone(stored)) {
      return yield* Effect.fail(
        invariant(event, `message not found: ${messageId}`),
      );
    }
    const message = stored.value.message;
    if (message.kind === "DecisionRequest") {
      yield* deliverWakeSignal(
        {
          workspaceId: message.recipientWorkspaceId,
          reason: "InputArrived",
          detail: { messageId },
        },
        deps,
      );
      return delivered(
        event,
        "DecisionRequested",
        message.recipientWorkspaceId,
      );
    }
    if (message.kind === "Deliver") {
      yield* deliverWakeSignal(
        {
          workspaceId: message.recipientWorkspaceId,
          reason: "ChildDelivered",
          detail: {
            messageId,
            ...(typeof payload.deliverableId === "string"
              ? { deliverableId: payload.deliverableId }
              : {}),
          },
        },
        deps,
      );
      return delivered(event, "ChildDelivered", message.recipientWorkspaceId);
    }
    return { _tag: "Ignored", eventId: event.eventId };
  });

const specialistSummary = (
  executionId: ExecutionId,
  settlement: ExecutionSettlement,
): string => `Specialist ${executionId} settled ${settlement._tag}`;

const deliverSpecialistSettled = (
  event: WorkflowSignalEvent,
  deps: WorkflowSignalConsumerDependencies,
): Effect.Effect<WorkflowSignalOutcome, WorkflowSignalConsumerError> =>
  Effect.gen(function* () {
    const payload = recordOf(event.payload);
    if (payload === null || typeof payload.executionId !== "string") {
      return yield* Effect.fail(invariant(event, "missing executionId"));
    }
    const executionId = payload.executionId as ExecutionId;
    const execution = yield* deps.tx.transact(
      deps.executions.findById(executionId),
    );
    if (Option.isNone(execution)) {
      return yield* Effect.fail(
        invariant(event, `execution not found: ${executionId}`),
      );
    }
    const specialist = execution.value;
    if (
      specialist.binding._tag !== "ExecutionBoundAgentBinding" ||
      specialist.binding.parentExecutionId === null
    ) {
      return { _tag: "Ignored", eventId: event.eventId };
    }
    if (specialist.state.status !== "Settled") {
      return yield* Effect.fail(
        invariant(event, `execution is not settled: ${executionId}`),
      );
    }
    const parent = yield* deps.tx.transact(
      deps.executions.findById(specialist.binding.parentExecutionId),
    );
    if (Option.isNone(parent)) {
      return yield* Effect.fail(
        invariant(
          event,
          `parent execution not found: ${specialist.binding.parentExecutionId}`,
        ),
      );
    }
    const admission: SpecialistSettlementAdmissionInput = {
      specialistExecutionId: executionId,
      parentWorkspaceId: parent.value.workspaceId,
      settlement: specialist.state.settlement,
      summary: specialistSummary(executionId, specialist.state.settlement),
      occurredAt: event.occurredAt,
    };
    yield* deps.tx.transact(admitSpecialistSettlement(admission, deps));
    yield* deliverWakeSignal(
      {
        workspaceId: parent.value.workspaceId,
        reason: "InputArrived",
        detail: { executionId },
      },
      deps,
    );
    return delivered(event, "SpecialistSettled", parent.value.workspaceId);
  });

const deliverEvent = (
  event: WorkflowSignalEvent,
  deps: WorkflowSignalConsumerDependencies,
): Effect.Effect<WorkflowSignalOutcome, WorkflowSignalConsumerError> => {
  switch (event.eventType) {
    case "DependencyDeclared":
      return deliverDependencyRequested(event, deps);
    case "DependencySatisfied":
      return deliverDependencySatisfied(event, deps);
    case "VerificationConcluded":
      return deliverVerificationConcluded(event, deps);
    case "MessageSent":
      return deliverMessageSignal(event, deps);
    case "ExecutionSettled":
      return deliverSpecialistSettled(event, deps);
    default:
      return Effect.succeed({ _tag: "Ignored", eventId: event.eventId });
  }
};

export const runWorkflowSignalConsumer = (
  events: ReadonlyArray<WorkflowSignalEvent>,
  deps: WorkflowSignalConsumerDependencies,
): Effect.Effect<
  ReadonlyArray<WorkflowSignalOutcome>,
  WorkflowSignalConsumerError
> => Effect.forEach(events, (event) => deliverEvent(event, deps));

export const makeWorkflowSignalConsumer = (
  dependencies: WorkflowSignalConsumerDependencies,
): WorkflowSignalConsumerService => ({
  consume: (events) => runWorkflowSignalConsumer(events, dependencies),
});

export const WorkflowSignalConsumerLive: Layer.Layer<
  WorkflowSignalConsumer,
  never,
  | TransactionPort
  | WorkWaitStore
  | WorkRepository
  | ExecutionScheduler
  | DependencyRepository
  | MessageStore
  | ExecutionRepository
  | InboxProjectionStore
> = Layer.effect(
  WorkflowSignalConsumer,
  Effect.gen(function* () {
    return makeWorkflowSignalConsumer({
      tx: yield* TransactionPort,
      waits: yield* WorkWaitStore,
      works: yield* WorkRepository,
      scheduler: yield* ExecutionScheduler,
      dependencies: yield* DependencyRepository,
      messages: yield* MessageStore,
      executions: yield* ExecutionRepository,
      inbox: yield* InboxProjectionStore,
    });
  }),
);
