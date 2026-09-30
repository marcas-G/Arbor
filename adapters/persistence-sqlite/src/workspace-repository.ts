import type {
  ProjectId,
  ResourceBoundary,
  ResourceBoundaryRevision,
  ResponsibilityBoundAgentBinding,
  ResponsibilityDefinition,
  ResponsibilityRevision,
  Revision,
  SessionId,
  WorkId,
  Workspace,
  WorkspaceId,
  WorkspacePolicy,
} from "@arbor/domain";
import {
  Clock,
  TransactionScope,
  WorkspaceRepository,
  type WorkspaceRepositoryError,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

const json = (value: unknown): string => JSON.stringify(value);

// --- Workspace --------------------------------------------------------------

interface WorkspaceRow {
  readonly workspace_id: string;
  readonly project_id: string;
  readonly parent_workspace_id: string | null;
  readonly name: string;
  readonly responsibility_definition: string;
  readonly responsibility_revision: number;
  readonly resource_boundary: string;
  readonly resource_boundary_revision: number;
  readonly agent_binding: string;
  readonly primary_session_id: string;
  readonly current_work_id: string | null;
  readonly workspace_policy: string;
  readonly workspace_policy_revision: number;
  readonly revision: number;
  readonly lifecycle: "Active" | "Retired";
}

const toWorkspace = (row: WorkspaceRow): Workspace => ({
  workspaceId: row.workspace_id as WorkspaceId,
  projectId: row.project_id as ProjectId,
  parentWorkspaceId:
    row.parent_workspace_id === null
      ? null
      : (row.parent_workspace_id as WorkspaceId),
  name: row.name,
  responsibilityDefinition: JSON.parse(
    row.responsibility_definition,
  ) as ResponsibilityDefinition,
  responsibilityRevision: Number(
    row.responsibility_revision,
  ) as ResponsibilityRevision,
  resourceBoundary: JSON.parse(row.resource_boundary) as ResourceBoundary,
  resourceBoundaryRevision: Number(
    row.resource_boundary_revision,
  ) as ResourceBoundaryRevision,
  agentBinding: JSON.parse(
    row.agent_binding,
  ) as ResponsibilityBoundAgentBinding,
  primarySessionId: row.primary_session_id as SessionId,
  currentWorkId:
    row.current_work_id === null ? null : (row.current_work_id as WorkId),
  workspacePolicy: JSON.parse(row.workspace_policy) as WorkspacePolicy,
  workspacePolicyRevision: Number(row.workspace_policy_revision) as Revision,
  revision: Number(row.revision) as Revision,
  lifecycle: row.lifecycle,
});

export const WorkspaceRepositoryLive: Layer.Layer<
  WorkspaceRepository,
  never,
  SqlClient | Clock
> = Layer.effect(
  WorkspaceRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const clock = yield* Clock;
    const failure = (cause: unknown): WorkspaceRepositoryError => ({
      _tag: "WorkspaceRepositoryFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    const conflict: WorkspaceRepositoryError = {
      _tag: "WorkspaceRepositoryRevisionConflict",
    };
    const cas = (
      statement: string,
      params: (now: string) => ReadonlyArray<unknown>,
    ): Effect.Effect<void, WorkspaceRepositoryError, TransactionScope> =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const now = yield* clock.now();
        const rows = yield* run(
          sql.unsafe<{ workspace_id: string }>(
            `${statement} RETURNING workspace_id`,
            params(now),
          ),
        );
        if (rows.length === 0) {
          return yield* Effect.fail(conflict);
        }
      });
    return WorkspaceRepository.of({
      findById: (workspaceId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<WorkspaceRow>(
              "SELECT * FROM workspaces WHERE workspace_id = ?",
              [workspaceId],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some(toWorkspace(row));
        }),
      create: (workspace) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          yield* run(
            sql.unsafe(
              "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              [
                workspace.workspaceId,
                workspace.projectId,
                workspace.parentWorkspaceId,
                workspace.name,
                json(workspace.responsibilityDefinition),
                workspace.responsibilityRevision,
                json(workspace.resourceBoundary),
                workspace.resourceBoundaryRevision,
                json(workspace.agentBinding),
                workspace.primarySessionId,
                workspace.currentWorkId,
                json(workspace.workspacePolicy),
                workspace.workspacePolicyRevision,
                workspace.revision,
                workspace.lifecycle,
                now,
                now,
              ],
            ),
          );
        }),
      changeResponsibilityIfRevision: (
        workspaceId,
        expectedRevision,
        definition,
        newResponsibilityRevision,
        newRevision,
      ) =>
        cas(
          "UPDATE workspaces SET responsibility_definition = ?, responsibility_revision = ?, revision = ?, updated_at = ? WHERE workspace_id = ? AND revision = ?",
          (now) => [
            json(definition),
            newResponsibilityRevision,
            newRevision,
            now,
            workspaceId,
            expectedRevision,
          ],
        ),
      updateResourceBoundaryIfRevision: (
        workspaceId,
        expectedRevision,
        boundary,
        newBoundaryRevision,
        newRevision,
      ) =>
        cas(
          "UPDATE workspaces SET resource_boundary = ?, resource_boundary_revision = ?, revision = ?, updated_at = ? WHERE workspace_id = ? AND revision = ?",
          (now) => [
            json(boundary),
            newBoundaryRevision,
            newRevision,
            now,
            workspaceId,
            expectedRevision,
          ],
        ),
      updatePolicyIfRevision: (
        workspaceId,
        expectedRevision,
        policy,
        newPolicyRevision,
        newRevision,
      ) =>
        cas(
          "UPDATE workspaces SET workspace_policy = ?, workspace_policy_revision = ?, revision = ?, updated_at = ? WHERE workspace_id = ? AND revision = ?",
          (now) => [
            json(policy),
            newPolicyRevision,
            newRevision,
            now,
            workspaceId,
            expectedRevision,
          ],
        ),
      selectCurrentWorkIfRevision: (
        workspaceId,
        expectedRevision,
        workId,
        newRevision,
      ) =>
        cas(
          "UPDATE workspaces SET current_work_id = ?, revision = ?, updated_at = ? WHERE workspace_id = ? AND revision = ?",
          (now) => [workId, newRevision, now, workspaceId, expectedRevision],
        ),
      clearCurrentWorkIfRevision: (
        workspaceId,
        expectedRevision,
        newRevision,
      ) =>
        cas(
          "UPDATE workspaces SET current_work_id = NULL, revision = ?, updated_at = ? WHERE workspace_id = ? AND revision = ?",
          (now) => [newRevision, now, workspaceId, expectedRevision],
        ),
      replacePrimarySessionIfRevision: (
        workspaceId,
        expectedRevision,
        sessionId,
        newRevision,
      ) =>
        cas(
          "UPDATE workspaces SET primary_session_id = ?, revision = ?, updated_at = ? WHERE workspace_id = ? AND revision = ?",
          (now) => [sessionId, newRevision, now, workspaceId, expectedRevision],
        ),
      retireIfRevision: (workspaceId, expectedRevision, newRevision) =>
        cas(
          "UPDATE workspaces SET lifecycle = 'Retired', revision = ?, updated_at = ? WHERE workspace_id = ? AND revision = ?",
          (now) => [newRevision, now, workspaceId, expectedRevision],
        ),
      countActiveChildren: (workspaceId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ count: number }>(
              "SELECT COUNT(*) AS count FROM workspaces WHERE parent_workspace_id = ? AND lifecycle = 'Active'",
              [workspaceId],
            ),
          );
          return Number(rows[0]?.count ?? 0);
        }),
      hasOpenWork: (workspaceId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{ count: number }>(
              "SELECT COUNT(*) AS count FROM works WHERE workspace_id = ? AND lifecycle = 'Open'",
              [workspaceId],
            ),
          );
          return Number(rows[0]?.count ?? 0) > 0;
        }),
    });
  }),
);
