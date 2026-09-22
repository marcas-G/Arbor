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
  readonly journal: Pick<DomainEventJournalService, "readAfter">;
  readonly offsets: ConsumerOffsetStoreService;
  readonly deadLetters: ConsumerDeadLetterStoreService;
  readonly projection: ProjectionStoreService;
}

export interface ConsumerLoopResult {
  readonly fromSequence: number;
  readonly lastSequence: number;
  readonly applied: number;
  readonly quarantined: number;
  readonly records: ReadonlyArray<string>;
}

/** P1 `05` §3 reader ceiling: events above it are poison path 1 (CC-3). */
const READER_EVENT_VERSION_CEILING = 1;

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
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
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
  },
): Effect.Effect<ConsumerLoopResult, ConsumerLoopError, R> =>
  Effect.gen(function* () {
    const { fromSequence, events } = yield* deps.tx.transact(
      Effect.gen(function* () {
        const fromSequence = yield* deps.offsets.read(consumerId, projectId);
        const events = yield* deps.journal.readAfter(
          projectId,
          fromSequence,
          batchSize,
        );
        return { fromSequence, events };
      }),
    );

    const quarantined: QuarantineEntry[] = [];
    const applied: DomainEvent<unknown>[] = [];
    const records: string[] = [];
    let lastSequence = fromSequence;
    for (const event of events) {
      lastSequence = event.sequence;
      if (event.eventVersion > READER_EVENT_VERSION_CEILING) {
        quarantined.push({
          sequence: event.sequence,
          reason: `unsupported eventVersion ${event.eventVersion}`,
        });
        continue;
      }
      const exit = yield* Effect.exit(deps.handlers([event]));
      if (Exit.isSuccess(exit)) {
        applied.push(event);
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
        sequence: event.sequence,
        reason: `handler defect: ${String(defect)}`,
      });
    }

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
        if (applied.length > 0) {
          yield* deps.projection.apply(applied);
        }
        if (lastSequence !== fromSequence) {
          yield* deps.offsets.advance(consumerId, projectId, lastSequence);
        }
      }),
    );
    return {
      fromSequence,
      lastSequence,
      applied: applied.length,
      quarantined: quarantined.length,
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
