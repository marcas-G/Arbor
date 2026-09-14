CREATE TABLE agents (
  agent_id   TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(project_id),
  created_at TEXT NOT NULL
);

CREATE TABLE agent_runs (
  run_id        TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(agent_id),
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  finish_reason TEXT,
  last_sequence INTEGER NOT NULL DEFAULT 0
);
