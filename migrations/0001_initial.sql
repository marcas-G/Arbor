CREATE TABLE projects (
  project_id       TEXT PRIMARY KEY,
  source_repo_path TEXT NOT NULL,
  runtime_dir      TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE TABLE workspaces (
  workspace_id   TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(project_id),
  store_rel_path TEXT NOT NULL,
  kind           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (project_id, kind)
);

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
