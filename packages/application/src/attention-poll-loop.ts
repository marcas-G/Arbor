import type { DomainEvent, ProjectId } from "@arbor/domain";
import {
  type AttentionPollFailureCode,
  type AttentionPollStoreError,
  type AttentionPollStoreService,
  type AttentionProjectionStoreError,
  type AttentionProjectionStoreService,
  type ClockService,
  type ConsumerDeadLetterStoreService,
  type ConsumerOffsetStoreService,
  type DomainEventJournalService,
  type ProjectionStoreService,
  type RawJournalEventCandidate,
  type RecoveryAttentionFactStoreService,
  type RecoveryAttentionFactStoreError,
  type TransactionPortService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type { ConsumerLoopError, ConsumerLoopResult } from "./consumer-loop.js";

export interface AttentionPollRuntimePolicy {
  readonly leaseOwner: string;
  readonly leaseTtlMs: number;
  readonly eventBatchSize: number;
  readonly queueBatchSize: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly backoffExponentCap: number;
}

export type AttentionPollPolicyConfig = Omit<
  AttentionPollRuntimePolicy,
  "leaseOwner" | "eventBatchSize"
>;

export interface AttentionPollLoopDependencies {
  readonly tx: Pick<TransactionPortService, "transact">;
  readonly clock: Pick<ClockService, "now">;
  readonly journal: Pick<DomainEventJournalService, "readAfterRaw" | "decodeRaw">;
  readonly offsets: ConsumerOffsetStoreService;
  readonly deadLetters: ConsumerDeadLetterStoreService;
  readonly projectionForProject: (
    projectId: ProjectId,
  ) => ProjectionStoreService;
  readonly pollStore: AttentionPollStoreService;
  readonly recoveryFacts: Pick<
    RecoveryAttentionFactStoreService,
    | "findDeliverReplayFailureByEventId"
    | "listPendingDeliverReplayAttention"
    | "acknowledgePendingDeliverReplayAttention"
  >;
  readonly attentionRows: Pick<
    AttentionProjectionStoreService,
    "putDeliverReplayFailure"
  >;
}

export type AttentionPollLoopError =
  | ConsumerLoopError
  | AttentionPollStoreError
  | AttentionProjectionStoreError
  | RecoveryAttentionFactStoreError
  | ReturnType<typeof attentionPollError>
  | ReturnType<typeof claimLost>;

const attentionPollError = (
  failureCode: Exclude<AttentionPollFailureCode, "PollLeaseExpired">,
) => ({
  _tag: "AttentionPollIntegrityFailure" as const,
  failureCode,
});

const claimLost = () => ({ _tag: "AttentionPollClaimLost" as const });

const emptyResult = (): ConsumerLoopResult => ({
  fromSequence: 0,
  lastSequence: 0,
  applied: 0,
  quarantined: 0,
  records: [],
});

const sequenceOf = (raw: unknown): number | null =>
  typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : null;

const rawDeliverPayloadMatches = (
  candidate: RawJournalEventCandidate,
  fact: {
    readonly attentionFactId: string;
    readonly executionId: string;
    readonly targetWorkspaceId: string;
    readonly logicalActionId: string;
    readonly messageId: string;
    readonly failureCode: string;
  },
): boolean => {
  if (typeof candidate.payloadJsonRaw !== "string") return false;
  let payload: unknown;
  try {
    payload = JSON.parse(candidate.payloadJsonRaw);
  } catch {
    return false;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  const expectedKeys = [
    "attentionFactId",
    "executionId",
    "failureCode",
    "logicalActionId",
    "messageId",
    "targetWorkspaceId",
  ];
  const keys = Object.keys(record).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]) &&
    record.attentionFactId === fact.attentionFactId &&
    record.executionId === fact.executionId &&
    record.targetWorkspaceId === fact.targetWorkspaceId &&
    record.logicalActionId === fact.logicalActionId &&
    record.messageId === fact.messageId &&
    record.failureCode === fact.failureCode
  );
};

const exactDeliverEnvelope = (
  candidate: RawJournalEventCandidate,
  fact: {
    readonly attentionFactId: string;
    readonly eventId: string;
    readonly projectId: ProjectId;
    readonly executionId: string;
    readonly targetWorkspaceId: string;
    readonly logicalActionId: string;
    readonly messageId: string;
    readonly failureCode: string;
    readonly firstDetectedAt: string;
  },
  event: DomainEvent<unknown>,
  projectId: ProjectId,
): AttentionPollFailureCode | null => {
  if (fact.projectId !== projectId) return "FactProjectMismatch";
  if (
    event.eventType !== "DeliverReplayEscalated" ||
    event.eventVersion !== 1 ||
    event.eventId !== fact.eventId ||
    event.projectId !== fact.projectId ||
    event.actor !== "system:recovery" ||
    event.causedByEventId !== undefined ||
    event.aggregateRef !== fact.targetWorkspaceId ||
    event.correlationRef !== fact.logicalActionId ||
    event.occurredAt !== fact.firstDetectedAt ||
    candidate.eventIdRaw !== fact.eventId ||
    candidate.projectIdRaw !== fact.projectId ||
    candidate.eventTypeRaw !== "DeliverReplayEscalated" ||
    candidate.eventVersionRaw !== 1 ||
    candidate.occurredAtRaw !== fact.firstDetectedAt ||
    candidate.aggregateRefRaw !== fact.targetWorkspaceId ||
    candidate.actorRaw !== "system:recovery" ||
    candidate.causedByEventIdRaw !== null ||
    candidate.correlationRefRaw !== fact.logicalActionId ||
    !rawDeliverPayloadMatches(candidate, fact)
  ) {
    return "EventBindingMismatch";
  }
  return null;
};

const isRetryableOperational = (failure: unknown): boolean => {
  if (typeof failure !== "object" || failure === null) return false;
  const record = failure as Readonly<Record<string, unknown>>;
  return (
    record._tag === "TransactionOperationalFailure" ||
    (record._tag === "PersistenceUnavailable" &&
      record.retryDisposition === "retryable")
  );
};

const deadLetterReason = (reason: string): string => {
  switch (reason) {
    case "UnknownEventType":
      return "unknown event type";
    case "MalformedPayload":
      return "malformed event payload";
    default:
      return "malformed event envelope";
  }
};

/** P1/P9/P10 v1.43 single-transaction Attention poll. The ordinary
 * `runConsumerBatch` path remains available to event-only consumers. */
export const runAttentionPollOnce = (
  consumerId: string,
  policy: AttentionPollRuntimePolicy,
  deps: AttentionPollLoopDependencies,
): Effect.Effect<ConsumerLoopResult, AttentionPollLoopError> =>
  Effect.gen(function* () {
    if (
      policy.leaseOwner.length === 0 ||
      !Number.isSafeInteger(policy.eventBatchSize) ||
      policy.eventBatchSize <= 0 ||
      !Number.isSafeInteger(policy.queueBatchSize) ||
      policy.queueBatchSize <= 0
    ) {
      return yield* Effect.fail<AttentionPollLoopError>({
        _tag: "PersistenceCorruption",
        repository: "AttentionPollStore",
        operation: "policy",
        reason: "invalid Attention poll owner or batch-size policy",
      });
    }
    const claimTime = yield* deps.clock.now();
    const claimResult = yield* deps.tx.transact(
      deps.pollStore.tryClaim({
        leaseOwner: policy.leaseOwner,
        now: claimTime,
        leaseTtlMs: policy.leaseTtlMs,
        baseBackoffMs: policy.baseBackoffMs,
        maxBackoffMs: policy.maxBackoffMs,
        backoffExponentCap: policy.backoffExponentCap,
      }),
    );
    if (claimResult._tag === "NoClaim") return emptyResult();
    const projectId = claimResult.claim.projectId;

    let fromSequence = 0;
    let lastSequence = 0;
    const data = yield* Effect.either(
      deps.tx.transact(
        Effect.gen(function* () {
          const dataStartedAt = yield* deps.clock.now();
          const current = yield* deps.pollStore.isCurrentClaim(
            claimResult.claim,
            dataStartedAt,
          );
          if (!current) return yield* Effect.fail(claimLost());

          fromSequence = yield* deps.offsets.read(consumerId, projectId);
          lastSequence = fromSequence;
          const rawEvents = yield* deps.journal.readAfterRaw(
            projectId,
            fromSequence,
            policy.eventBatchSize,
          );
          const applicable: Array<DomainEvent<unknown>> = [];
          let quarantined = 0;

          for (const candidate of rawEvents) {
            if (
              typeof candidate.eventIdRaw !== "string" ||
              candidate.eventIdRaw.length === 0
            ) {
              return yield* Effect.fail(
                attentionPollError("JournalIdentityUnprovable"),
              );
            }
            const sequence = sequenceOf(candidate.sequenceRaw);
            if (sequence === null) {
              return yield* Effect.fail(
                attentionPollError("JournalIdentityUnprovable"),
              );
            }

            const sourceFact = yield* deps.recoveryFacts
              .findDeliverReplayFailureByEventId(candidate.eventIdRaw);
            if (Option.isSome(sourceFact)) {
              const fact = sourceFact.value;
              if (fact.projectId !== projectId) {
                return yield* Effect.fail(
                  attentionPollError("FactProjectMismatch"),
                );
              }
              const decoded = yield* deps.journal.decodeRaw(candidate);
              if (decoded._tag !== "Decoded") {
                return yield* Effect.fail(
                  attentionPollError("EventBindingMismatch"),
                );
              }
              const mismatch = exactDeliverEnvelope(
                candidate,
                fact,
                decoded.event,
                projectId,
              );
              if (mismatch !== null) {
                return yield* Effect.fail(attentionPollError(mismatch));
              }
              const applyResult = yield* Effect.either(
                deps.projectionForProject(projectId).apply([decoded.event]),
              );
              if (isLeft(applyResult)) {
                if (isRetryableOperational(applyResult.left)) {
                  return yield* Effect.fail(applyResult.left as ConsumerLoopError);
                }
                return yield* Effect.fail(
                  attentionPollError("MarkerBindingMismatch"),
                );
              }
              applicable.push(decoded.event);
              lastSequence = sequence;
              continue;
            }

            if (candidate.eventTypeRaw === "DeliverReplayEscalated") {
              return yield* Effect.fail(attentionPollError("MissingP9Fact"));
            }

            if (
              typeof candidate.projectIdRaw !== "string" ||
              candidate.projectIdRaw !== projectId
            ) {
              return yield* Effect.fail(
                attentionPollError("FactProjectMismatch"),
              );
            }
            if (
              typeof candidate.eventVersionRaw !== "number" ||
              !Number.isSafeInteger(candidate.eventVersionRaw) ||
              candidate.eventVersionRaw > 1
            ) {
              yield* deps.deadLetters.quarantine(
                consumerId,
                projectId,
                sequence,
                "unsupported eventVersion",
              );
              lastSequence = sequence;
              quarantined += 1;
              continue;
            }

            const decoded = yield* deps.journal.decodeRaw(candidate);
            if (decoded._tag === "Poison") {
              yield* deps.deadLetters.quarantine(
                consumerId,
                projectId,
                sequence,
                deadLetterReason(decoded.reason),
              );
              lastSequence = sequence;
              quarantined += 1;
              continue;
            }

            const applyResult = yield* Effect.either(
              deps.projectionForProject(projectId).apply([decoded.event]),
            );
            if (isLeft(applyResult)) {
              if (isRetryableOperational(applyResult.left)) {
                return yield* Effect.fail(applyResult.left as ConsumerLoopError);
              }
              yield* deps.deadLetters.quarantine(
                consumerId,
                projectId,
                sequence,
                "projection rejected event",
              );
              lastSequence = sequence;
              quarantined += 1;
              continue;
            }
            applicable.push(decoded.event);
            lastSequence = sequence;
          }

          const pending = yield* deps.recoveryFacts.listPendingDeliverReplayAttention(
            projectId,
            policy.queueBatchSize,
          );
          for (const fact of pending) {
            if (fact.projectId !== projectId) {
              return yield* Effect.fail(
                attentionPollError("QueueFactMismatch"),
              );
            }
            const markerResult = yield* Effect.either(
              deps.attentionRows.putDeliverReplayFailure(fact),
            );
            if (isLeft(markerResult)) {
              if (markerResult.left._tag === "PersistenceCorruption") {
                return yield* Effect.fail(
                  attentionPollError("MarkerBindingMismatch"),
                );
              }
                return yield* Effect.fail(markerResult.left as AttentionPollLoopError);
            }
            const ackResult = yield* Effect.either(
              deps.recoveryFacts.acknowledgePendingDeliverReplayAttention(
                fact.attentionFactId,
              ),
            );
            if (isLeft(ackResult)) {
              if (
                ackResult.left._tag === "RecoveryAttentionFactInvariantConflict"
              ) {
                return yield* Effect.fail(
                  attentionPollError("QueueDeleteWithoutMarker"),
                );
              }
              return yield* Effect.fail(ackResult.left as AttentionPollLoopError);
            }
          }

          if (lastSequence !== fromSequence) {
            yield* deps.offsets.advance(consumerId, projectId, lastSequence);
          }
          const completedAt = yield* deps.clock.now();
          const completed = yield* deps.pollStore.completeSuccess(
            claimResult.claim,
            completedAt,
          );
          if (!completed) return yield* Effect.fail(claimLost());
          return {
            fromSequence,
            lastSequence,
            applied: applicable.length,
            quarantined,
            records: [],
          } satisfies ConsumerLoopResult;
        }),
      ),
    );

    if (data._tag === "Right") return data.right;
    if (data.left._tag === "AttentionPollClaimLost") return emptyResult();
    if (data.left._tag !== "AttentionPollIntegrityFailure") {
      return yield* Effect.fail(data.left);
    }
    const failedAt = yield* deps.clock.now();
    yield* deps.tx.transact(
      deps.pollStore.recordFailure(
        claimResult.claim,
        data.left.failureCode,
        failedAt,
        {
          baseBackoffMs: policy.baseBackoffMs,
          maxBackoffMs: policy.maxBackoffMs,
          backoffExponentCap: policy.backoffExponentCap,
        },
      ),
    );
    return {
      fromSequence,
      lastSequence: fromSequence,
      applied: 0,
      quarantined: 0,
      records: [`AttentionPollIntegrityFailure:${data.left.failureCode}`],
    };
  });

const isLeft = <E, A>(
  value: { readonly _tag: "Left"; readonly left: E } | { readonly _tag: "Right"; readonly right: A },
): value is { readonly _tag: "Left"; readonly left: E } =>
  value._tag === "Left";
