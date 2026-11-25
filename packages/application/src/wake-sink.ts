import type { WakeCondition, WakeReason, WorkspaceId } from "@arbor/domain";
import type {
  ExecutionSchedulerError,
  ExecutionSchedulerService,
  InboxProjectionStoreError,
  InboxProjectionStoreService,
  TransactionOperationalFailure,
  TransactionPortService,
  WorkRepositoryError,
  WorkRepositoryService,
  WorkWaitStoreError,
  WorkWaitStoreService,
} from "@arbor/ports";
import { Effect, Option } from "effect";

/** P7 `06` §3 consumer-side minimal pipeline. This sink delivers each signal
 * after the producing transaction commits: DependencySatisfied is an
 * independent terminal fact and clears matching DependencyChanged waits even
 * though satisfaction intentionally keeps the Dependency revision stable;
 * then trigger `reevaluate` on
 * the target Workspace — at-least-once, idempotent. Wake payloads
 * (dependencyId/fromRevision/toRevision) live here in the delivery record,
 * never in the P2-frozen WakeReason union. */
export interface WakeSignal {
  readonly workspaceId: WorkspaceId;
  readonly reason:
    | "DependencySatisfied"
    | "InputArrived"
    | "HumanIntervention"
    | "ChildDelivered";
  readonly detail?: Record<string, unknown>;
}

export type WakeSinkError =
  | WorkRepositoryError
  | WorkWaitStoreError
  | ExecutionSchedulerError
  | InboxProjectionStoreError
  | TransactionOperationalFailure;

export interface WakeDelivery {
  readonly woke: boolean;
  readonly clearedWaits: number;
}

export interface WakeSinkDependencies {
  readonly tx: Pick<TransactionPortService, "transact">;
  readonly waits: Pick<WorkWaitStoreService, "findByWork" | "clear">;
  readonly works: Pick<WorkRepositoryService, "listByWorkspace">;
  readonly scheduler: Pick<ExecutionSchedulerService, "reevaluate">;
  readonly inbox?: Pick<InboxProjectionStoreService, "listUnconsumed">;
}

/** WSC-1 governance: DependencySatisfied is terminal and makes every wait on
 * that exact dependency obsolete, independent of revision movement. */
const matchesSignalledDependency = (
  conditions: ReadonlyArray<WakeCondition>,
  dependencyId: string,
): boolean =>
  conditions.some(
    (condition) =>
      condition._tag === "DependencyChanged" &&
      condition.dependencyId === dependencyId,
  );

const matchesAdvancedInbox = (
  conditions: ReadonlyArray<WakeCondition>,
  workspaceId: WorkspaceId,
  sequence: number,
): boolean =>
  conditions.some(
    (condition) =>
      condition._tag === "InboxAdvanced" &&
      condition.workspaceId === workspaceId &&
      sequence > condition.observedSequence,
  );

/** A plain Manual wait is released by an authenticated human intervention
 * such as SteerWork. Blocked Work uses Manual + InboxAdvanced and must still
 * wait for the exact inbox sequence; otherwise a steer could bypass the
 * durable blocker-resolution path. */
const matchesHumanIntervention = (
  conditions: ReadonlyArray<WakeCondition>,
): boolean =>
  conditions.some((condition) => condition._tag === "Manual") &&
  !conditions.some((condition) => condition._tag === "InboxAdvanced");

/** Deliver one wake signal (06 §3): clear → reevaluate. The clears commit
 * in their own transaction; `reevaluate` runs after that transaction (the
 * scheduler transacts internally and the sqlite port rejects nested
 * transactions) — at-least-once redelivery makes the gap idempotent:
 * re-clearing a cleared wait is a DELETE no-op and a repeated reevaluate
 * re-derives the same decision without model polling (SD No.53). */
export const deliverWakeSignal = (
  signal: WakeSignal,
  deps: WakeSinkDependencies,
): Effect.Effect<WakeDelivery, WakeSinkError> =>
  Effect.gen(function* () {
    const wakeReason: WakeReason = { _tag: signal.reason };
    const clearedWaits = yield* deps.tx.transact(
      Effect.gen(function* () {
        // Waits clear only when the signal proves the exact observed fact
        // advanced. Generic InputArrived does not release unrelated waits.
        if (
          signal.reason !== "DependencySatisfied" &&
          signal.reason !== "InputArrived" &&
          signal.reason !== "HumanIntervention"
        ) {
          return 0;
        }
        const detail = signal.detail ?? {};
        const { dependencyId, inboxSequence, workId, entryKey } = detail;
        if (signal.reason === "HumanIntervention") {
          // A replayed SteerWork receipt must not release a later wait after
          // the Agent has already consumed that exact correction. Check the
          // existing Inbox ledger in the same transaction as the wait clear.
          if (
            deps.inbox === undefined ||
            typeof workId !== "string" ||
            typeof entryKey !== "string"
          ) {
            return 0;
          }
          const pending = yield* deps.inbox.listUnconsumed(signal.workspaceId);
          if (
            !pending.some(
              (entry) =>
                entry.entryKey === entryKey && entry.kind === "HumanInput",
            )
          ) {
            return 0;
          }
        }
        const dependencySignal =
          signal.reason === "DependencySatisfied" &&
          typeof dependencyId === "string";
        const inboxSignal =
          (signal.reason === "InputArrived" ||
            signal.reason === "HumanIntervention") &&
          typeof inboxSequence === "number" &&
          Number.isSafeInteger(inboxSequence) &&
          inboxSequence >= 0;
        if (!dependencySignal && !inboxSignal) {
          // Malformed delivery record: no wait can match; the reevaluate
          // below still satisfies the at-least-once contract.
          return 0;
        }
        const works = yield* deps.works.listByWorkspace(signal.workspaceId);
        let cleared = 0;
        for (const work of works) {
          const wait = yield* deps.waits.findByWork(work.workId);
          if (
            Option.isSome(wait) &&
            ((dependencySignal &&
              matchesSignalledDependency(
                wait.value.waitSpec.conditions,
                dependencyId as string,
              )) ||
              (inboxSignal &&
                matchesAdvancedInbox(
                  wait.value.waitSpec.conditions,
                  signal.workspaceId,
                  inboxSequence as number,
                )) ||
              (signal.reason === "HumanIntervention" &&
                work.workId === workId &&
                (matchesHumanIntervention(wait.value.waitSpec.conditions) ||
                  // P8 `03` / S2-RDG-01: an old verification remains an
                  // immutable investigation, but its wait must not park a
                  // newer revision of the producer Work. Clear only this
                  // Work's obsolete self-wait, never a dependency on another
                  // Work or a wait for the current/future revision.
                  wait.value.waitSpec.conditions.some(
                    (condition) =>
                      condition._tag === "VerificationChanged" &&
                      condition.workId === work.workId &&
                      condition.targetWorkRevision < work.revision,
                  ))))
          ) {
            yield* deps.waits.clear(work.workId);
            cleared += 1;
          }
        }
        return cleared;
      }),
    );
    yield* deps.scheduler.reevaluate(signal.workspaceId, wakeReason);
    return { woke: clearedWaits > 0, clearedWaits };
  });

/** Sequential at-least-once delivery of a signal batch; each signal is
 * delivered independently and idempotently (see deliverWakeSignal). */
export const consumeWakeSignals = (
  signals: ReadonlyArray<WakeSignal>,
  deps: WakeSinkDependencies,
): Effect.Effect<ReadonlyArray<WakeDelivery>, WakeSinkError> =>
  Effect.forEach(signals, (signal) => deliverWakeSignal(signal, deps));
