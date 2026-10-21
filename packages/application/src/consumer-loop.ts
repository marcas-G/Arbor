import type { DomainEvent, Principal, ProjectId } from "@arbor/domain";
import type {
  ConsumerDeadLetterStoreError,
  ConsumerDeadLetterStoreService,
  ConsumerOffsetStoreError,
  ConsumerOffsetStoreService,
  DomainEventJournalError,
  DomainEventJournalService,
  ProjectionStoreService,
  TransactionOperationalFailure,
  TransactionPortService,
  TransactionScope,
} from "@arbor/ports";
import { Cause, Effect, Exit } from "effect";
import type { CompletionConsumerDependencies } from "./completion-consumer.js";
import { runCompletionConsumer } from "./completion-consumer.js";
import {
  type DependencyCoordinatorDependencies,
  runDependencyCoordinator,
} from "./dependency-coordinator.js";
import {
  runVerificationConsumer,
  type VerificationConsumerDependencies,
} from "./verification-consumer.js";
import type { WorkflowSignalConsumerService } from "./workflow-signal-consumer.js";

/** P9 `05` §1 (P9-010): consumer offset wiring for the P7 coordinator and
 * the P8 consumers A/B. `pollOnce` is the P1 batch-consumption form: the
 * injected events-array handler IS the apply (idempotency from the
 * deterministic CommandIds it submits through the CommandGateway), and
 * the projection apply + dead-letter + offset advance share ONE
 * transaction (P1 `05` §4) — the offset never advances without the apply.
 * The handler's command transactions are deliberately outside that
 * transaction (the gateway owns its commit boundary); that is the dual
 * guarantee: primary = consumer_offsets, fallback = deterministic
 * CommandId receipts absorbing at-least-once redelivery (P9 `05` §1). */

export type ConsumerLoopError =
  | DomainEventJournalError
  | ConsumerOffsetStoreError
  | ConsumerDeadLetterStoreError
  | TransactionOperationalFailure;

export interface ConsumerLoopStores {
  readonly tx: Pick<TransactionPortService, "transact">;
  readonly journal: Pick<
    DomainEventJournalService,
    "readAfterRaw" | "decodeRaw"
  >;
  readonly offsets: ConsumerOffsetStoreService;
  readonly deadLetters: ConsumerDeadLetterStoreService;
  readonly projection: ProjectionStoreService;
}

export interface AtomicConsumerApplyResult {
  readonly record?: string;
  readonly quarantineReason?: string;
  readonly afterCommit?: Effect.Effect<void, unknown>;
}

/** Narrow exception for consumers whose canonical apply must share the
 * consumer-offset transaction. Ordinary event handlers keep their current
 * receipt-first boundary. */
export interface AtomicConsumerHandler {
  readonly matches: (event: DomainEvent<unknown>) => boolean;
  readonly apply: (
    event: DomainEvent<unknown>,
  ) => Effect.Effect<AtomicConsumerApplyResult, unknown, TransactionScope>;
}

export interface ConsumerLoopResult {
  readonly fromSequence: number;
  readonly lastSequence: number;
  readonly applied: number;
  readonly quarantined: number;
  readonly records: ReadonlyArray<string>;
}

interface QuarantineEntry {
  readonly sequence: number;
  readonly reason: string;
}

/** CC-4 frozen classification: transient operational failures (busy/IO,
 * surfaced through the transaction port as TransactionOperationalFailure)
 * abort the batch and retry — never dead-letter. Anything else surfacing
 * from the handler is a deterministic defect (decode/schema/unexpected
 * throw) → poison. Typed DomainError rejections never reach here: the
 * P7/P8 consumers record them as outcome strings. */
const isTransientOperational = (defect: unknown): boolean => {
  let current: unknown = defect;
  for (
    let depth = 0;
    depth < 8 && current !== null && current !== undefined;
    depth += 1
  ) {
    if (
      typeof current === "object" &&
      (current as { readonly _tag?: unknown })._tag ===
        "TransactionOperationalFailure"
    ) {
      return true;
    }
    if (
      typeof current === "object" &&
      current !== null &&
      (current as { readonly _tag?: unknown })._tag === "PersistenceUnavailable"
    ) {
      return (
        (current as { readonly retryDisposition?: unknown })
          .retryDisposition === "retryable"
      );
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
};

const safeFailureReason = (failure: unknown): string => {
  if (typeof failure !== "object" || failure === null) return String(failure);
  const record = failure as Readonly<Record<string, unknown>>;
  switch (record._tag) {
    case "PersistenceUnavailable":
      return `persistence unavailable: ${String(record.repository)}/${String(record.operation)} (${String(record.sourceTag)})`;
    case "PersistenceConstraintViolation":
      return `persistence constraint: ${String(record.repository)}/${String(record.constraintKind)}/${String(record.constraint)}`;
    case "PersistenceCorruption":
      return `persistence corruption: ${String(record.repository)}/${String(record.operation)} (${String(record.reason)})`;
    default:
      return String(failure);
  }
};

/** One poll over the project journal for one consumer identity: read the
 * batch after the stored offset, run the injected handler per event (a
 * deterministic defect quarantines just that event — no head-of-line
 * block), then commit apply + advance atomically. */
export const pollOnce = <R>(
  consumerId: string,
  projectId: ProjectId,
  batchSize: number,
  deps: ConsumerLoopStores & {
    readonly handlers: (
      events: ReadonlyArray<DomainEvent<unknown>>,
    ) => Effect.Effect<ReadonlyArray<string>, unknown, R>;
    readonly atomicHandler?: AtomicConsumerHandler;
  },
): Effect.Effect<ConsumerLoopResult, ConsumerLoopError, R> =>
  Effect.gen(function* () {
    const { fromSequence, candidates } = yield* deps.tx.transact(
      Effect.gen(function* () {
        const fromSequence = yield* deps.offsets.read(consumerId, projectId);
        const candidates = yield* deps.journal.readAfterRaw(
          projectId,
          fromSequence,
          batchSize,
        );
        return { fromSequence, candidates };
      }),
    );

    const quarantined: QuarantineEntry[] = [];
    const applied: DomainEvent<unknown>[] = [];
    const records: string[] = [];
    let lastSequence = fromSequence;
    let committedSequence = fromSequence;
    let appliedCount = 0;
    let quarantinedCount = 0;
    const afterCommit: Array<Effect.Effect<void, unknown>> = [];
    for (const candidate of candidates) {
      if (
        typeof candidate.sequenceRaw !== "number" ||
        !Number.isSafeInteger(candidate.sequenceRaw) ||
        candidate.sequenceRaw <= 0
      ) {
        return yield* Effect.fail({
          _tag: "PersistenceCorruption" as const,
          repository: "DomainEventJournal" as const,
          operation: "consumer-event-sequence",
          reason: "journal sequence cannot be proven for quarantine",
        });
      }
      lastSequence = candidate.sequenceRaw;
      const decoded = yield* deps.journal.decodeRaw(candidate);
      if (decoded._tag === "Poison") {
        quarantined.push({
          sequence: candidate.sequenceRaw,
          reason:
            decoded.reason === "UnsupportedEventPair" &&
            candidate.eventVersionRaw === 2
              ? "unsupported eventVersion 2"
              : decoded.reason === "UnsupportedEventPair" ||
                  decoded.reason === "UnknownEventType"
                ? "unsupported event type/version pair"
                : decoded.reason === "MalformedPayload"
                  ? "malformed event payload"
                  : "malformed event envelope",
        });
        continue;
      }
      if (decoded.event.projectId !== projectId) {
        quarantined.push({
          sequence: candidate.sequenceRaw,
          reason: "malformed event envelope",
        });
        continue;
      }
      const decodedEvent = decoded.event;
      const atomicHandler = deps.atomicHandler;
      if (atomicHandler?.matches(decodedEvent) === true) {
        yield* deps.tx
          .transact(
            Effect.gen(function* () {
              for (const entry of quarantined.splice(0)) {
                yield* deps.deadLetters.quarantine(
                  consumerId,
                  projectId,
                  entry.sequence,
                  entry.reason,
                );
                quarantinedCount += 1;
              }
              const priorApplied = applied.splice(0);
              if (priorApplied.length > 0) {
                yield* deps.projection.apply(priorApplied);
                appliedCount += priorApplied.length;
              }
              const result = yield* atomicHandler.apply(decodedEvent);
              if (result.quarantineReason !== undefined) {
                yield* deps.deadLetters.quarantine(
                  consumerId,
                  projectId,
                  decodedEvent.sequence,
                  result.quarantineReason,
                );
                quarantinedCount += 1;
              } else {
                yield* deps.projection.apply([decodedEvent]);
                appliedCount += 1;
                if (result.record !== undefined) records.push(result.record);
                if (result.afterCommit !== undefined) {
                  afterCommit.push(result.afterCommit);
                }
              }
              yield* deps.offsets.advance(
                consumerId,
                projectId,
                decodedEvent.sequence,
              );
              return result;
            }),
          )
          .pipe(
            Effect.mapError(
              (cause): TransactionOperationalFailure => ({
                _tag: "TransactionOperationalFailure",
                cause,
              }),
            ),
          );
        committedSequence = decodedEvent.sequence;
        continue;
      }
      const exit = yield* Effect.exit(deps.handlers([decodedEvent]));
      if (Exit.isSuccess(exit)) {
        applied.push(decodedEvent);
        records.push(...exit.value);
        continue;
      }
      const defect = Cause.squash(exit.cause);
      if (isTransientOperational(defect)) {
        // Batch abort: offset stays — redelivery retries the whole batch.
        return yield* Effect.fail<ConsumerLoopError>({
          _tag: "TransactionOperationalFailure",
          cause: defect,
        });
      }
      quarantined.push({
        sequence: decodedEvent.sequence,
        reason: `handler defect: ${safeFailureReason(defect)}`,
      });
    }

    if (
      quarantined.length > 0 ||
      applied.length > 0 ||
      lastSequence !== committedSequence
    ) {
      yield* deps.tx.transact(
        Effect.gen(function* () {
          for (const entry of quarantined) {
            yield* deps.deadLetters.quarantine(
              consumerId,
              projectId,
              entry.sequence,
              entry.reason,
            );
          }
          quarantinedCount += quarantined.length;
          if (applied.length > 0) {
            yield* deps.projection.apply(applied);
            appliedCount += applied.length;
          }
          if (lastSequence !== committedSequence) {
            yield* deps.offsets.advance(consumerId, projectId, lastSequence);
            committedSequence = lastSequence;
          }
        }),
      );
    }
    for (const effect of afterCommit) {
      // Canonical apply + offset are already committed; a scheduler wake is
      // best-effort and durable Inbox/WorkWait facts remain authoritative.
      yield* Effect.exit(effect);
    }
    return {
      fromSequence,
      lastSequence,
      applied: appliedCount,
      quarantined: quarantinedCount,
      records,
    };
  });

const toConsumerEvent = (event: DomainEvent<unknown>) => ({
  eventType: event.eventType as string,
  payload: event.payload,
  eventId: event.eventId as string,
});

/** P7 coordinator wired as a handlers function for `pollOnce`
 * (dependencyCoordinatorDependencies unchanged — the consumer body is
 * not modified, only wrapped). */
export const dependencyCoordinatorLoop =
  <R>(
    projectId: ProjectId,
    principal: Principal,
    dependencies: DependencyCoordinatorDependencies<R>,
  ): ((
    events: ReadonlyArray<DomainEvent<unknown>>,
  ) => Effect.Effect<ReadonlyArray<string>, unknown, R>) =>
  (events) =>
    runDependencyCoordinator(
      events.map(toConsumerEvent),
      dependencies,
      projectId,
      principal,
    );

/** P8 consumer A wired as a handlers function for `pollOnce`. */
export const verificationConsumerLoop =
  <R>(
    projectId: ProjectId,
    principal: Principal,
    dependencies: VerificationConsumerDependencies<R>,
  ): ((
    events: ReadonlyArray<DomainEvent<unknown>>,
  ) => Effect.Effect<ReadonlyArray<string>, unknown, R>) =>
  (events) =>
    runVerificationConsumer(
      events.map(toConsumerEvent),
      dependencies,
      projectId,
      principal,
    );

/** P8 consumer B wired as a handlers function for `pollOnce`. */
export const completionConsumerLoop =
  (
    projectId: ProjectId,
    principal: Principal,
    dependencies: CompletionConsumerDependencies,
  ): ((
    events: ReadonlyArray<DomainEvent<unknown>>,
  ) => Effect.Effect<ReadonlyArray<string>, unknown>) =>
  (events) =>
    runCompletionConsumer(
      events.map(toConsumerEvent),
      dependencies,
      projectId,
      principal,
    );

/** Durable cross-workflow signal delivery. Returned strings are diagnostics;
 * DomainEvent + canonical repositories remain the workflow truth. */
export const workflowSignalConsumerLoop =
  (
    consumer: Pick<WorkflowSignalConsumerService, "consume">,
  ): ((
    events: ReadonlyArray<DomainEvent<unknown>>,
  ) => Effect.Effect<ReadonlyArray<string>, unknown>) =>
  (events) =>
    Effect.map(
      consumer.consume(
        events.map((event) => ({
          eventType: event.eventType,
          payload: event.payload,
          eventId: String(event.eventId),
          occurredAt: event.occurredAt,
        })),
      ),
      (outcomes) =>
        outcomes.map((outcome) =>
          outcome._tag === "Delivered"
            ? `Delivered:${outcome.kind}:${outcome.workspaceId}`
            : `Ignored:${outcome.eventId}`,
        ),
    );

export const workflowSignalAtomicConsumerHandler = (
  consumer: Pick<
    WorkflowSignalConsumerService,
    "applyBlockedWorkEpisodeAtomically"
  >,
): AtomicConsumerHandler => ({
  matches: (event) => {
    if (event.eventType !== "ExecutionSettled") return false;
    const envelope = event.payload as Record<string, unknown> | null;
    const settlement = envelope?.settlement as
      | {
          readonly _tag?: unknown;
          readonly result?: { readonly _tag?: unknown };
        }
      | undefined;
    return (
      settlement?._tag === "Completed" && settlement.result?._tag === "Blocked"
    );
  },
  apply: (event) =>
    consumer.applyBlockedWorkEpisodeAtomically({
      eventId: String(event.eventId),
      eventType: String(event.eventType),
      occurredAt: event.occurredAt,
      payload: event.payload,
    }),
});
