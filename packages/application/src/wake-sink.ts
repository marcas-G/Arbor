import type { WakeCondition, WakeReason, WorkspaceId } from "@arbor/domain";
import type {
  ExecutionSchedulerError,
  ExecutionSchedulerService,
  TransactionOperationalFailure,
  TransactionPortService,
  WorkRepositoryError,
  WorkRepositoryService,
  WorkWaitStoreError,
  WorkWaitStoreService,
} from "@arbor/ports";
import { Effect, Option } from "effect";

/** P7 `06` §3 consumer-side minimal pipeline. Producers (SatisfyDependency
 * `01` §4, Deliver `02` §6) carry wake signals in their handler Results;
 * this sink delivers each signal after the producing transaction commits:
 * clear the DependencyChanged WorkWaits the signal's revision advance
 * obsoletes (observedRevision < toRevision), then trigger `reevaluate` on
 * the target Workspace — at-least-once, idempotent. Wake payloads
 * (dependencyId/fromRevision/toRevision) live here in the delivery record,
 * never in the P2-frozen WakeReason union. */
export interface WakeSignal {
  readonly workspaceId: WorkspaceId;
  readonly reason: "DependencySatisfied" | "InputArrived" | "ChildDelivered";
  readonly detail?: Record<string, unknown>;
}

export type WakeSinkError =
  | WorkRepositoryError
  | WorkWaitStoreError
  | ExecutionSchedulerError
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
}

/** 06 §2 matching: only a DependencyChanged condition on the signalled
 * dependency whose observedRevision the signal advances (r < r') makes the
 * wait obsolete. Stale replays (r >= r') are already-seen facts — no clear. */
const matchesSignalledDependency = (
  conditions: ReadonlyArray<WakeCondition>,
  dependencyId: string,
  toRevision: number,
): boolean =>
  conditions.some(
    (condition) =>
      condition._tag === "DependencyChanged" &&
      condition.dependencyId === dependencyId &&
      condition.observedRevision < toRevision,
  );

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
        // Clear semantics apply only to a dependency revision advance
        // (06 §2); InputArrived/ChildDelivered reevaluate without clearing.
        if (signal.reason !== "DependencySatisfied") {
          return 0;
        }
        const detail = signal.detail ?? {};
        const { dependencyId, toRevision } = detail;
        if (
          typeof dependencyId !== "string" ||
          typeof toRevision !== "number"
        ) {
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
            matchesSignalledDependency(
              wait.value.waitSpec.conditions,
              dependencyId,
              toRevision,
            )
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
