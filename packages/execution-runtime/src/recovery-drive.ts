import type { ExecutionId, Principal, WorkspaceId } from "@arbor/domain";
import {
  Clock,
  ExecutionRepository,
  ExecutionScheduler,
  type SchedulerTimer,
  SchedulerTimerStore,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type { RecoveryResult } from "./recovery.js";
import { runRecovery } from "./recovery.js";

/** P9 `03` §3 (B-9) / P2 `05` §6: fire due timers — clear the timer row in
 * the SAME transaction as the fire decision, then drive `reevaluate` for
 * each owning Workspace (existing TimeReached condition semantics, DID
 * §8.16). Wake delivery is at-least-once; re-delivery re-runs reevaluate,
 * idempotent given current canonical state. No Worker in-memory timer is
 * authoritative. */
export const fireDueTimers: Effect.Effect<
  ReadonlyArray<SchedulerTimer>,
  unknown,
  TransactionPort | SchedulerTimerStore | ExecutionScheduler | Clock
> = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const timers = yield* SchedulerTimerStore;
  const clock = yield* Clock;
  const now = yield* clock.now();
  const due = yield* tx.transact(
    Effect.gen(function* () {
      const due = yield* timers.due(now);
      for (const timer of due) {
        yield* timers.cancel(timer.timerId);
      }
      return due;
    }),
  );
  if (due.length > 0) {
    // Point-of-use resolution: a pass with no due timers touches no
    // scheduler — the wake drive runs only when something fired.
    const scheduler = yield* ExecutionScheduler;
    const woken: WorkspaceId[] = [];
    for (const timer of due) {
      if (woken.includes(timer.workspaceId)) {
        continue;
      }
      woken.push(timer.workspaceId);
      yield* scheduler.reevaluate(timer.workspaceId, { _tag: "Recovery" });
    }
  }
  return due;
});

const fullRecoveryPass = (principal: Principal) =>
  Effect.gen(function* () {
    const recovery = yield* runRecovery(principal);
    const firedTimers = yield* fireDueTimers;
    return { recovery, firedTimers };
  });

/** T1 (P9 `03` §2): startup full recovery — the nine-step pass plus the
 * durable-timer re-drive, exactly once per daemon startup, before any new
 * dispatch or admission; idempotent re-entry on crash-during-T1 restart. */
export const startupRecovery = fullRecoveryPass;

/** T2/T3 (P9 `03` §2): periodic + event-triggered sweeps — the same
 * nine-step pass as T1, coalesced; single-flight is the caller's
 * discipline (P2 `05` §8). */
export const sweepRecovery = fullRecoveryPass;

/** T4 (GQ3 prohibition): the targeted pre-dispatch check — the
 * lease-fence predicate ONLY, never the nine-step recovery. A live,
 * unexpired lease for the execution skips the dispatch; an expired lease
 * is lazily invalidated at acquisition (P2 `06` §3), so the dispatch may
 * proceed. Zero side effects: a single-predicate read. */
export const preDispatchCheck = (
  executionId: ExecutionId,
): Effect.Effect<
  boolean,
  unknown,
  ExecutionRepository | TransactionPort | Clock
> =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const repository = yield* ExecutionRepository;
    const clock = yield* Clock;
    const now = yield* clock.now();
    return yield* tx.transact(
      Effect.gen(function* () {
        const lease = yield* repository.currentLease(executionId);
        if (Option.isNone(lease)) {
          return true;
        }
        return Date.parse(lease.value.expiresAt) <= Date.parse(now);
      }),
    );
  });

/** The GQ3-frozen trigger surface (P9 `01` §3 / `03` §2). */
export const recoveryPass = {
  startup: startupRecovery,
  sweep: sweepRecovery,
  preDispatchCheck,
} as const;
