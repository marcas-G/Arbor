import type { MigrationFile } from "./migrate.js";

const DDL = `
CREATE TABLE projects (
  project_id              TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  root_workspace_id       TEXT NOT NULL,
  project_policy          TEXT NOT NULL,
  project_policy_revision INTEGER NOT NULL,
  default_configuration   TEXT NOT NULL,
  environment_ref         TEXT NOT NULL,
  lifecycle               TEXT NOT NULL CHECK (lifecycle IN ('Open','Closed')),
  revision                INTEGER NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  FOREIGN KEY (root_workspace_id, project_id)
    REFERENCES workspaces(workspace_id, project_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE workspaces (
  workspace_id                TEXT PRIMARY KEY,
  project_id                  TEXT NOT NULL REFERENCES projects(project_id),
  parent_workspace_id         TEXT,
  name                        TEXT NOT NULL,
  responsibility_definition   TEXT NOT NULL,
  responsibility_revision     INTEGER NOT NULL,
  resource_boundary           TEXT NOT NULL,
  resource_boundary_revision  INTEGER NOT NULL,
  agent_binding               TEXT NOT NULL,
  primary_session_id          TEXT NOT NULL
                                REFERENCES sessions(session_id) DEFERRABLE INITIALLY DEFERRED,
  current_work_id             TEXT
                                REFERENCES works(work_id) DEFERRABLE INITIALLY DEFERRED,
  workspace_policy            TEXT NOT NULL,
  workspace_policy_revision   INTEGER NOT NULL,
  revision                    INTEGER NOT NULL,
  lifecycle                   TEXT NOT NULL CHECK (lifecycle IN ('Active','Retired')),
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL,
  UNIQUE (workspace_id, project_id),
  FOREIGN KEY (parent_workspace_id, project_id)
    REFERENCES workspaces(workspace_id, project_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE sessions (
  session_id     TEXT PRIMARY KEY,
  binding_kind   TEXT NOT NULL CHECK (binding_kind IN ('WorkspacePrimary','ExecutionScoped')),
  workspace_id   TEXT REFERENCES workspaces(workspace_id) DEFERRABLE INITIALLY DEFERRED,
  execution_id   TEXT,
  context_epoch  INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  CHECK ((binding_kind = 'WorkspacePrimary') = (workspace_id IS NOT NULL)),
  CHECK ((binding_kind = 'ExecutionScoped') = (execution_id IS NOT NULL))
);

CREATE INDEX idx_workspaces_project ON workspaces(project_id);

CREATE TABLE works (
  work_id                TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects(project_id),
  workspace_id           TEXT NOT NULL REFERENCES workspaces(workspace_id),
  objective              TEXT NOT NULL,
  why                    TEXT NOT NULL,
  constraints            TEXT NOT NULL,
  completion_expectation TEXT NOT NULL,
  verification_mission   TEXT NOT NULL,
  provenance             TEXT NOT NULL,
  lifecycle              TEXT NOT NULL CHECK (lifecycle IN ('Open','Completed','Cancelled')),
  revision               INTEGER NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE INDEX idx_works_workspace_lifecycle ON works(workspace_id, lifecycle);

CREATE TABLE resource_ownership (
  claim_id                         TEXT PRIMARY KEY,
  workspace_id                     TEXT NOT NULL REFERENCES workspaces(workspace_id),
  resource_space_id                TEXT NOT NULL,
  canonical_region                 TEXT NOT NULL,
  source_address_snapshot          TEXT NOT NULL,
  resource_boundary_revision       INTEGER NOT NULL,
  resolved_at_environment_revision TEXT NOT NULL,
  created_at                       TEXT NOT NULL,
  released_at                      TEXT,
  CHECK (released_at IS NULL OR released_at >= created_at)
);

CREATE INDEX idx_resource_ownership_active
  ON resource_ownership(resource_space_id) WHERE released_at IS NULL;
CREATE INDEX idx_resource_ownership_ws_active
  ON resource_ownership(workspace_id) WHERE released_at IS NULL;

CREATE TABLE environment_revisions (
  project_id  TEXT PRIMARY KEY REFERENCES projects(project_id),
  revision    TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE commands (
  command_id                    TEXT PRIMARY KEY,
  project_id                    TEXT NOT NULL,
  semantic_request_fingerprint  TEXT NOT NULL,
  schema_version                TEXT NOT NULL,
  fingerprint_algorithm_version INTEGER NOT NULL,
  resolution                    TEXT NOT NULL CHECK (resolution IN ('Committed','TerminalRejected')),
  result_json                   TEXT,
  terminal_error_json           TEXT,
  created_at                    TEXT NOT NULL,
  settled_at                    TEXT NOT NULL,
  CHECK ((resolution = 'Committed') = (result_json IS NOT NULL)),
  CHECK ((resolution = 'TerminalRejected') = (terminal_error_json IS NOT NULL))
);

CREATE TABLE command_attempts (
  command_id    TEXT NOT NULL,
  attempt_no    INTEGER NOT NULL,
  started_at    TEXT NOT NULL,
  settled_at    TEXT,
  outcome       TEXT NOT NULL CHECK (outcome IN ('Committed','TerminalRejected','RetryableOperationalFailure')),
  failure_kind  TEXT,
  metadata_json TEXT,
  PRIMARY KEY (command_id, attempt_no)
);

CREATE TABLE domain_events (
  event_id             TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL,
  sequence             INTEGER NOT NULL,
  event_type           TEXT NOT NULL,
  event_version        INTEGER NOT NULL,
  occurred_at          TEXT NOT NULL,
  aggregate_ref        TEXT NOT NULL,
  actor                TEXT NOT NULL,
  caused_by_command_id TEXT,
  caused_by_event_id   TEXT,
  correlation_ref      TEXT,
  payload_json         TEXT NOT NULL,
  UNIQUE (project_id, sequence)
);

CREATE TABLE project_event_sequences (
  project_id     TEXT PRIMARY KEY,
  last_sequence  INTEGER NOT NULL
);

CREATE TABLE consumer_offsets (
  consumer_id   TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  last_sequence INTEGER NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (consumer_id, project_id)
);

CREATE TABLE consumer_dead_letters (
  consumer_id  TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  sequence     INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (consumer_id, project_id, sequence)
);
`;

export const P1_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  { id: 1, name: "init", sql: DDL },
];

const P2_DDL = `
CREATE TABLE executions (
  execution_id        TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(project_id),
  binding_kind        TEXT NOT NULL CHECK (binding_kind IN ('workspace','execution_bound')),
  workspace_id        TEXT NOT NULL REFERENCES workspaces(workspace_id),
  focus_kind          TEXT CHECK (focus_kind IN ('work','coordination')),
  focus_work_id       TEXT REFERENCES works(work_id),
  parent_execution_id TEXT REFERENCES executions(execution_id),
  mission             TEXT,
  session_id          TEXT NOT NULL REFERENCES sessions(session_id),
  admitted_at         TEXT NOT NULL,
  stop_requested_at   TEXT,
  settlement_kind     TEXT CHECK (settlement_kind IN
                        ('Completed','Interrupted','Failed','OutcomeUnknown')),
  settlement_json     TEXT,
  settled_at          TEXT,
  CHECK ((binding_kind = 'workspace') = (focus_kind IS NOT NULL)),
  CHECK ((focus_kind = 'work') = (focus_work_id IS NOT NULL)),
  CHECK (binding_kind = 'execution_bound' OR parent_execution_id IS NULL),
  CHECK (binding_kind = 'execution_bound' OR mission IS NULL),
  CHECK ((settlement_kind IS NULL) = (settled_at IS NULL)),
  CHECK ((settlement_kind IS NULL) = (settlement_json IS NULL))
);

CREATE UNIQUE INDEX idx_executions_active_main
  ON executions(workspace_id)
  WHERE binding_kind = 'workspace' AND settled_at IS NULL;

CREATE INDEX idx_executions_project ON executions(project_id);
CREATE INDEX idx_executions_unsettled ON executions(settled_at) WHERE settled_at IS NULL;

CREATE TABLE execution_leases (
  execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
  worker_id    TEXT NOT NULL,
  generation   INTEGER NOT NULL,
  expires_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_execution_leases_expiry ON execution_leases(expires_at);

CREATE TABLE agent_execution_state (
  execution_id                    TEXT PRIMARY KEY REFERENCES executions(execution_id),
  focus_json                      TEXT NOT NULL,
  wake_reason                     TEXT NOT NULL,
  current_mode                    TEXT,
  active_skill_refs_json          TEXT NOT NULL,
  turn_no                         INTEGER NOT NULL,
  recent_directive_refs_json      TEXT NOT NULL,
  recent_action_fingerprints_json TEXT NOT NULL,
  updated_at                      TEXT NOT NULL
);

CREATE TABLE session_entries (
  session_id   TEXT NOT NULL REFERENCES sessions(session_id),
  sequence     INTEGER NOT NULL,
  entry_kind   TEXT NOT NULL CHECK (entry_kind IN
                 ('Input','ModelOutput','Observation','CheckpointReference','ContextUpdate')),
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (session_id, sequence)
);

CREATE TABLE work_waits (
  work_id         TEXT PRIMARY KEY REFERENCES works(work_id),
  wait_mode       TEXT NOT NULL CHECK (wait_mode = 'Any'),
  conditions_json TEXT NOT NULL,
  registered_at   TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE scheduler_timers (
  timer_id     TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  work_id      TEXT REFERENCES works(work_id),
  kind         TEXT NOT NULL CHECK (kind = 'TimeReached'),
  fire_at      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_scheduler_timers_due ON scheduler_timers(fire_at);
`;

export const P2_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  { id: 1, name: "init", sql: DDL },
  { id: 2, name: "execution_session_kernel", sql: P2_DDL },
];

const P3_DDL = `
CREATE TABLE provider_turns (
  provider_turn_id    TEXT PRIMARY KEY,
  execution_id        TEXT NOT NULL REFERENCES executions(execution_id),
  session_id          TEXT NOT NULL REFERENCES sessions(session_id),
  context_epoch       INTEGER NOT NULL,
  model_ref           TEXT NOT NULL,
  output_contract_ref TEXT NOT NULL,
  manifest_id         TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  settled_at          TEXT,
  finish_reason       TEXT,
  usage_json          TEXT,
  created_at          TEXT NOT NULL,
  CHECK ((settled_at IS NULL) = (finish_reason IS NULL))
);

CREATE INDEX idx_provider_turns_execution ON provider_turns(execution_id);

CREATE TABLE provider_attempts (
  provider_turn_id        TEXT NOT NULL REFERENCES provider_turns(provider_turn_id),
  attempt_no              INTEGER NOT NULL,
  started_at              TEXT NOT NULL,
  settled_at              TEXT,
  outcome                 TEXT NOT NULL CHECK (outcome IN ('Success','RetryableFailure','TerminalFailure')),
  provider_error_kind     TEXT,
  transport_metadata_json TEXT,
  PRIMARY KEY (provider_turn_id, attempt_no)
);

CREATE TABLE model_context_manifests (
  manifest_id           TEXT PRIMARY KEY,
  provider_turn_id      TEXT NOT NULL REFERENCES provider_turns(provider_turn_id),
  execution_id          TEXT NOT NULL,
  session_id            TEXT NOT NULL,
  context_epoch         INTEGER NOT NULL,
  model_ref             TEXT NOT NULL,
  compiled_request_hash TEXT NOT NULL,
  manifest_json         TEXT NOT NULL,
  created_at            TEXT NOT NULL
);
`;

export const P3_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  { id: 1, name: "init", sql: DDL },
  { id: 2, name: "execution_session_kernel", sql: P2_DDL },
  { id: 3, name: "provider_model_context", sql: P3_DDL },
];
