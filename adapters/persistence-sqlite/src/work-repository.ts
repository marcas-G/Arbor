import type {
  ProjectId,
  Provenance,
  VerificationMission,
  Work,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  TransactionScope,
  WorkRepository,
  type WorkRepositoryError,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

const json = (value: unknown): string => JSON.stringify(value);

// --- Work -------------------------------------------------------------------

interface WorkRow {
  readonly work_id: string;
  readonly project_id: string;
  readonly workspace_id: string;
  readonly objective: string;
  readonly why: string;
  readonly constraints: string;
  readonly completion_expectation: string;
  readonly verification_mission: string;
  readonly provenance: string;
  readonly lifecycle: "Open" | "Completed" | "Cancelled";
  readonly revision: number;
}

const toWork = (row: WorkRow): Work => ({
  workId: row.work_id as WorkId,
  projectId: row.project_id as ProjectId,
  workspaceId: row.workspace_id as WorkspaceId,
  objective: row.objective,
  why: row.why,
  constraints: JSON.parse(row.constraints) as ReadonlyArray<string>,
  completionExpectation: row.completion_expectation,
  verificationMission: JSON.parse(
    row.verification_mission,
  ) as VerificationMission,
  provenance: JSON.parse(row.provenance) as Provenance,
  lifecycle: row.lifecycle,
  revision: Number(row.revision) as WorkRevision,
});

export const WorkRepositoryLive: Layer.Layer<
  WorkRepository,
  never,
  SqlClient | Clock
> = Layer.effect(
  WorkRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const clock = yield* Clock;
    const failure = repositoryFailure("WorkRepository", "sql");
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    const conflict: WorkRepositoryError = {
      _tag: "WorkRepositoryRevisionConflict",
    };
    const cas = (
      statement: string,
      params: (now: string) => ReadonlyArray<unknown>,
    ): Effect.Effect<void, WorkRepositoryError, TransactionScope> =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const now = yield* clock.now();
        const rows = yield* run(
          sql.unsafe<{ work_id: string }>(
            `${statement} RETURNING work_id`,
            params(now),
          ),
        );
        if (rows.length === 0) {
          return yield* Effect.fail(conflict);
        }
      });
    return WorkRepository.of({
      findById: (workId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<WorkRow>("SELECT * FROM works WHERE work_id = ?", [
              workId,
            ]),
          );
          const row = rows[0];
          return row === undefined ? Option.none() : Option.some(toWork(row));
        }),
      create: (work) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          yield* run(
            sql.unsafe(
              "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
              [
                work.workId,
                work.projectId,
                work.workspaceId,
                work.objective,
                work.why,
                json(work.constraints),
                work.completionExpectation,
                json(work.verificationMission),
                json(work.provenance),
                work.lifecycle,
                work.revision,
                now,
                now,
              ],
            ),
          );
        }),
      refineIfRevision: (workId, expectedRevision, fields, newRevision) =>
        cas(
          "UPDATE works SET objective = ?, completion_expectation = ?, verification_mission = ?, revision = ?, updated_at = ? WHERE work_id = ? AND revision = ?",
          (now) => [
            fields.objective,
            fields.completionExpectation,
            json(fields.verificationMission),
            newRevision,
            now,
            workId,
            expectedRevision,
          ],
        ),
      completeIfRevision: (workId, expectedRevision) =>
        cas(
          "UPDATE works SET lifecycle = 'Completed', updated_at = ? WHERE work_id = ? AND revision = ?",
          (now) => [now, workId, expectedRevision],
        ),
      cancelIfRevision: (workId, expectedRevision) =>
        cas(
          "UPDATE works SET lifecycle = 'Cancelled', updated_at = ? WHERE work_id = ? AND revision = ?",
          (now) => [now, workId, expectedRevision],
        ),
      listByWorkspace: (workspaceId, lifecycle) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows =
            lifecycle === undefined
              ? yield* run(
                  sql.unsafe<WorkRow>(
                    "SELECT * FROM works WHERE workspace_id = ?",
                    [workspaceId],
                  ),
                )
              : yield* run(
                  sql.unsafe<WorkRow>(
                    "SELECT * FROM works WHERE workspace_id = ? AND lifecycle = ?",
                    [workspaceId, lifecycle],
                  ),
                );
          return rows.map(toWork);
        }),
    });
  }),
);
