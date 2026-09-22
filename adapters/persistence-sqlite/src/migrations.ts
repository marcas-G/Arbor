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

const P4_DDL = `
CREATE TABLE tool_invocations (
  invocation_id          TEXT PRIMARY KEY,
  execution_id           TEXT NOT NULL REFERENCES executions(execution_id),
  workspace_id           TEXT NOT NULL REFERENCES workspaces(workspace_id),
  tool_name              TEXT NOT NULL,
  tool_version           TEXT NOT NULL,
  side_effect_semantics  TEXT NOT NULL CHECK (side_effect_semantics IN
                           ('ReadOnly','Idempotent','Reconcilable','NonIdempotent')),
  arguments_json         TEXT NOT NULL,
  resolved_regions_json  TEXT NOT NULL,
  approval_id            TEXT,
  intent_at              TEXT NOT NULL,
  settled_at             TEXT,
  settlement_kind        TEXT CHECK (settlement_kind IN
                           ('Success','ExpectedFailure','Interrupted','OutcomeUnknown','RuntimeFailure')),
  settlement_json        TEXT,
  result_ref             TEXT,
  CHECK ((settled_at IS NULL) = (settlement_kind IS NULL))
);

CREATE INDEX idx_tool_invocations_execution ON tool_invocations(execution_id);
CREATE INDEX idx_tool_invocations_unsettled
  ON tool_invocations(settled_at) WHERE settled_at IS NULL;

CREATE TABLE artifacts (
  artifact_id   TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  blob_ref      TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,
  invocation_id TEXT,
  execution_id  TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE invocation_approvals (
  approval_id                  TEXT PRIMARY KEY,
  tool_name                    TEXT NOT NULL,
  tool_version                 TEXT NOT NULL,
  action_digest                TEXT NOT NULL,
  target_resource_space_ids_json TEXT NOT NULL,
  control_basis_digest         TEXT NOT NULL,
  expires_at                   TEXT NOT NULL,
  consumed_by                  TEXT
);
`;

export const P4_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  { id: 1, name: "init", sql: DDL },
  { id: 2, name: "execution_session_kernel", sql: P2_DDL },
  { id: 3, name: "provider_model_context", sql: P3_DDL },
  { id: 4, name: "tool_runtime", sql: P4_DDL },
];

/** P6 `01` §4.1 (D1), `02` §3/§4 (D2), `01` §3 (D3). The composite primary
 * key on inbox_entries enforces upsert-by-entryKey admission (replay-safe
 * dedup); formation_proposals enforces revision/state monotonicity at L3. */
const P6_DDL = `
CREATE TABLE formation_proposals (
  proposal_id          TEXT PRIMARY KEY,
  parent_workspace_id  TEXT NOT NULL,
  proposal_json        TEXT NOT NULL,
  revision             INTEGER NOT NULL CHECK (revision > 0),
  state                TEXT NOT NULL CHECK (state IN ('Pending','Approved','Rejected')),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE messages (
  message_id             TEXT PRIMARY KEY,
  sender_workspace_id    TEXT NOT NULL,
  recipient_workspace_id TEXT NOT NULL,
  kind                   TEXT NOT NULL CHECK (kind IN ('Query','Reply','Report','DecisionRequest')),
  body_ref               TEXT NOT NULL,
  correlation_id         TEXT,
  causation_id           TEXT,
  sent_at                TEXT NOT NULL
);

CREATE INDEX idx_messages_correlation ON messages(correlation_id);

CREATE TABLE message_correlations (
  correlation_id  TEXT PRIMARY KEY,
  closed_at       TEXT
);

CREATE TABLE inbox_entries (
  workspace_id    TEXT NOT NULL,
  entry_key       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  summary         TEXT NOT NULL,
  correlation_id  TEXT,
  admitted_at     TEXT NOT NULL,
  consumed_at     TEXT,
  PRIMARY KEY (workspace_id, entry_key)
);

CREATE INDEX idx_inbox_unconsumed ON inbox_entries(workspace_id) WHERE consumed_at IS NULL;
`;

export const P6_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  { id: 1, name: "init", sql: DDL },
  { id: 2, name: "execution_session_kernel", sql: P2_DDL },
  { id: 3, name: "provider_model_context", sql: P3_DDL },
  { id: 4, name: "tool_runtime", sql: P4_DDL },
  { id: 5, name: "p6_formation_communication", sql: P6_DDL },
];

/** P7 `01` §10: dependencies (state+revision CAS), deliverables and
 * deliverable_artifacts (immutable — no update path, No.49 binding). */
const P7_DDL = `
CREATE TABLE dependencies (
  dependency_id                TEXT PRIMARY KEY,
  project_id                   TEXT NOT NULL REFERENCES projects(project_id),
  consumer_work_id             TEXT NOT NULL REFERENCES works(work_id),
  producer_binding             TEXT NOT NULL,
  expected_deliverable         TEXT NOT NULL,
  revision                     INTEGER NOT NULL CHECK (revision >= 0),
  state                        TEXT NOT NULL CHECK (state IN ('Unsatisfied','Satisfied','Withdrawn','Unfulfillable')),
  satisfied_by_deliverable_id  TEXT,
  satisfied_at_dependency_revision INTEGER,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL
);

CREATE INDEX idx_dependencies_consumer ON dependencies(consumer_work_id, state);
CREATE INDEX idx_dependencies_state ON dependencies(project_id, state);

CREATE TABLE deliverables (
  deliverable_id       TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(project_id),
  source_work_id       TEXT NOT NULL REFERENCES works(work_id),
  source_work_revision INTEGER NOT NULL,
  kind                 TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE INDEX idx_deliverables_source_work ON deliverables(source_work_id);

CREATE TABLE deliverable_artifacts (
  deliverable_id  TEXT NOT NULL REFERENCES deliverables(deliverable_id),
  role            TEXT NOT NULL,
  artifact_id     TEXT NOT NULL,
  PRIMARY KEY (deliverable_id, role, artifact_id)
);
`;

/** TASK DEVIATION (P7-007, governance-approved): migration id 7 rebuilds the
 * messages table to widen the kind CHECK to the five frozen P7 kinds
 * (Query|Reply|Report|DecisionRequest|Deliver). Inherited persistence
 * evolution from the frozen P7 vocabulary (v1.10 G2) — not a Design Gap.
 * Everything else (columns, constraints, index, data) is preserved. */
const P7_MESSAGES_V7_DDL = `
CREATE TABLE messages_v7 (
  message_id             TEXT PRIMARY KEY,
  sender_workspace_id    TEXT NOT NULL,
  recipient_workspace_id TEXT NOT NULL,
  kind                   TEXT NOT NULL CHECK (kind IN ('Query','Reply','Report','DecisionRequest','Deliver')),
  body_ref               TEXT NOT NULL,
  correlation_id         TEXT,
  causation_id           TEXT,
  sent_at                TEXT NOT NULL
);

INSERT INTO messages_v7 (message_id, sender_workspace_id, recipient_workspace_id, kind, body_ref, correlation_id, causation_id, sent_at)
  SELECT message_id, sender_workspace_id, recipient_workspace_id, kind, body_ref, correlation_id, causation_id, sent_at FROM messages;

DROP TABLE messages;

ALTER TABLE messages_v7 RENAME TO messages;

CREATE INDEX idx_messages_correlation ON messages(correlation_id);
`;

export const P7_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  { id: 1, name: "init", sql: DDL },
  { id: 2, name: "execution_session_kernel", sql: P2_DDL },
  { id: 3, name: "provider_model_context", sql: P3_DDL },
  { id: 4, name: "tool_runtime", sql: P4_DDL },
  { id: 5, name: "p6_formation_communication", sql: P6_DDL },
  { id: 6, name: "p7_dependency_deliverable", sql: P7_DDL },
  { id: 7, name: "p7_messages_deliver_kind", sql: P7_MESSAGES_V7_DDL },
];

/** P8 `01`/`00` M-1..M-4: four verification tables (DID §9.3 names).
 * verifications: one-Open per (work_id, target_work_revision) via partial
 * unique index (v1.11 G2); owner_workspace_id snapshot (v1.11 G4);
 * work_acceptances: double uniqueness (acceptanceId PK + per-revision UNIQUE);
 * evidence: append-only. */
const P8_DDL = `
CREATE TABLE verifications (
  verification_id           TEXT PRIMARY KEY,
  project_id                TEXT NOT NULL REFERENCES projects(project_id),
  work_id                   TEXT NOT NULL REFERENCES works(work_id),
  target_work_revision      INTEGER NOT NULL,
  owner_workspace_id        TEXT NOT NULL,
  mission_snapshot          TEXT NOT NULL,
  target_deliverables       TEXT NOT NULL,
  target_artifact_versions  TEXT NOT NULL,
  target_environment_revision TEXT,
  environment_snapshot_ref  TEXT,
  verification_execution_ids TEXT NOT NULL,
  state                     TEXT NOT NULL CHECK (state IN ('Open','Concluded')),
  verdict                   TEXT CHECK (verdict IS NULL OR verdict IN ('Pass','Fail','Unknown')),
  conclusion_reason         TEXT CHECK (conclusion_reason IS NULL OR conclusion_reason = 'Orphaned'),
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  CHECK ((state = 'Open') = (verdict IS NULL))
);

CREATE UNIQUE INDEX idx_verifications_one_open
  ON verifications(work_id, target_work_revision) WHERE state = 'Open';

CREATE TABLE verification_executions (
  verification_id  TEXT NOT NULL REFERENCES verifications(verification_id),
  execution_id     TEXT NOT NULL REFERENCES executions(execution_id),
  bound_at         TEXT NOT NULL,
  PRIMARY KEY (verification_id, execution_id)
);

CREATE TABLE verification_evidence (
  evidence_id          TEXT PRIMARY KEY,
  verification_id      TEXT NOT NULL REFERENCES verifications(verification_id),
  criterion_id         TEXT NOT NULL,
  kind                 TEXT NOT NULL,
  artifact_ref         TEXT,
  observed_environment_revision TEXT,
  recorded_by_execution_id TEXT NOT NULL,
  recorded_at          TEXT NOT NULL
);

CREATE INDEX idx_evidence_verification ON verification_evidence(verification_id);

CREATE TABLE work_acceptances (
  acceptance_id         TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(project_id),
  work_id               TEXT NOT NULL REFERENCES works(work_id),
  target_work_revision  INTEGER NOT NULL,
  verification_id       TEXT NOT NULL,
  actor                 TEXT NOT NULL,
  accepted_at           TEXT NOT NULL,
  UNIQUE (work_id, target_work_revision)
);
`;

export const P8_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  { id: 1, name: "init", sql: DDL },
  { id: 2, name: "execution_session_kernel", sql: P2_DDL },
  { id: 3, name: "provider_model_context", sql: P3_DDL },
  { id: 4, name: "tool_runtime", sql: P4_DDL },
  { id: 5, name: "p6_formation_communication", sql: P6_DDL },
  { id: 6, name: "p7_dependency_deliverable", sql: P7_DDL },
  { id: 7, name: "p7_messages_deliver_kind", sql: P7_MESSAGES_V7_DDL },
  { id: 8, name: "p8_verification", sql: P8_DDL },
];

/** P11 `01` §3 / `03`: environment change records — the authoritative
 * mutation trail. Counter lives in environment_revisions (unchanged);
 * fingerprints + snapshotBlobRef live HERE (declared additive surface).
 * The latest-change pointer per project = MAX(to_revision). */
const P11_DDL = `
CREATE TABLE environment_changes (
  change_id             TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(project_id),
  from_revision         TEXT NOT NULL,
  to_revision           TEXT NOT NULL,
  previous_fingerprint  TEXT NOT NULL,
  next_fingerprint      TEXT NOT NULL,
  snapshot_blob_ref     TEXT NOT NULL,
  changed_regions_json  TEXT NOT NULL,
  cause                 TEXT NOT NULL CHECK (cause IN ('ExternalDrift','Governance','WorktreeLifecycle')),
  recorded_at           TEXT NOT NULL,
  UNIQUE (project_id, to_revision)
);
CREATE INDEX idx_env_changes_project ON environment_changes(project_id, to_revision);
`;

export const P11_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  { id: 1, name: "init", sql: DDL },
  { id: 2, name: "execution_session_kernel", sql: P2_DDL },
  { id: 3, name: "provider_model_context", sql: P3_DDL },
  { id: 4, name: "tool_runtime", sql: P4_DDL },
  { id: 5, name: "p6_formation_communication", sql: P6_DDL },
  { id: 6, name: "p7_dependency_deliverable", sql: P7_DDL },
  { id: 7, name: "p7_messages_deliver_kind", sql: P7_MESSAGES_V7_DDL },
  { id: 8, name: "p8_verification", sql: P8_DDL },
  { id: 9, name: "p11_environment_changes", sql: P11_DDL },
];
