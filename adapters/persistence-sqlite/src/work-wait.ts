import type { WaitSpec, WorkId, WorkspaceId } from "@arbor/domain";
import {
  type SchedulerTimer,
  SchedulerTimerStore,
  type SchedulerTimerStoreError,
  TransactionScope,
  type WorkWait,
  WorkWaitStore,
  type WorkWaitStoreError,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

interface WaitRow {
  readonly work_id: string;
  readonly wait_mode: string;
  readonly conditions_json: string;
  readonly registered_at: string;
  readonly updated_at: string;
}

interface TimerRow {
  readonly timer_id: string;
  readonly workspace_id: string;
  readonly work_id: string | null;
  readonly kind: string;
  readonly fire_at: string;
  readonly created_at: string;
}

const toWait = (row: WaitRow): WorkWait => ({
  workId: row.work_id as WorkId,
  waitSpec: {
    mode: "Any",
    conditions: JSON.parse(row.conditions_json) as WaitSpec["conditions"],
  },
  registeredAt: row.registered_at,
  updatedAt: row.updated_at,
});

const toTimer = (row: TimerRow): SchedulerTimer => ({
  timerId: row.timer_id,
  workspaceId: row.workspace_id as WorkspaceId,
  workId: row.work_id as WorkId | null,
  kind: "TimeReached",
  fireAt: row.fire_at,
  createdAt: row.created_at,
});

export const WorkWaitStoreLive: Layer.Layer<WorkWaitStore, never, SqlClient> =
  Layer.effect(
    WorkWaitStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const failure = (cause: unknown): WorkWaitStoreError => ({
        _tag: "WorkWaitStoreFailure",
        cause,
      });
      const run = <A>(effect: Effect.Effect<A, SqlError>) =>
        effect.pipe(Effect.mapError(failure));
      return WorkWaitStore.of({
        upsert: (wait) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            if (wait.waitSpec.conditions.length === 0) {
              return yield* Effect.die(
                new Error("WorkWait requires a non-empty WaitSpec"),
              );
            }
            yield* run(
              sql.unsafe(
                "INSERT INTO work_waits (work_id, wait_mode, conditions_json, registered_at, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET wait_mode = excluded.wait_mode, conditions_json = excluded.conditions_json, registered_at = excluded.registered_at, updated_at = excluded.updated_at",
                [
                  wait.workId,
                  wait.waitSpec.mode,
                  JSON.stringify(wait.waitSpec.conditions),
                  wait.registeredAt,
                  wait.updatedAt,
                ],
              ),
            );
          }),
        findByWork: (workId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* run(
              sql.unsafe<WaitRow>(
                "SELECT * FROM work_waits WHERE work_id = ?",
                [workId],
              ),
            );
            const row = rows[0];
            return row === undefined ? Option.none() : Option.some(toWait(row));
          }),
        clear: (workId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            yield* run(
              sql.unsafe("DELETE FROM work_waits WHERE work_id = ?", [workId]),
            );
          }),
        listActive: () =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* run(
              sql.unsafe<WaitRow>("SELECT * FROM work_waits"),
            );
            return rows.map(toWait);
          }),
      });
    }),
  );

export const SchedulerTimerStoreLive: Layer.Layer<
  SchedulerTimerStore,
  never,
  SqlClient
> = Layer.effect(
  SchedulerTimerStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = (cause: unknown): SchedulerTimerStoreError => ({
      _tag: "SchedulerTimerStoreFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    return SchedulerTimerStore.of({
      schedule: (timer) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              "INSERT INTO scheduler_timers (timer_id, workspace_id, work_id, kind, fire_at, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(timer_id) DO UPDATE SET workspace_id = excluded.workspace_id, work_id = excluded.work_id, kind = excluded.kind, fire_at = excluded.fire_at",
              [
                timer.timerId,
                timer.workspaceId,
                timer.workId,
                timer.kind,
                timer.fireAt,
                timer.createdAt,
              ],
            ),
          );
        }),
      due: (now) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<TimerRow>(
              "SELECT * FROM scheduler_timers WHERE fire_at <= ? ORDER BY fire_at",
              [now],
            ),
          );
          return rows.map(toTimer);
        }),
      cancel: (timerId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe("DELETE FROM scheduler_timers WHERE timer_id = ?", [
              timerId,
            ]),
          );
        }),
    });
  }),
);
