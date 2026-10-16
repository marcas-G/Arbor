/**
 * Accepted Blocked WorkEpisode storage extension.
 *
 * The raw descriptor keeps its migrationVersion form for P43-owned modules.
 * The current ordered registry adapts it to MigrationFile after P43/P44
 * activation authorization.
 */
export const P43_BLOCKED_WORKEPISODE_MIGRATION = {
  migrationVersion: 43,
  requiresUserVersion: 42,
  foreignKeysOff: false,
  sql: `
CREATE TABLE work_blockers (
  blocker_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  work_id TEXT NOT NULL REFERENCES works(work_id),
  target_work_revision INTEGER NOT NULL CHECK (target_work_revision >= 0),
  failure_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('Open','Resolved','Superseded')),
  open_cycle_id TEXT NOT NULL REFERENCES executions(execution_id),
  latest_request_ref TEXT NOT NULL,
  failed_action_refs_json TEXT NOT NULL
    CHECK (json_valid(failed_action_refs_json) AND
           json_type(failed_action_refs_json) = 'array' AND
           json_array_length(failed_action_refs_json) > 0),
  revision INTEGER NOT NULL CHECK (revision >= 0)
);

CREATE INDEX idx_work_blockers_work_revision
  ON work_blockers(work_id, target_work_revision, state);

CREATE TABLE inbox_workspace_sequences (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(workspace_id),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
);
`,
} as const;
