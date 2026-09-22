import type {
  EnvironmentChanged,
  ProjectId,
  WakeCondition,
  WakeReason,
  WorkspaceId,
} from "@arbor/domain";
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
import { Effect, Option, type Schema } from "effect";

/** P11 `06` §1 BROAD: an EnvironmentChanged event wakes every waiter
 * whose observedRevision < toRevision. Same delivery shape as the P8
 * verification-wake channel 1 (P7 wake-sink transaction precedent) and
 * the same-source input as the P11-002 REC commit facts
 * (outcome.facts.wakeTargets). The NARROW invalidate of `06` lives in
 * environment-impact.ts; this side never judges regions. */

/** The frozen seven-field EnvironmentChanged event payload. */
export type EnvironmentChangedPayload = Schema.Schema.Type<
  typeof EnvironmentChanged
>;

/** Delivery input: the event payload plus the environmentRef the waits'
 * conditions carry — recovered from the project row by the caller (the
 * event itself does not duplicate the ref). */
export interface EnvironmentChangedConclusion
  extends EnvironmentChangedPayload {
  readonly environmentRef: string;
}

export type EnvironmentWakeError =
  | WorkRepositoryError
  | WorkWaitStoreError
  | ExecutionSchedulerError
  | TransactionOperationalFailure;

export interface EnvironmentWakeDelivery {
  readonly releasedWaits: number;
  readonly wokenWorkspaces: ReadonlyArray<WorkspaceId>;
}

export interface EnvironmentWakeDependencies {
  readonly tx: Pick<TransactionPortService, "transact">;
  readonly waits: Pick<WorkWaitStoreService, "listActive" | "clear">;
  readonly works: Pick<WorkRepositoryService, "findById">;
  readonly scheduler: Pick<ExecutionSchedulerService, "reevaluate">;
}

/** `06` §1 broad matching: only an EnvironmentChanged condition on the
 * same environment whose observedRevision the event advances (r < r',
 * counters compared numerically — P11 `01` §1) is the fact change the
 * wait expresses. Equality or newer revisions are already-seen facts. */
const matchesEnvironmentChange = (
  conditions: ReadonlyArray<WakeCondition>,
  environmentRef: string,
  toRevision: string,
): boolean =>
  conditions.some(
    (condition) =>
      condition._tag === "EnvironmentChanged" &&
      condition.environmentRef === environmentRef &&
      Number(condition.observedRevision) < Number(toRevision),
  );

/** Deliver one EnvironmentChanged event's broad wake: clear + reevaluate
 * (workspace, {_tag: "EnvironmentChanged"}). The clears commit in their
 * own transaction; the reevaluates run after it (the scheduler
 * transacts internally; the sqlite port rejects nested transactions),
 * once per workspace that had a wait cleared. Idempotent under
 * at-least-once redelivery: re-clearing a cleared wait is a DELETE
 * no-op, and with no wait cleared no reevaluate fires — a replay is a
 * full no-op. A wait without its Work row cannot be scoped to the
 * project — skip it rather than abort the remaining releases (P8
 * precedent). */
export const deliverEnvironmentChangedWake = (
  conclusion: EnvironmentChangedConclusion,
  deps: EnvironmentWakeDependencies,
): Effect.Effect<EnvironmentWakeDelivery, EnvironmentWakeError> =>
  Effect.gen(function* () {
    const released = yield* deps.tx.transact(
      Effect.gen(function* () {
        const active = yield* deps.waits.listActive();
        let releasedWaits = 0;
        const woken = new Set<WorkspaceId>();
        for (const wait of active) {
          const work = yield* deps.works.findById(wait.workId);
          if (Option.isNone(work)) {
            continue;
          }
          if (work.value.projectId !== (conclusion.projectId as ProjectId)) {
            continue;
          }
          if (
            !matchesEnvironmentChange(
              wait.waitSpec.conditions,
              conclusion.environmentRef,
              conclusion.toRevision,
            )
          ) {
            continue;
          }
          yield* deps.waits.clear(wait.workId);
          releasedWaits += 1;
          woken.add(work.value.workspaceId);
        }
        return { releasedWaits, wokenWorkspaces: [...woken] };
      }),
    );
    for (const workspaceId of released.wokenWorkspaces) {
      const reason: WakeReason = { _tag: "EnvironmentChanged" };
      yield* deps.scheduler.reevaluate(workspaceId, reason);
    }
    return released;
  });
