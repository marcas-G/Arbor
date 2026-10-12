import type { Sha256, WorkBlocker, WorkId, WorkRevision } from "@arbor/domain";
import {
  TransactionScope,
  WorkBlockerStore,
  type WorkBlockerStoreService,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  persistenceCorruption,
  repositoryFailure,
} from "./repository-error.js";

interface WorkBlockerRow {
  readonly blocker_id: string;
  readonly project_id: string;
  readonly workspace_id: string;
  readonly work_id: string;
  readonly target_work_revision: number;
  readonly failure_fingerprint: string;
  readonly state: string;
  readonly open_cycle_id: string;
  readonly latest_request_ref: string;
  readonly failed_action_refs_json: string;
  readonly revision: number;
}

const decode = (row: WorkBlockerRow): WorkBlocker => {
  let failedActionRefs: WorkBlocker["failedActionRefs"];
  try {
    const parsed: unknown = JSON.parse(row.failed_action_refs_json);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("expected non-empty action reference array");
    }
    failedActionRefs = parsed as WorkBlocker["failedActionRefs"];
  } catch {
    throw persistenceCorruption(
      "WorkBlockerStore",
      "decode",
      "failed_action_refs_json is not a non-empty JSON array",
    );
  }
  if (
    row.state !== "Open" &&
    row.state !== "Resolved" &&
    row.state !== "Superseded"
  ) {
    throw persistenceCorruption(
      "WorkBlockerStore",
      "decode",
      `unsupported WorkBlocker state: ${row.state}`,
    );
  }
  return {
    blockerId: row.blocker_id as Sha256,
    projectId: row.project_id as WorkBlocker["projectId"],
    workspaceId: row.workspace_id as WorkBlocker["workspaceId"],
    workId: row.work_id as WorkId,
    targetWorkRevision: row.target_work_revision as WorkRevision,
    failureFingerprint: row.failure_fingerprint as Sha256,
    state: row.state,
    openCycleId: row.open_cycle_id as WorkBlocker["openCycleId"],
    latestRequestRef: row.latest_request_ref,
    failedActionRefs,
    revision: row.revision,
  };
};

const selectColumns =
  "blocker_id, project_id, workspace_id, work_id, target_work_revision, failure_fingerprint, state, open_cycle_id, latest_request_ref, failed_action_refs_json, revision";

const sameOpenContent = (left: WorkBlocker, right: WorkBlocker): boolean =>
  left.state === "Open" &&
  right.state === "Open" &&
  left.blockerId === right.blockerId &&
  left.projectId === right.projectId &&
  left.workspaceId === right.workspaceId &&
  left.workId === right.workId &&
  left.targetWorkRevision === right.targetWorkRevision &&
  left.failureFingerprint === right.failureFingerprint &&
  left.openCycleId === right.openCycleId &&
  left.latestRequestRef === right.latestRequestRef &&
  JSON.stringify(left.failedActionRefs) ===
    JSON.stringify(right.failedActionRefs);

export const WorkBlockerStoreLive: Layer.Layer<
  WorkBlockerStore,
  never,
  SqlClient
> = Layer.effect(
  WorkBlockerStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = repositoryFailure("WorkBlockerStore", "work-blocker");
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));

    const findById = (
      blockerId: Sha256,
    ): ReturnType<WorkBlockerStoreService["findById"]> =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const rows = yield* run(
          sql.unsafe<WorkBlockerRow>(
            `SELECT ${selectColumns} FROM work_blockers WHERE blocker_id = ?`,
            [blockerId],
          ),
        );
        const row = rows[0];
        return row === undefined ? Option.none() : Option.some(decode(row));
      });

    return WorkBlockerStore.of({
      findById,
      listByWorkRevision: (workId: WorkId, targetWorkRevision: WorkRevision) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<WorkBlockerRow>(
              `SELECT ${selectColumns} FROM work_blockers WHERE work_id = ? AND target_work_revision = ? ORDER BY blocker_id`,
              [workId, targetWorkRevision],
            ),
          );
          return rows.map(decode);
        }),
      openOrUpdate: (blocker) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          if (blocker.failedActionRefs.length === 0) {
            return yield* Effect.die(
              new Error("WorkBlocker requires non-empty failedActionRefs"),
            );
          }
          const rows = yield* run(
            sql.unsafe<WorkBlockerRow>(
              `INSERT INTO work_blockers (
                blocker_id, project_id, workspace_id, work_id,
                target_work_revision, failure_fingerprint, state, open_cycle_id,
                latest_request_ref, failed_action_refs_json, revision
              ) VALUES (?,?,?,?,?,?,'Open',?,?,?,?)
              ON CONFLICT(blocker_id) DO UPDATE SET
                project_id = excluded.project_id,
                workspace_id = excluded.workspace_id,
                work_id = excluded.work_id,
                target_work_revision = excluded.target_work_revision,
                failure_fingerprint = excluded.failure_fingerprint,
                state = 'Open',
                open_cycle_id = excluded.open_cycle_id,
                latest_request_ref = excluded.latest_request_ref,
                failed_action_refs_json = excluded.failed_action_refs_json,
                revision = work_blockers.revision + 1
              WHERE work_blockers.state != 'Open'
                 OR work_blockers.project_id != excluded.project_id
                 OR work_blockers.workspace_id != excluded.workspace_id
                 OR work_blockers.work_id != excluded.work_id
                 OR work_blockers.target_work_revision != excluded.target_work_revision
                 OR work_blockers.failure_fingerprint != excluded.failure_fingerprint
                 OR work_blockers.open_cycle_id != excluded.open_cycle_id
                 OR work_blockers.latest_request_ref != excluded.latest_request_ref
                 OR work_blockers.failed_action_refs_json != excluded.failed_action_refs_json
              RETURNING ${selectColumns}`,
              [
                blocker.blockerId,
                blocker.projectId,
                blocker.workspaceId,
                blocker.workId,
                blocker.targetWorkRevision,
                blocker.failureFingerprint,
                blocker.openCycleId,
                blocker.latestRequestRef,
                JSON.stringify(blocker.failedActionRefs),
                blocker.revision,
              ],
            ),
          );
          const updated = rows[0];
          if (updated !== undefined) return decode(updated);
          {
            const existing = yield* run(
              sql.unsafe<WorkBlockerRow>(
                `SELECT ${selectColumns} FROM work_blockers WHERE blocker_id = ?`,
                [blocker.blockerId],
              ),
            );
            const prior = existing[0];
            if (
              prior !== undefined &&
              sameOpenContent(decode(prior), blocker)
            ) {
              return decode(prior);
            }
            return yield* Effect.fail({
              _tag: "WorkBlockerStoreRevisionConflict" as const,
            });
          }
        }),
      resolve: (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          if (input.successfulActionRefs.length === 0) {
            return yield* Effect.die(
              new Error(
                "WorkBlocker resolution requires successful action refs",
              ),
            );
          }
          const rows = yield* run(
            sql.unsafe<{ state: string }>(
              "UPDATE work_blockers SET state = 'Resolved', revision = revision + 1 WHERE blocker_id = ? AND work_id = ? AND target_work_revision = ? AND state = 'Open' RETURNING state",
              [input.blockerId, input.workId, input.targetWorkRevision],
            ),
          );
          if (rows.length > 0) return;
          const prior = yield* run(
            sql.unsafe<{
              work_id: string;
              target_work_revision: number;
              state: string;
            }>(
              "SELECT work_id, target_work_revision, state FROM work_blockers WHERE blocker_id = ?",
              [input.blockerId],
            ),
          );
          const row = prior[0];
          if (
            row?.state === "Resolved" &&
            row.work_id === input.workId &&
            row.target_work_revision === input.targetWorkRevision
          ) {
            return;
          }
          return yield* Effect.fail({
            _tag: "WorkBlockerStoreRevisionConflict" as const,
          });
        }),
      supersede: (workId, targetWorkRevision) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              "UPDATE work_blockers SET state = 'Superseded', revision = revision + 1 WHERE work_id = ? AND target_work_revision = ? AND state = 'Open'",
              [workId, targetWorkRevision],
            ),
          );
        }),
    });
  }),
);
