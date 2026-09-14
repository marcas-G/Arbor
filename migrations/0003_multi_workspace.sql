-- P2 (D-041 G6): relax the single-root uniqueness so multiple child
-- workspaces can exist, and bind agents to workspaces.
CREATE TABLE workspaces_new (
  workspace_id   TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(project_id),
  store_rel_path TEXT NOT NULL,
  kind           TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
INSERT INTO workspaces_new SELECT workspace_id, project_id, store_rel_path, kind, created_at FROM workspaces;
DROP TABLE workspaces;
ALTER TABLE workspaces_new RENAME TO workspaces;
CREATE UNIQUE INDEX workspaces_one_root_per_project ON workspaces(project_id) WHERE kind = 'root';

CREATE TABLE agents_new (
  agent_id    TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(project_id),
  workspace_id TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
INSERT INTO agents_new SELECT agent_id, project_id, '', created_at FROM agents;
DROP TABLE agents;
ALTER TABLE agents_new RENAME TO agents;
CREATE UNIQUE INDEX agents_one_per_workspace ON agents(project_id, workspace_id);
