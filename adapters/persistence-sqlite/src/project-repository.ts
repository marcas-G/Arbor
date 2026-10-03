import type {
  Project,
  ProjectId,
  ProjectPolicy,
  Revision,
  WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  ProjectRepository,
  type ProjectRepositoryError,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { repositoryFailure } from "./repository-error.js";

const json = (value: unknown): string => JSON.stringify(value);

// --- Project ----------------------------------------------------------------

interface ProjectRow {
  readonly project_id: string;
  readonly name: string;
  readonly root_workspace_id: string;
  readonly project_policy: string;
  readonly project_policy_revision: number;
  readonly default_configuration: string;
  readonly environment_ref: string;
  readonly lifecycle: "Open" | "Closed";
  readonly revision: number;
}

const toProject = (row: ProjectRow): Project => ({
  projectId: row.project_id as ProjectId,
  name: row.name,
  rootWorkspaceId: row.root_workspace_id as WorkspaceId,
  projectPolicy: JSON.parse(row.project_policy) as ProjectPolicy,
  projectPolicyRevision: Number(row.project_policy_revision) as Revision,
  defaultConfiguration: JSON.parse(row.default_configuration) as Record<
    string,
    unknown
  >,
  environmentRef: row.environment_ref,
  lifecycle: row.lifecycle,
  revision: Number(row.revision) as Revision,
});

export const ProjectRepositoryLive: Layer.Layer<
  ProjectRepository,
  never,
  SqlClient | Clock
> = Layer.effect(
  ProjectRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const clock = yield* Clock;
    const failure = repositoryFailure("ProjectRepository", "sql");
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    const conflict: ProjectRepositoryError = {
      _tag: "ProjectRepositoryRevisionConflict",
    };
    return ProjectRepository.of({
      findById: (projectId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<ProjectRow>(
              "SELECT * FROM projects WHERE project_id = ?",
              [projectId],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some(toProject(row));
        }),
      create: (project) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          yield* run(
            sql.unsafe(
              "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
              [
                project.projectId,
                project.name,
                project.rootWorkspaceId,
                json(project.projectPolicy),
                project.projectPolicyRevision,
                json(project.defaultConfiguration),
                project.environmentRef,
                project.lifecycle,
                project.revision,
                now,
                now,
              ],
            ),
          );
        }),
      updatePolicyIfRevision: (
        projectId,
        expectedRevision,
        policy,
        newPolicyRevision,
        newRevision,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          const rows = yield* run(
            sql.unsafe<{ project_id: string }>(
              "UPDATE projects SET project_policy = ?, project_policy_revision = ?, revision = ?, updated_at = ? WHERE project_id = ? AND revision = ? RETURNING project_id",
              [
                json(policy),
                newPolicyRevision,
                newRevision,
                now,
                projectId,
                expectedRevision,
              ],
            ),
          );
          if (rows.length === 0) {
            return yield* Effect.fail(conflict);
          }
        }),
      renameIfRevision: (projectId, expectedRevision, name, newRevision) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          const rows = yield* run(
            sql.unsafe<{ project_id: string }>(
              "UPDATE projects SET name = ?, revision = ?, updated_at = ? WHERE project_id = ? AND lifecycle = 'Open' AND revision = ? RETURNING project_id",
              [name, newRevision, now, projectId, expectedRevision],
            ),
          );
          if (rows.length === 0) {
            return yield* Effect.fail(conflict);
          }
        }),
      closeIfRevision: (projectId, expectedRevision, newRevision) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          const rows = yield* run(
            sql.unsafe<{ project_id: string }>(
              "UPDATE projects SET lifecycle = 'Closed', revision = ?, updated_at = ? WHERE project_id = ? AND revision = ? RETURNING project_id",
              [newRevision, now, projectId, expectedRevision],
            ),
          );
          if (rows.length === 0) {
            return yield* Effect.fail(conflict);
          }
        }),
    });
  }),
);
