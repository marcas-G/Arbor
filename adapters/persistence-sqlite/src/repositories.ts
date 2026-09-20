import type {
  ContextEpochNumber,
  ExecutionId,
  Project,
  ProjectId,
  ProjectPolicy,
  Provenance,
  ResourceBoundary,
  ResourceBoundaryRevision,
  ResponsibilityBoundAgentBinding,
  ResponsibilityDefinition,
  ResponsibilityRevision,
  Revision,
  Session,
  SessionId,
  VerificationMission,
  Work,
  WorkId,
  WorkRevision,
  Workspace,
  WorkspaceId,
  WorkspacePolicy,
} from "@arbor/domain";
import {
  Clock,
  type LeaseFencingRejected,
  ProjectRepository,
  type ProjectRepositoryError,
  type SessionEntryKind,
  SessionRepository,
  type SessionRepositoryError,
  TransactionScope,
  WorkRepository,
  type WorkRepositoryError,
  WorkspaceRepository,
  type WorkspaceRepositoryError,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

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
    const failure = (cause: unknown): ProjectRepositoryError => ({
      _tag: "ProjectRepositoryFailure",
      cause,
    });
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
    const failure = (cause: unknown): WorkRepositoryError => ({
      _tag: "WorkRepositoryFailure",
      cause,
    });
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

// --- Session ----------------------------------------------------------------

interface SessionRow {
  readonly session_id: string;
  readonly binding_kind: "WorkspacePrimary" | "ExecutionScoped";
  readonly workspace_id: string | null;
  readonly execution_id: string | null;
  readonly context_epoch: number;
}

const toSession = (row: SessionRow): Session => ({
  sessionId: row.session_id as SessionId,
  binding:
    row.binding_kind === "WorkspacePrimary"
      ? {
          _tag: "WorkspacePrimary",
          workspaceId: row.workspace_id as WorkspaceId,
        }
      : {
          _tag: "ExecutionScoped",
          executionId: row.execution_id as ExecutionId,
        },
  contextEpoch: Number(row.context_epoch) as ContextEpochNumber,
  entries: [],
  checkpoints: [],
  providerContinuation: { state: null },
  modelContinuation: null,
});

export const SessionRepositoryLive: Layer.Layer<
  SessionRepository,
  never,
  SqlClient | Clock
> = Layer.effect(
  SessionRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const clock = yield* Clock;
    const failure = (cause: unknown): SessionRepositoryError => ({
      _tag: "SessionRepositoryFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    return SessionRepository.of({
      findById: (sessionId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<SessionRow>(
              "SELECT * FROM sessions WHERE session_id = ?",
              [sessionId],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some(toSession(row));
        }),
      create: (session) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          yield* run(
            sql.unsafe(
              "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,?,?,?)",
              [
                session.sessionId,
                session.binding._tag,
                session.binding._tag === "WorkspacePrimary"
                  ? session.binding.workspaceId
                  : null,
                session.binding._tag === "ExecutionScoped"
                  ? session.binding.executionId
                  : null,
                session.contextEpoch,
                now,
              ],
            ),
          );
        }),
      appendEntry: (sessionId, entry, fence) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          if (fence !== undefined) {
            const fenceNow = yield* clock.now();
            const fenceRows = yield* run(
              sql.unsafe<{ ok: number }>(
                "SELECT 1 AS ok FROM executions e JOIN execution_leases l ON l.execution_id = e.execution_id WHERE e.execution_id = ? AND l.generation = ? AND l.expires_at > ? AND e.settled_at IS NULL",
                [fence.executionId, fence.fencingGeneration, fenceNow],
              ),
            );
            if (fenceRows.length === 0) {
              return yield* Effect.fail<LeaseFencingRejected>({
                _tag: "LeaseFencingRejected",
                executionId: fence.executionId,
                generation: fence.fencingGeneration,
              });
            }
          }
          const now = yield* clock.now();
          const rows = yield* run(
            sql.unsafe<{ sequence: number }>(
              "INSERT INTO session_entries (session_id, sequence, entry_kind, payload_json, created_at) VALUES (?, COALESCE((SELECT MAX(sequence) + 1 FROM session_entries WHERE session_id = ?), 0), ?, ?, ?) RETURNING sequence",
              [
                sessionId,
                sessionId,
                entry.entryKind satisfies SessionEntryKind,
                JSON.stringify(entry.payload),
                now,
              ],
            ),
          );
          return { sequence: Number(rows[0]?.sequence ?? 0) };
        }),
    });
  }),
);
