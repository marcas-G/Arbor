import type {
  VerificationId,
  VerificationVerdict,
  WakeCondition,
  WakeReason,
  WorkId,
  WorkRevision,
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
import { Effect, Option } from "effect";

/** P8 `03` §3 dual-channel wake consumption (P8-009): consumes the
 * ConcludeVerification Result data (P8-004 `channel1Release` + verdict +
 * owner workspace) after the conclude transaction commits. Channel 1
 * releases `VerificationChanged` waits on ANY verdict (satisfaction ⟂
 * quality); channel 2 routes a `VerificationReturned` reevaluate for
 * FAIL/UNKNOWN only — PASS never wakes channel 2 (Acceptance is Parent
 * cognition, not a wake event). Parallel to the P7 wake-sink (same
 * delivery shape, distinct semantics); the P2/P7 sink is untouched. */

export interface VerificationConclusion {
  readonly workId: WorkId;
  readonly targetWorkRevision: WorkRevision;
  readonly verdict: VerificationVerdict;
  readonly verificationId: VerificationId;
  readonly ownerWorkspaceId: WorkspaceId;
}

export type VerificationWakeError =
  | WorkRepositoryError
  | WorkWaitStoreError
  | ExecutionSchedulerError
  | TransactionOperationalFailure;

export interface VerificationWakeDelivery {
  readonly releasedWaits: number;
  readonly routed: boolean;
}

export interface VerificationWakeDependencies {
  readonly tx: Pick<TransactionPortService, "transact">;
  readonly waits: Pick<WorkWaitStoreService, "listActive" | "clear">;
  readonly works: Pick<WorkRepositoryService, "findById">;
  readonly scheduler: Pick<ExecutionSchedulerService, "reevaluate">;
}

/** `03` §3 channel 1 exact-equality matching (v1.11 G2 work-level shape):
 * only a `VerificationChanged{workId, targetWorkRevision}` condition with
 * BOTH fields equal to the conclusion is the fact change the wait
 * expresses. A persisted pre-M-1 condition row (keyed by
 * verificationId/observedRevision) has no workId — it never matches
 * (migration semantics as-is). */
const matchesConcludedVerification = (
  conditions: ReadonlyArray<WakeCondition>,
  workId: WorkId,
  targetWorkRevision: number,
): boolean =>
  conditions.some(
    (condition) =>
      condition._tag === "VerificationChanged" &&
      condition.workId === workId &&
      condition.targetWorkRevision === targetWorkRevision,
  );

/** Deliver one conclusion's dual-channel wake. P7 wake-sink transaction
 * boundary precedent: the channel-1 clears commit in their own
 * transaction, then channel 2 reevaluates outside it (the scheduler
 * transacts internally; the sqlite port rejects nested transactions).
 * Idempotent under at-least-once redelivery: re-clearing a cleared wait
 * is a DELETE no-op (releasedWaits 0 on replay) and a repeated
 * reevaluate re-derives the same decision without model polling
 * (SD No.53). */
export const deliverVerificationWake = (
  conclusion: VerificationConclusion,
  deps: VerificationWakeDependencies,
): Effect.Effect<VerificationWakeDelivery, VerificationWakeError> =>
  Effect.gen(function* () {
    const releasedWaits = yield* deps.tx.transact(
      Effect.gen(function* () {
        const active = yield* deps.waits.listActive();
        let released = 0;
        for (const wait of active) {
          // Work→workspace scoping (`03` §3 "the target Workspace's
          // Works"): only waits whose owning Work belongs to the
          // conclusion's Workspace are this conclusion's business. A
          // wait without its Work row cannot be scoped — skip it rather
          // than abort the remaining releases.
          const work = yield* deps.works.findById(wait.workId);
          if (Option.isNone(work)) {
            continue;
          }
          if (work.value.workspaceId !== conclusion.ownerWorkspaceId) {
            continue;
          }
          if (
            matchesConcludedVerification(
              wait.waitSpec.conditions,
              conclusion.workId,
              conclusion.targetWorkRevision,
            )
          ) {
            yield* deps.waits.clear(wait.workId);
            released += 1;
          }
        }
        return released;
      }),
    );
    // Channel 2 (`03` §3): FAIL/UNKNOWN route the producer-side rework /
    // evidence entry; PASS never fires this channel. `routed` reports
    // the routing decision, so a replayed Fail stays routed: true while
    // its repeated reevaluate is a harmless re-derivation.
    const routed = conclusion.verdict !== "Pass";
    if (routed) {
      const reason: WakeReason = { _tag: "VerificationReturned" };
      yield* deps.scheduler.reevaluate(conclusion.ownerWorkspaceId, reason);
    }
    return { releasedWaits, routed };
  });

/** Sequential at-least-once delivery of a conclusion batch; each
 * conclusion delivers independently and idempotently. */
export const consumeConclusionSignals = (
  conclusions: ReadonlyArray<VerificationConclusion>,
  deps: VerificationWakeDependencies,
): Effect.Effect<
  ReadonlyArray<VerificationWakeDelivery>,
  VerificationWakeError
> =>
  Effect.forEach(conclusions, (conclusion) =>
    deliverVerificationWake(conclusion, deps),
  );
