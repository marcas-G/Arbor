import type { WakeReason, WorkId, WorkspaceId } from "@arbor/domain";
import {
  ExecutionRepository,
  ExecutionScheduler,
  type ExecutionSchedulerError,
  RunnableWorkSource,
  type SchedulerDecision,
  type SchedulerTimer,
  SchedulerTimerStore,
  TransactionPort,
  type WorkWait,
  WorkWaitStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";

const decide = (
  current: Option.Option<WorkId>,
  runnableWork: ReadonlyArray<WorkId>,
  hasWait: boolean,
): SchedulerDecision => {
  const count = runnableWork.length;
  if (Option.isSome(current) && !hasWait) {
    return { _tag: "Admit", focus: { _tag: "Work", workId: current.value } };
  }
  if (count === 0) {
    return { _tag: "Idle" };
  }
  if (count === 1) {
    return { _tag: "SelectCurrentWork", workId: runnableWork[0] as WorkId };
  }
  return { _tag: "Admit", focus: { _tag: "Coordination" } };
};

export const ExecutionSchedulerLive: Layer.Layer<
  ExecutionScheduler,
  never,
  | ExecutionRepository
  | RunnableWorkSource
  | WorkWaitStore
  | SchedulerTimerStore
  | TransactionPort
> = Layer.effect(
  ExecutionScheduler,
  Effect.gen(function* () {
    const repository = yield* ExecutionRepository;
    const runnable = yield* RunnableWorkSource;
    const waits = yield* WorkWaitStore;
    const timers = yield* SchedulerTimerStore;
    const tx = yield* TransactionPort;

    const reevaluate = (
      workspaceId: WorkspaceId,
      _wakeReason: WakeReason,
    ): Effect.Effect<SchedulerDecision, ExecutionSchedulerError> =>
      tx
        .transact(
          Effect.gen(function* () {
            const active =
              yield* repository.findActiveMainByWorkspace(workspaceId);
            if (Option.isSome(active)) {
              return {
                _tag: "Noop",
                reason: "ActiveMainExecution",
              } as SchedulerDecision;
            }
            const classified = yield* runnable.classify(workspaceId);
            const hasWait = Option.isSome(classified.current)
              ? Option.isSome(yield* waits.findByWork(classified.current.value))
              : false;
            return decide(classified.current, classified.runnable, hasWait);
          }),
        )
        .pipe(
          Effect.mapError(
            (cause): ExecutionSchedulerError => ({
              _tag: "ExecutionSchedulerError",
              cause,
            }),
          ),
        );

    return ExecutionScheduler.of({
      reevaluate,
      registerWorkWait: (wait: WorkWait) => waits.upsert(wait),
      clearWorkWait: (workId) => waits.clear(workId),
      scheduleTimer: (timer: SchedulerTimer) => timers.schedule(timer),
      dueTimers: (now) => timers.due(now),
    });
  }),
);

export const RunnableWorkSourceStubLive: Layer.Layer<RunnableWorkSource> =
  Layer.succeed(RunnableWorkSource, {
    classify: (_workspaceId: WorkspaceId) =>
      Effect.succeed({ current: Option.none(), runnable: [] }),
  });
