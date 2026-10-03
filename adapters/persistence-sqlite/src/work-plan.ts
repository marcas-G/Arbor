import type { WorkId, WorkRevision } from "@arbor/domain";
import {
  type LocalPlan,
  type LocalPlanItem,
  LocalPlanStore,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

interface WorkPlanRow {
  readonly work_id: string;
  readonly target_work_revision: number;
  readonly plan_revision: number;
  readonly items_json: string;
  readonly updated_at: string;
}

const toPlan = (row: WorkPlanRow): LocalPlan => ({
  workId: row.work_id as WorkId,
  targetWorkRevision: row.target_work_revision as WorkRevision,
  revision: row.plan_revision,
  items: JSON.parse(row.items_json) as ReadonlyArray<LocalPlanItem>,
  updatedAt: row.updated_at,
});

export const LocalPlanStoreLive: Layer.Layer<LocalPlanStore, never, SqlClient> =
  Layer.effect(
    LocalPlanStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const failure = repositoryFailure("LocalPlanStore", "work-plan");
      const run = <A>(effect: Effect.Effect<A, SqlError>) =>
        effect.pipe(Effect.mapError(failure));
      return LocalPlanStore.of({
        findByWork: (workId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* run(
              sql.unsafe<WorkPlanRow>(
                "SELECT * FROM work_plans WHERE work_id = ?",
                [workId],
              ),
            );
            return rows[0] === undefined
              ? Option.none()
              : Option.some(toPlan(rows[0]));
          }),
        save: (plan, expectedPlanRevision) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            if (expectedPlanRevision === 0) {
              const inserted = yield* run(
                sql.unsafe<{ work_id: string }>(
                  "INSERT INTO work_plans (work_id, target_work_revision, plan_revision, items_json, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(work_id) DO NOTHING RETURNING work_id",
                  [
                    plan.workId,
                    plan.targetWorkRevision,
                    plan.revision,
                    JSON.stringify(plan.items),
                    plan.updatedAt,
                  ],
                ),
              );
              if (inserted.length === 0) {
                return yield* Effect.fail({
                  _tag: "LocalPlanStoreRevisionConflict" as const,
                });
              }
              return;
            }
            const updated = yield* run(
              sql.unsafe<{ work_id: string }>(
                "UPDATE work_plans SET target_work_revision=?, plan_revision=?, items_json=?, updated_at=? WHERE work_id=? AND plan_revision=? RETURNING work_id",
                [
                  plan.targetWorkRevision,
                  plan.revision,
                  JSON.stringify(plan.items),
                  plan.updatedAt,
                  plan.workId,
                  expectedPlanRevision,
                ],
              ),
            );
            if (updated.length === 0) {
              return yield* Effect.fail({
                _tag: "LocalPlanStoreRevisionConflict" as const,
              });
            }
          }),
      });
    }),
  );

/** @deprecated MAC compatibility export. */
export const WorkPlanStoreLive = LocalPlanStoreLive;
