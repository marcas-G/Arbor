import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

/** Seeds the smallest durable project/workspace/session graph shared by repository tests. */
export const seedWorkspaceGraph = (input: {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
}): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe(
          "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          [input.projectId, "p", input.workspaceId, "{}", 0, "{}", "local", "Open", 0, "t", "t"],
        );
        yield* sql.unsafe(
          "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,NULL,?,?)",
          [input.sessionId, "WorkspacePrimary", input.workspaceId, 0, "t"],
        );
        yield* sql.unsafe(
          "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)",
          [input.workspaceId, input.projectId, "w", "{}", 0, "{}", 0, "{}", input.sessionId, "{}", 0, 0, "Active", "t", "t"],
        );
      }),
    );
  });
