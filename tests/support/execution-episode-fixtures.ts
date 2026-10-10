import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  type ExecutionEpisodeBinding,
  type ExecutionSettlement,
  type ProjectId,
  parse,
  type WorkId,
  WorkRevision,
  type WorkspaceId,
} from "../../packages/domain/dist/index.js";

export const workEpisode = (workId: WorkId): ExecutionEpisodeBinding => ({
  _tag: "WorkEpisode",
  workId,
  targetWorkRevision: parse(WorkRevision)(0),
});

export const yieldedSettlement: ExecutionSettlement = {
  _tag: "Completed",
  result: {
    _tag: "Yielded",
    reason: "test execution yielded",
    waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
  },
};

export const seedCurrentOpenWork = (
  projectId: ProjectId,
  workspaceId: WorkspaceId,
  workId: WorkId,
): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const existing = yield* sql.unsafe<{ work_id: string }>(
      "SELECT work_id FROM works WHERE work_id = ?",
      [workId],
    );
    if (existing.length > 0) {
      yield* sql.unsafe(
        "UPDATE workspaces SET current_work_id = ? WHERE workspace_id = ?",
        [workId, workspaceId],
      );
      return;
    }
    yield* sql.unsafe(
      "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        workId,
        projectId,
        workspaceId,
        "fixture work episode",
        "test fixture",
        "[]",
        "complete the fixture work",
        JSON.stringify({ objective: "verify fixture behavior" }),
        JSON.stringify({ predecessorWorkId: null, reason: "test fixture" }),
        "Open",
        0,
        "t",
        "t",
      ],
    );
    yield* sql.unsafe(
      "UPDATE workspaces SET current_work_id = ? WHERE workspace_id = ?",
      [workId, workspaceId],
    );
  });
