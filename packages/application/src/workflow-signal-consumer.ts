import type {
  DependencyId,
  ExecutionId,
  ExecutionSettlement,
  MessageId,
  VerificationId,
  VerificationVerdict,
  WorkBlocker,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
import { decodeSupportedEventPayload } from "@arbor/domain";
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
  TransactionScope,
  WorkBlockerStoreError,
  WorkBlockerStoreService,
  WorkRepositoryError,
  WorkRepositoryService,
  WorkspaceRepositoryError,
  WorkspaceRepositoryService,
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
  WorkBlockerStore,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "@arbor/ports";
import { Context, Effect, Layer, Option } from "effect";
import type { AtomicConsumerApplyResult } from "./consumer-loop.js";
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
  /** Present on durable journal delivery; omitted only by legacy direct callers. */
  readonly eventVersion?: number;
  readonly occurredAt: string;
  readonly payload: unknown;
}

export type WorkflowSignalKind =
  | "DependencyRequested"
  | "DependencySatisfied"
  | "VerificationConcluded"
  | "ChildResultReady"
  | "DecisionRequested"
  | "ChildDelivered"
  | "WorkBlocked"
  | "WorkBlockerResolved"
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
  | WorkspaceRepositoryError
  | WorkWaitStoreError
  | WorkBlockerStoreError
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
  readonly workspaces: Pick<WorkspaceRepositoryService, "findById">;
  readonly scheduler: Pick<ExecutionSchedulerService, "reevaluate">;
  readonly dependencies: Pick<DependencyRepositoryService, "findById">;
  readonly messages: Pick<MessageStoreService, "findById">;
  readonly executions: Pick<ExecutionRepositoryService, "findById">;
  readonly inbox: Pick<
    InboxProjectionStoreService,
    | "admitUpsert"
    | "admitUpsertSequenced"
    | "countByKey"
    | "currentSequence"
    | "listUnconsumed"
    | "markConsumed"
  >;
  readonly blockers?: Pick<WorkBlockerStoreService, "findById">;
}

export interface WorkflowSignalConsumerService {
  readonly consume: (
    events: ReadonlyArray<WorkflowSignalEvent>,
  ) => Effect.Effect<
    ReadonlyArray<WorkflowSignalOutcome>,
    WorkflowSignalConsumerError
  >;
  readonly applyBlockedWorkEpisodeAtomically: (
    event: WorkflowSignalEvent,
  ) => Effect.Effect<
    AtomicConsumerApplyResult,
    WorkflowSignalConsumerError,
    TransactionScope
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

const matchesAdvancedInbox = (
  conditions: ReadonlyArray<import("@arbor/domain").WakeCondition>,
  workspaceId: WorkspaceId,
  sequence: number,
): boolean =>
  conditions.some(
    (condition) =>
      condition._tag === "InboxAdvanced" &&
      condition.workspaceId === workspaceId &&
      sequence > condition.observedSequence,
  );

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
    if (event.eventVersion !== undefined) {
      const decoded = decodeSupportedEventPayload(
        event.eventType,
        event.eventVersion,
        event.payload,
      );
      if (decoded._tag !== "Decoded") {
        return yield* Effect.fail(
          invariant(
            event,
            "unsupported or malformed VerificationConcluded version/payload",
          ),
        );
      }
    }
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
    if (payload.verdict === "Pass") {
      const owner = yield* deps.tx.transact(
        deps.workspaces.findById(work.value.workspaceId),
      );
      if (Option.isNone(owner)) {
        return yield* Effect.fail(
          invariant(event, `workspace not found: ${work.value.workspaceId}`),
        );
      }
      const parentWorkspaceId = owner.value.parentWorkspaceId;
      if (parentWorkspaceId !== null) {
        const verificationId = payload.verificationId as VerificationId;
        const targetWorkRevision = payload.targetWorkRevision as WorkRevision;
        yield* deps.tx.transact(
          deps.inbox.admitUpsert({
            recipientWorkspaceId: parentWorkspaceId,
            entryKey: `child-result:${verificationId}:${targetWorkRevision}`,
            kind: "Message",
            summary: `Child result ready for Work ${workId} revision ${targetWorkRevision}`,
            admittedAt: event.occurredAt,
          }),
        );
        yield* deliverWakeSignal(
          {
            workspaceId: parentWorkspaceId,
            reason: "InputArrived",
            detail: { verificationId, workId, targetWorkRevision },
          },
          deps,
        );
        return delivered(event, "ChildResultReady", parentWorkspaceId);
      }
    }
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

const wakeBlockedEpisodeIfInboxAdvanced = (
  event: WorkflowSignalEvent,
  executionId: ExecutionId,
  workspaceId: WorkspaceId,
  waitFor: Extract<
    import("@arbor/domain").CompletedResult,
    { readonly _tag: "Blocked" }
  >["waitFor"],
  deps: WorkflowSignalConsumerDependencies,
): Effect.Effect<void, WorkflowSignalConsumerError> =>
  Effect.gen(function* () {
    const inboxWait = waitFor.conditions.find(
      (condition) => condition._tag === "InboxAdvanced",
    );
    if (
      inboxWait === undefined ||
      !waitFor.conditions.some((condition) => condition._tag === "Manual") ||
      inboxWait.workspaceId !== workspaceId
    ) {
      return yield* Effect.fail(
        invariant(
          event,
          "Blocked settlement has no exact Manual+InboxAdvanced wait for its Workspace",
        ),
      );
    }
    const currentSequence = yield* deps.tx.transact(
      deps.inbox.currentSequence(inboxWait.workspaceId),
    );
    if (currentSequence <= inboxWait.observedSequence) return;
    yield* deliverWakeSignal(
      {
        workspaceId: inboxWait.workspaceId,
        reason: "InputArrived",
        detail: {
          observedSequence: inboxWait.observedSequence,
          currentSequence,
          sourceExecutionId: executionId,
        },
      },
      deps,
    );
  });

const deliverBlockedWorkSettlement = (
  event: WorkflowSignalEvent,
  executionId: ExecutionId,
  settlement: ExecutionSettlement,
  deps: WorkflowSignalConsumerDependencies,
): Effect.Effect<WorkflowSignalOutcome, WorkflowSignalConsumerError> =>
  Effect.gen(function* () {
    if (
      settlement._tag !== "Completed" ||
      settlement.result._tag !== "Blocked"
    ) {
      return { _tag: "Ignored", eventId: event.eventId };
    }
    const result = settlement.result;
    const blockerStore = deps.blockers;
    if (blockerStore === undefined) {
      return { _tag: "Ignored", eventId: event.eventId };
    }
    const execution = yield* deps.tx.transact(
      deps.executions.findById(executionId),
    );
    if (Option.isNone(execution)) {
      return yield* Effect.fail(
        invariant(event, `execution not found: ${executionId}`),
      );
    }
    const binding = execution.value.binding;
    if (
      execution.value.state.status !== "Settled" ||
      binding._tag !== "WorkspaceExecution" ||
      binding.episode?._tag !== "WorkEpisode" ||
      binding.episode.workId !== result.workId ||
      binding.episode.targetWorkRevision !== result.targetWorkRevision
    ) {
      return yield* Effect.fail(
        invariant(
          event,
          "Blocked settlement is not bound to its exact WorkEpisode",
        ),
      );
    }
    const work = yield* deps.tx.transact(deps.works.findById(result.workId));
    if (
      Option.isNone(work) ||
      work.value.projectId !== execution.value.projectId ||
      work.value.workspaceId !== execution.value.workspaceId
    ) {
      return yield* Effect.fail(
        invariant(
          event,
          "Blocked settlement Work identity or revision mismatch",
        ),
      );
    }
    if (
      work.value.revision !== result.targetWorkRevision ||
      work.value.lifecycle !== "Open"
    ) {
      // A later canonical steer supersedes this source fact. Delayed signal
      // delivery must not recreate a stale Parent Inbox row.
      yield* wakeBlockedEpisodeIfInboxAdvanced(
        event,
        executionId,
        execution.value.workspaceId,
        result.waitFor,
        deps,
      );
      return { _tag: "Ignored", eventId: event.eventId };
    }
    const blocker = yield* deps.tx.transact(
      blockerStore.findById(result.blockerId),
    );
    if (Option.isNone(blocker)) {
      return yield* Effect.fail(
        invariant(
          event,
          "Blocked settlement WorkBlocker ledger row is missing",
        ),
      );
    }
    if (blocker.value.state !== "Open") {
      yield* wakeBlockedEpisodeIfInboxAdvanced(
        event,
        executionId,
        execution.value.workspaceId,
        result.waitFor,
        deps,
      );
      return { _tag: "Ignored", eventId: event.eventId };
    }
    if (blocker.value.openCycleId !== executionId) {
      yield* wakeBlockedEpisodeIfInboxAdvanced(
        event,
        executionId,
        execution.value.workspaceId,
        result.waitFor,
        deps,
      );
      return { _tag: "Ignored", eventId: event.eventId };
    }
    if (
      blocker.value.projectId !== execution.value.projectId ||
      blocker.value.workspaceId !== execution.value.workspaceId ||
      blocker.value.workId !== result.workId ||
      blocker.value.targetWorkRevision !== result.targetWorkRevision
    ) {
      return yield* Effect.fail(
        invariant(
          event,
          "Blocked settlement WorkBlocker ledger row is missing or mismatched",
        ),
      );
    }
    const admission = yield* deps.tx.transact(
      Effect.gen(function* () {
        // Close the read/admission race with a concurrent SteerWork or
        // blocker resolution. The final canonical check and Inbox sequence
        // advance share one transaction.
        const currentWork = yield* deps.works.findById(result.workId);
        if (
          Option.isNone(currentWork) ||
          currentWork.value.lifecycle !== "Open" ||
          currentWork.value.revision !== result.targetWorkRevision ||
          currentWork.value.projectId !== execution.value.projectId ||
          currentWork.value.workspaceId !== execution.value.workspaceId
        ) {
          return { _tag: "Stale" as const };
        }
        const currentBlocker = yield* blockerStore.findById(result.blockerId);
        if (Option.isNone(currentBlocker)) {
          return yield* Effect.fail(
            invariant(
              event,
              "Blocked settlement WorkBlocker ledger row disappeared",
            ),
          );
        }
        if (
          currentBlocker.value.state !== "Open" ||
          currentBlocker.value.openCycleId !== executionId
        ) {
          return { _tag: "Stale" as const };
        }
        if (
          currentBlocker.value.projectId !== execution.value.projectId ||
          currentBlocker.value.workspaceId !== execution.value.workspaceId ||
          currentBlocker.value.workId !== result.workId ||
          currentBlocker.value.targetWorkRevision !== result.targetWorkRevision
        ) {
          return yield* Effect.fail(
            invariant(
              event,
              "Blocked settlement WorkBlocker ledger row changed scope",
            ),
          );
        }
        const currentOwner = yield* deps.workspaces.findById(
          currentWork.value.workspaceId,
        );
        if (Option.isNone(currentOwner)) {
          return yield* Effect.fail(
            invariant(
              event,
              `workspace not found: ${currentWork.value.workspaceId}`,
            ),
          );
        }
        const parentWorkspaceId = currentOwner.value.parentWorkspaceId;
        if (parentWorkspaceId !== null) {
          yield* deps.inbox.admitUpsertSequenced({
            recipientWorkspaceId: parentWorkspaceId,
            entryKey: executionId,
            kind: "WorkBlocked",
            summary: `Child Work ${result.workId} is blocked at revision ${result.targetWorkRevision}`,
            correlationId: result.blockerId,
            admittedAt: event.occurredAt,
          });
        }
        const inboxSequence =
          parentWorkspaceId === null
            ? null
            : yield* deps.inbox.currentSequence(parentWorkspaceId);
        return { _tag: "Current" as const, parentWorkspaceId, inboxSequence };
      }),
    );
    if (admission._tag === "Stale") {
      yield* wakeBlockedEpisodeIfInboxAdvanced(
        event,
        executionId,
        execution.value.workspaceId,
        result.waitFor,
        deps,
      );
      return { _tag: "Ignored", eventId: event.eventId };
    }
    const parentWorkspaceId = admission.parentWorkspaceId;
    if (parentWorkspaceId !== null) {
      yield* deliverWakeSignal(
        {
          workspaceId: parentWorkspaceId,
          reason: "InputArrived",
          detail: {
            executionId,
            workId: result.workId,
            blockerId: result.blockerId,
            inboxSequence: admission.inboxSequence,
          },
        },
        deps,
      );
    }
    yield* wakeBlockedEpisodeIfInboxAdvanced(
      event,
      executionId,
      execution.value.workspaceId,
      result.waitFor,
      deps,
    );
    return parentWorkspaceId === null
      ? { _tag: "Ignored", eventId: event.eventId }
      : delivered(event, "WorkBlocked", parentWorkspaceId);
  });

const resolveBlockedWorkInbox = (
  event: WorkflowSignalEvent,
  deps: WorkflowSignalConsumerDependencies,
): Effect.Effect<WorkflowSignalOutcome, WorkflowSignalConsumerError> =>
  Effect.gen(function* () {
    const payload = recordOf(event.payload);
    if (
      payload === null ||
      typeof payload.blockerId !== "string" ||
      typeof payload.workId !== "string"
    ) {
      return yield* Effect.fail(
        invariant(event, "invalid WorkBlocker resolution payload"),
      );
    }
    if (deps.blockers === undefined) {
      return { _tag: "Ignored", eventId: event.eventId };
    }
    const blocker = yield* deps.tx.transact(
      deps.blockers.findById(payload.blockerId as WorkBlocker["blockerId"]),
    );
    if (Option.isNone(blocker) || blocker.value.workId !== payload.workId) {
      return yield* Effect.fail(
        invariant(
          event,
          "resolved WorkBlocker ledger row is missing or mismatched",
        ),
      );
    }
    const expectedState =
      event.eventType === "WorkBlockerResolved" ? "Resolved" : "Superseded";
    const expectedRevision =
      event.eventType === "WorkBlockerResolved"
        ? payload.workRevision
        : payload.previousWorkRevision;
    if (
      blocker.value.state === "Open" ||
      blocker.value.state !== expectedState ||
      expectedRevision !== blocker.value.targetWorkRevision
    ) {
      // A delayed transition event cannot consume a later reopened blocker.
      return { _tag: "Ignored", eventId: event.eventId };
    }
    const owner = yield* deps.tx.transact(
      deps.workspaces.findById(blocker.value.workspaceId),
    );
    if (Option.isNone(owner)) {
      return yield* Effect.fail(
        invariant(event, `workspace not found: ${blocker.value.workspaceId}`),
      );
    }
    const parentWorkspaceId = owner.value.parentWorkspaceId;
    if (parentWorkspaceId === null) {
      return { _tag: "Ignored", eventId: event.eventId };
    }
    const unconsumed = yield* deps.tx.transact(
      deps.inbox.listUnconsumed(parentWorkspaceId),
    );
    for (const entry of unconsumed) {
      if (
        entry.kind === "WorkBlocked" &&
        entry.correlationId === blocker.value.blockerId
      ) {
        yield* deps.tx.transact(
          deps.inbox.markConsumed(parentWorkspaceId, entry.entryKey),
        );
      }
    }
    return delivered(event, "WorkBlockerResolved", parentWorkspaceId);
  });

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
    case "ExecutionSettled": {
      const payload = recordOf(event.payload);
      if (payload === null || typeof payload.executionId !== "string") {
        return Effect.fail(invariant(event, "missing executionId"));
      }
      const executionId = payload.executionId as ExecutionId;
      return Effect.gen(function* () {
        const execution = yield* deps.tx.transact(
          deps.executions.findById(executionId),
        );
        if (Option.isNone(execution)) {
          return yield* Effect.fail(
            invariant(event, `execution not found: ${executionId}`),
          );
        }
        const settlement =
          execution.value.state.status === "Settled"
            ? execution.value.state.settlement
            : null;
        if (
          settlement?._tag === "Completed" &&
          settlement.result._tag === "Blocked"
        ) {
          return yield* deliverBlockedWorkSettlement(
            event,
            executionId,
            settlement,
            deps,
          );
        }
        return yield* deliverSpecialistSettled(event, deps);
      });
    }
    case "WorkBlockerResolved":
    case "WorkBlockerSuperseded":
      return resolveBlockedWorkInbox(event, deps);
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
  applyBlockedWorkEpisodeAtomically: (event) =>
    applyBlockedWorkEpisodeAtomically(event, dependencies),
});

/** P6 Blocked settlement apply used by ConsumerLoop's atomic callback. Unlike
 * the ordinary signal handler, this function deliberately does not open its
 * own transactions: WorkBlocked admission/sequence, matching Wait clears and
 * ConsumerOffsetStore.advance are committed by one outer ConsumerLoop tx. */
export const applyBlockedWorkEpisodeAtomically = (
  event: WorkflowSignalEvent,
  deps: WorkflowSignalConsumerDependencies,
): Effect.Effect<
  AtomicConsumerApplyResult,
  WorkflowSignalConsumerError,
  TransactionScope
> =>
  Effect.gen(function* () {
    const payload = recordOf(event.payload);
    const settlement = payload?.settlement as ExecutionSettlement | undefined;
    if (
      payload === null ||
      typeof payload.executionId !== "string" ||
      settlement?._tag !== "Completed" ||
      settlement.result._tag !== "Blocked"
    ) {
      return { quarantineReason: "invalid ExecutionSettled(Blocked) payload" };
    }
    if (deps.blockers === undefined) {
      return { quarantineReason: "P43 WorkBlockerStore is not active" };
    }
    const executionId = payload.executionId as ExecutionId;
    const result = settlement.result;
    const execution = yield* deps.executions.findById(executionId);
    if (Option.isNone(execution)) {
      return {
        quarantineReason: `Blocked execution not found: ${executionId}`,
      };
    }
    const binding = execution.value.binding;
    if (
      execution.value.state.status !== "Settled" ||
      binding._tag !== "WorkspaceExecution" ||
      binding.episode?._tag !== "WorkEpisode" ||
      binding.episode.workId !== result.workId ||
      binding.episode.targetWorkRevision !== result.targetWorkRevision
    ) {
      return {
        quarantineReason: "Blocked settlement is not exact WorkEpisode",
      };
    }
    const work = yield* deps.works.findById(result.workId);
    if (
      Option.isNone(work) ||
      work.value.projectId !== execution.value.projectId ||
      work.value.workspaceId !== execution.value.workspaceId
    ) {
      return { quarantineReason: "Blocked Work identity mismatch" };
    }
    const inboxWait = result.waitFor.conditions.find(
      (condition) => condition._tag === "InboxAdvanced",
    );
    if (
      inboxWait === undefined ||
      inboxWait._tag !== "InboxAdvanced" ||
      inboxWait.workspaceId !== execution.value.workspaceId
    ) {
      return { quarantineReason: "Blocked InboxAdvanced binding mismatch" };
    }

    const wakes = new Set<WorkspaceId>();
    const childSequence = yield* deps.inbox.currentSequence(
      execution.value.workspaceId,
    );
    if (
      work.value.lifecycle !== "Open" ||
      work.value.revision !== result.targetWorkRevision
    ) {
      const childWait = yield* deps.waits.findByWork(result.workId);
      if (
        Option.isSome(childWait) &&
        matchesAdvancedInbox(
          childWait.value.waitSpec.conditions,
          execution.value.workspaceId,
          childSequence,
        )
      ) {
        yield* deps.waits.clear(result.workId);
        wakes.add(execution.value.workspaceId);
      }
      wakes.add(execution.value.workspaceId);
      return {
        record: `Ignored:BlockedStale:${executionId}`,
        afterCommit: Effect.forEach(
          [...wakes],
          (workspaceId) =>
            deps.scheduler.reevaluate(workspaceId, { _tag: "InputArrived" }),
          { discard: true },
        ),
      };
    }

    const blocker = yield* deps.blockers.findById(result.blockerId);
    if (
      Option.isNone(blocker) ||
      blocker.value.projectId !== execution.value.projectId ||
      blocker.value.workspaceId !== execution.value.workspaceId ||
      blocker.value.workId !== result.workId ||
      blocker.value.targetWorkRevision !== result.targetWorkRevision ||
      blocker.value.openCycleId !== executionId
    ) {
      return { quarantineReason: "Blocked WorkBlocker ledger mismatch" };
    }
    if (blocker.value.state !== "Open") {
      const childWait = yield* deps.waits.findByWork(result.workId);
      if (
        Option.isSome(childWait) &&
        matchesAdvancedInbox(
          childWait.value.waitSpec.conditions,
          execution.value.workspaceId,
          childSequence,
        )
      ) {
        yield* deps.waits.clear(result.workId);
        wakes.add(execution.value.workspaceId);
      }
      return {
        record: `Ignored:BlockedClosed:${executionId}`,
        afterCommit: Effect.forEach(
          [...wakes],
          (workspaceId) =>
            deps.scheduler.reevaluate(workspaceId, { _tag: "InputArrived" }),
          { discard: true },
        ),
      };
    }

    const owner = yield* deps.workspaces.findById(work.value.workspaceId);
    if (Option.isNone(owner)) {
      return { quarantineReason: "Blocked Work owner Workspace is missing" };
    }
    const parentWorkspaceId = owner.value.parentWorkspaceId;
    let parentSequence: number | null = null;
    if (parentWorkspaceId !== null) {
      yield* deps.inbox.admitUpsertSequenced({
        recipientWorkspaceId: parentWorkspaceId,
        entryKey: executionId,
        kind: "WorkBlocked",
        summary: `Child Work ${result.workId} is blocked: ${result.request}`,
        correlationId: result.blockerId,
        admittedAt: event.occurredAt,
      });
      parentSequence = yield* deps.inbox.currentSequence(parentWorkspaceId);
      wakes.add(parentWorkspaceId);
    }

    // Only exact InboxAdvanced observations are released. Ordinary InputArrived
    // messages without a sequence cannot release Manual or unrelated waits.
    const childWait = yield* deps.waits.findByWork(result.workId);
    if (
      Option.isSome(childWait) &&
      matchesAdvancedInbox(
        childWait.value.waitSpec.conditions,
        execution.value.workspaceId,
        childSequence,
      )
    ) {
      yield* deps.waits.clear(result.workId);
      wakes.add(execution.value.workspaceId);
    }
    if (parentWorkspaceId !== null && parentSequence !== null) {
      const parentWorks = yield* deps.works.listByWorkspace(parentWorkspaceId);
      for (const parentWork of parentWorks) {
        const parentWait = yield* deps.waits.findByWork(parentWork.workId);
        if (
          Option.isSome(parentWait) &&
          matchesAdvancedInbox(
            parentWait.value.waitSpec.conditions,
            parentWorkspaceId,
            parentSequence,
          )
        ) {
          yield* deps.waits.clear(parentWork.workId);
          wakes.add(parentWorkspaceId);
        }
      }
    }
    return {
      record:
        parentWorkspaceId === null
          ? `Ignored:RootWorkBlocked:${executionId}`
          : `Delivered:WorkBlocked:${parentWorkspaceId}`,
      afterCommit: Effect.forEach(
        [...wakes],
        (workspaceId) =>
          deps.scheduler.reevaluate(workspaceId, { _tag: "InputArrived" }),
        { discard: true },
      ),
    };
  });

export const WorkflowSignalConsumerLive: Layer.Layer<
  WorkflowSignalConsumer,
  never,
  | TransactionPort
  | WorkWaitStore
  | WorkRepository
  | WorkspaceRepository
  | ExecutionScheduler
  | DependencyRepository
  | MessageStore
  | ExecutionRepository
  | InboxProjectionStore
> = Layer.effect(
  WorkflowSignalConsumer,
  Effect.gen(function* () {
    const blockers = yield* Effect.serviceOption(WorkBlockerStore);
    return makeWorkflowSignalConsumer({
      tx: yield* TransactionPort,
      waits: yield* WorkWaitStore,
      works: yield* WorkRepository,
      workspaces: yield* WorkspaceRepository,
      scheduler: yield* ExecutionScheduler,
      dependencies: yield* DependencyRepository,
      messages: yield* MessageStore,
      executions: yield* ExecutionRepository,
      inbox: yield* InboxProjectionStore,
      ...(Option.isSome(blockers) ? { blockers: blockers.value } : {}),
    });
  }),
);
