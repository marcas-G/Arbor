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

/** P11 `09`: worktree lifecycle state. §1.4A enforcement lives in the
 * RetireWorktree precondition (active-claims check), not here. */
const P11_WORKTREES_DDL = `
CREATE TABLE worktrees (
  worktree_id     TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(project_id),
  workspace_id    TEXT NOT NULL REFERENCES workspaces(workspace_id),
  path            TEXT NOT NULL,
  repository_ref  TEXT,
  branch          TEXT,
  state           TEXT NOT NULL CHECK (state IN ('Active','Retired')),
  created_at      TEXT NOT NULL,
  retired_at      TEXT,
  CHECK ((state = 'Active') = (retired_at IS NULL))
);
CREATE INDEX idx_worktrees_workspace ON worktrees(workspace_id);
`;

export const P11B_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  { id: 1, name: "init", sql: DDL },
  { id: 2, name: "execution_session_kernel", sql: P2_DDL },
  { id: 3, name: "provider_model_context", sql: P3_DDL },
  { id: 4, name: "tool_runtime", sql: P4_DDL },
  { id: 5, name: "p6_formation_communication", sql: P6_DDL },
  { id: 6, name: "p7_dependency_deliverable", sql: P7_DDL },
  { id: 7, name: "p7_messages_deliver_kind", sql: P7_MESSAGES_V7_DDL },
  { id: 8, name: "p8_verification", sql: P8_DDL },
  { id: 9, name: "p11_environment_changes", sql: P11_DDL },
  { id: 10, name: "p11_worktrees", sql: P11_WORKTREES_DDL },
];

/** P12 `01` §5.2 (TR-7): the durable Project-tool registration store. A
 * registration is project-scoped (`project_id`) and its identity is
 * `(plugin_id, plugin_version, content_hash)`; the row binds that key to the
 * exact `ToolDefinition` definitions the registration contributes (one
 * registration may contribute multiple definitions). */
const P12_PROJECT_TOOL_REGISTRY_DDL = `
CREATE TABLE project_tool_registry (
  project_id       TEXT NOT NULL,
  plugin_id        TEXT NOT NULL,
  plugin_version   TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  definitions_json TEXT NOT NULL,
  registered_at    TEXT NOT NULL,
  PRIMARY KEY (project_id, plugin_id, plugin_version, content_hash)
);
CREATE INDEX idx_project_tool_registry_project
  ON project_tool_registry(project_id);
`;

/** P12 `02` §5.1 (TR-7): the durable `permission_grants` store. The frozen P0
 * `PermissionGrant` type is unchanged; `project_id` is the relational scope
 * key, not a new domain field. `state` is the only mutable lifecycle. */
const P12_PERMISSION_GRANTS_DDL = `
CREATE TABLE permission_grants (
  permission_grant_id TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  scope               TEXT NOT NULL,
  issuer              TEXT NOT NULL,
  lifetime            TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('Active','Revoked'))
);
CREATE INDEX permission_grants_active ON permission_grants (project_id, state);
`;

/** P12 `06` §3 (TR-9): the inherited P2 lease evolution — incarnation
 * fencing. The frozen `execution_leases` table (`P2 04` §3.2) had no
 * incarnation column; this forward-only migration adds it so the lease holder
 * / fence identity becomes `(worker_id, worker_incarnation_id, generation)`.
 * The `NOT NULL DEFAULT ''` backfill keeps pre-P12 rows valid; a fresh
 * acquisition records the acquiring incarnation. */
const P12_LEASE_WORKER_INCARNATION_DDL = `
ALTER TABLE execution_leases ADD COLUMN worker_incarnation_id TEXT NOT NULL DEFAULT '';
`;

/** P12 ordered migration baseline (TR-7). The three P12 migrations are
 * `0011_lease_worker_incarnation` (this task, `06`), `0012_permission_grants`
 * (`02`), and `0013_project_tool_registry` (`01`). The forward-only runner
 * keys on `PRAGMA user_version` and applies every migration with
 * `id > current` in ascending id order, so `user_version` settles at
 * `max(applied id)` = 13. */
export const P12_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P11B_MIGRATIONS,
  {
    id: 11,
    name: "lease_worker_incarnation",
    sql: P12_LEASE_WORKER_INCARNATION_DDL,
  },
  { id: 12, name: "permission_grants", sql: P12_PERMISSION_GRANTS_DDL },
  { id: 13, name: "project_tool_registry", sql: P12_PROJECT_TOOL_REGISTRY_DDL },
];

/** P14 `01` §4: durable human chat-turn messages. `state` is the claim
 * lifecycle (Pending → Claimed → Answered); `fingerprint` is the semantic
 * request fingerprint (P1 §8) that makes replays converge; the
 * `(command_id, fingerprint)` UNIQUE is the physical idempotency anchor. */
const P14_HUMAN_MESSAGES_DDL = `
CREATE TABLE human_messages (
  message_id              TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL,
  root_workspace_id       TEXT NOT NULL,
  human_principal         TEXT NOT NULL,
  body_ref                TEXT NOT NULL,
  command_id              TEXT NOT NULL,
  fingerprint             TEXT NOT NULL,
  state                   TEXT NOT NULL CHECK (state IN ('Pending','Claimed','Answered')),
  claimed_by_execution_id TEXT,
  created_at              TEXT NOT NULL,
  settled_at              TEXT,
  response_body           TEXT,
  attempt_no              INTEGER NOT NULL DEFAULT 0,
  UNIQUE (command_id, fingerprint)
);
CREATE INDEX human_messages_pending ON human_messages (project_id, state, created_at);
`;

/** P14 ordered migration baseline. Forward-only runner keys on
 * `PRAGMA user_version`; this migration settles `user_version` at 14. */
export const P14_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P12_MIGRATIONS,
  { id: 14, name: "human_messages", sql: P14_HUMAN_MESSAGES_DDL },
];

/** Provider Runtime Correctness Phase 1. Existing attempt rows retain their
 * original failure vocabulary (`legacy-v1`) and are deliberately not
 * reclassified. New attempts persist in-progress state, monotonic observation
 * evidence, retry decisions, and an explicit current taxonomy version. */
const P15_PROVIDER_RUNTIME_CORRECTNESS_DDL = `
ALTER TABLE provider_turns ADD COLUMN execution_policy_json TEXT;
ALTER TABLE provider_turns ADD COLUMN turn_deadline_at TEXT;
ALTER TABLE model_context_manifests ADD COLUMN portable_request_json TEXT;

ALTER TABLE provider_attempts RENAME TO provider_attempts_legacy_v1;

CREATE TABLE provider_attempts (
  provider_turn_id              TEXT NOT NULL REFERENCES provider_turns(provider_turn_id),
  attempt_no                    INTEGER NOT NULL,
  started_at                    TEXT NOT NULL,
  settled_at                    TEXT,
  outcome                       TEXT NOT NULL CHECK (outcome IN
                                  ('InProgress','Success','RetryableFailure','TerminalFailure','Cancelled','TimedOut')),
  provider_error_kind           TEXT,
  failure_taxonomy_version      TEXT NOT NULL DEFAULT 'legacy-v1' CHECK (failure_taxonomy_version IN ('legacy-v1','phase1-v2')),
  observation_json              TEXT NOT NULL DEFAULT '{"responseStarted":null,"canonicalEventEmitted":null,"consumerVisibleOutput":null,"toolCallProposed":null,"continuationAvailable":null,"externalEffectPossible":null}',
  canonical_event_prefix_json   TEXT NOT NULL DEFAULT '[]',
  delivered_position            INTEGER,
  continuation_checkpoint_json  TEXT,
  retry_safety                  TEXT CHECK (retry_safety IS NULL OR retry_safety IN
                                  ('SafeReplay','SafeResume','UnsafeReplay')),
  retry_decision                TEXT CHECK (retry_decision IS NULL OR retry_decision IN ('Retry','Stop')),
  retry_strategy                TEXT CHECK (retry_strategy IS NULL OR retry_strategy IN ('Replay','Resume')),
  retry_reason                  TEXT,
  transport_metadata_json       TEXT,
  PRIMARY KEY (provider_turn_id, attempt_no),
  CHECK ((outcome = 'InProgress') = (settled_at IS NULL)),
  CHECK ((retry_decision IS NULL) = (retry_safety IS NULL)),
  CHECK ((retry_decision IS NULL) = (retry_reason IS NULL))
);

INSERT INTO provider_attempts (
  provider_turn_id,
  attempt_no,
  started_at,
  settled_at,
  outcome,
  provider_error_kind,
  failure_taxonomy_version,
  observation_json,
  canonical_event_prefix_json,
  delivered_position,
  continuation_checkpoint_json,
  retry_safety,
  retry_decision,
  retry_strategy,
  retry_reason,
  transport_metadata_json
)
SELECT
  provider_turn_id,
  attempt_no,
  started_at,
  settled_at,
  outcome,
  provider_error_kind,
  'legacy-v1',
  '{"responseStarted":null,"canonicalEventEmitted":null,"consumerVisibleOutput":null,"toolCallProposed":null,"continuationAvailable":null,"externalEffectPossible":null}',
  '[]',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  transport_metadata_json
FROM provider_attempts_legacy_v1;

DROP TABLE provider_attempts_legacy_v1;

CREATE TABLE provider_recovery_decisions (
  provider_turn_id  TEXT NOT NULL REFERENCES provider_turns(provider_turn_id),
  sequence_no       INTEGER NOT NULL CHECK(sequence_no >= 0),
  attempt_no        INTEGER NOT NULL CHECK(attempt_no >= -1),
  cause_tag         TEXT NOT NULL CHECK(cause_tag IN
                       ('ProviderFailure','ProcessLost','Timeout','Cancelled')),
  cause_detail      TEXT,
  retry_safety      TEXT NOT NULL CHECK(retry_safety IN
                       ('SafeReplay','SafeResume','UnsafeReplay')),
  retry_decision    TEXT NOT NULL CHECK(retry_decision IN ('Retry','Stop')),
  retry_strategy    TEXT CHECK(retry_strategy IS NULL OR retry_strategy IN
                       ('Replay','Resume')),
  retry_reason      TEXT NOT NULL,
  decided_at        TEXT NOT NULL,
  PRIMARY KEY (provider_turn_id, sequence_no)
);
`;

export const P15_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P14_MIGRATIONS,
  {
    id: 15,
    name: "provider_runtime_correctness",
    sql: P15_PROVIDER_RUNTIME_CORRECTNESS_DDL,
  },
];

/** Gate C C3 (P16 `03` §2.2): the reasoning round-trip attachment lives in
 * the conversation history (human_messages), NOT in provider transport rows.
 * The column carries the serialized `ReasoningAttachment` (or null). This is
 * the unambiguous existing-DDL carrier — no new table needed. */
const P16_REASONING_ATTACHMENT_DDL = `
ALTER TABLE human_messages ADD COLUMN provider_reasoning_json TEXT;
`;

/** P16 ordered migration baseline; settles user_version at 16. */
export const P16_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P15_MIGRATIONS,
  {
    id: 16,
    name: "p16_reasoning_attachment",
    sql: P16_REASONING_ATTACHMENT_DDL,
  },
];

/** DID v1.21 ALS-I1: durable AgentLoopStep handoff. The source columns are
 * nullable only for pre-0017 rows; triggers require new/updated rows to use an
 * all-null legacy shape or an all-present source identity. */
const P17_AGENT_LOOP_STEP_HANDOFF_DDL = `
ALTER TABLE provider_attempts ADD COLUMN success_evidence_version TEXT;

ALTER TABLE session_entries RENAME TO session_entries_legacy_v1;

CREATE TABLE session_entries (
  session_id   TEXT NOT NULL REFERENCES sessions(session_id),
  sequence     INTEGER NOT NULL,
  entry_kind   TEXT NOT NULL CHECK (entry_kind IN
                 ('Input','ModelOutput','Observation','CheckpointReference','ContextUpdate')),
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  source_kind  TEXT,
  source_ref   TEXT,
  content_hash TEXT,
  PRIMARY KEY (session_id, sequence),
  CHECK (
    (source_kind IS NULL AND source_ref IS NULL AND content_hash IS NULL)
    OR
    (source_kind IS NOT NULL AND source_ref IS NOT NULL AND content_hash IS NOT NULL)
  )
);

INSERT INTO session_entries (
  session_id, sequence, entry_kind, payload_json, created_at,
  source_kind, source_ref, content_hash
)
SELECT
  session_id, sequence, entry_kind, payload_json, created_at,
  NULL, NULL, NULL
FROM session_entries_legacy_v1;

DROP TABLE session_entries_legacy_v1;

CREATE UNIQUE INDEX idx_session_entries_source
  ON session_entries(session_id, entry_kind, source_kind, source_ref)
  WHERE source_kind IS NOT NULL;

CREATE TABLE agent_loop_steps (
  execution_id                  TEXT NOT NULL REFERENCES executions(execution_id),
  logical_step_no               INTEGER NOT NULL CHECK (logical_step_no >= 0),
  repair_attempt                INTEGER NOT NULL CHECK (repair_attempt >= 0),
  provider_turn_id              TEXT NOT NULL UNIQUE,
  predecessor_logical_step_no   INTEGER,
  predecessor_repair_attempt    INTEGER,
  manifest_id                   TEXT,
  state                         TEXT NOT NULL CHECK (state IN
    ('Prepared','ProviderResultAvailable','OutputRejected','OutputAccepted',
     'ActionsInProgress','StepEffectsCommitted','NextStepReady',
     'SettlementProposed')),
  decoder_version               TEXT,
  provider_failure_json         TEXT,
  repair_disposition_json       TEXT,
  successor_json                TEXT,
  next_step_reason              TEXT,
  decoded_output_hash           TEXT,
  model_output_session_sequence INTEGER,
  next_action_index             INTEGER NOT NULL DEFAULT 0 CHECK (next_action_index >= 0),
  settlement_json               TEXT,
  migration_provenance_json     TEXT,
  revision                      INTEGER NOT NULL CHECK (revision >= 0),
  updated_at                    TEXT NOT NULL,
  PRIMARY KEY (execution_id, logical_step_no, repair_attempt),
  CHECK ((predecessor_logical_step_no IS NULL) =
         (predecessor_repair_attempt IS NULL)),
  CHECK ((state = 'SettlementProposed') = (settlement_json IS NOT NULL))
);

CREATE INDEX idx_agent_loop_steps_execution_state
  ON agent_loop_steps(execution_id, state);

CREATE TABLE agent_loop_step_actions (
  execution_id           TEXT NOT NULL,
  logical_step_no        INTEGER NOT NULL,
  repair_attempt         INTEGER NOT NULL,
  action_index           INTEGER NOT NULL CHECK (action_index >= 0),
  logical_action_id      TEXT NOT NULL UNIQUE,
  call_ref               TEXT NOT NULL,
  route_kind             TEXT NOT NULL CHECK (route_kind IN ('Executable','Control')),
  action_kind            TEXT NOT NULL,
  input_hash             TEXT NOT NULL,
  state                  TEXT NOT NULL CHECK (state IN
    ('Pending','Applied','SkippedStale','SkippedEarlySettlement',
     'TerminalRejected','ReconciliationPending')),
  result_ref             TEXT,
  settlement_ref         TEXT,
  disposition_json       TEXT,
  observation_source_ref TEXT,
  revision               INTEGER NOT NULL CHECK (revision >= 0),
  updated_at              TEXT NOT NULL,
  PRIMARY KEY (execution_id, logical_step_no, repair_attempt, action_index),
  FOREIGN KEY (execution_id, logical_step_no, repair_attempt)
    REFERENCES agent_loop_steps(execution_id, logical_step_no, repair_attempt)
);
`;

/** AgentLoopStep implementation baseline; settles user_version at 17. */
export const P17_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P16_MIGRATIONS,
  {
    id: 17,
    name: "agent_loop_step_handoff",
    sql: P17_AGENT_LOOP_STEP_HANDOFF_DDL,
  },
];

const P18_PROJECT_ARCHIVE_DDL = `
ALTER TABLE human_messages RENAME TO human_messages_p17;
CREATE TABLE human_messages (
  message_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  root_workspace_id TEXT NOT NULL,
  human_principal TEXT NOT NULL,
  body_ref TEXT NOT NULL,
  command_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('Pending','Claimed','Answered','Declined')),
  claimed_by_execution_id TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  response_body TEXT,
  attempt_no INTEGER NOT NULL DEFAULT 0,
  provider_reasoning_json TEXT,
  UNIQUE (command_id, fingerprint)
);
INSERT INTO human_messages
SELECT message_id, project_id, root_workspace_id, human_principal, body_ref,
       command_id, fingerprint, state, claimed_by_execution_id, created_at,
       settled_at, response_body, attempt_no, provider_reasoning_json
FROM human_messages_p17;
DROP TABLE human_messages_p17;
CREATE INDEX human_messages_pending ON human_messages (project_id, state, created_at);
`;

export const P18_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P17_MIGRATIONS,
  {
    id: 18,
    name: "project_archive_human_message_terminal",
    sql: P18_PROJECT_ARCHIVE_DDL,
  },
];

/** DID v1.22 / SCRC-002: versioned typed Session Timeline carrier. Legacy
 * rows remain byte-preserved evidence and intentionally receive no inferred
 * callRef or context epoch. */
const P19_SESSION_CONTEXT_RUNTIME_CONVERGENCE_DDL = `
ALTER TABLE session_entries RENAME TO session_entries_legacy_v2;

CREATE TABLE session_entries (
  session_id    TEXT NOT NULL REFERENCES sessions(session_id),
  sequence      INTEGER NOT NULL,
  entry_kind    TEXT NOT NULL CHECK (entry_kind IN
                  ('Input','ModelOutput','Observation','CheckpointReference','ContextUpdate')),
  item_type     TEXT NOT NULL CHECK (item_type IN
                  ('LegacyInput','LegacyModelOutput','LegacyObservation',
                   'LegacyCheckpointReference','LegacyContextUpdate',
                   'UserMessage','AssistantMessage','ToolCall','ToolResult',
                   'ControlResult','ContextUpdate','CompactionCheckpoint','AttachmentRef')),
  schema_version INTEGER NOT NULL CHECK (schema_version IN (1,2)),
  context_epoch INTEGER,
  payload_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  source_kind   TEXT,
  source_ref    TEXT,
  content_hash  TEXT,
  PRIMARY KEY (session_id, sequence),
  CHECK (
    (source_kind IS NULL AND source_ref IS NULL AND content_hash IS NULL)
    OR
    (source_kind IS NOT NULL AND source_ref IS NOT NULL AND content_hash IS NOT NULL)
  ),
  CHECK (
    (schema_version = 1 AND item_type LIKE 'Legacy%' AND context_epoch IS NULL)
    OR
    (schema_version = 2 AND item_type NOT LIKE 'Legacy%' AND context_epoch IS NOT NULL)
  )
);

INSERT INTO session_entries (
  session_id, sequence, entry_kind, item_type, schema_version, context_epoch,
  payload_json, created_at, source_kind, source_ref, content_hash
)
SELECT
  session_id, sequence, entry_kind, 'Legacy' || entry_kind, 1, NULL,
  payload_json, created_at, source_kind, source_ref, content_hash
FROM session_entries_legacy_v2;

DROP TABLE session_entries_legacy_v2;

CREATE UNIQUE INDEX idx_session_entries_source
  ON session_entries(session_id, item_type, source_kind, source_ref)
  WHERE source_kind IS NOT NULL;
`;

/** SCRC implementation baseline; settles user_version at 19. */
export const P19_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P18_MIGRATIONS,
  {
    id: 19,
    name: "session_context_runtime_convergence",
    sql: P19_SESSION_CONTEXT_RUNTIME_CONVERGENCE_DDL,
  },
];

const P20_AGENT_LOOP_STEP_PROVIDER_TURN_CHAIN_DDL = `
CREATE TABLE agent_loop_step_provider_turns (
  execution_id TEXT NOT NULL,
  logical_step_no INTEGER NOT NULL,
  repair_attempt INTEGER NOT NULL,
  overflow_ordinal INTEGER NOT NULL CHECK (overflow_ordinal = 0),
  role TEXT NOT NULL CHECK (role IN ('Inference','OverflowCompaction','OverflowReplacement')),
  provider_turn_id TEXT NOT NULL UNIQUE,
  predecessor_provider_turn_id TEXT,
  context_epoch INTEGER NOT NULL,
  manifest_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('Prepared','SettledSuccess','SettledFailure')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, logical_step_no, repair_attempt, overflow_ordinal, role),
  FOREIGN KEY (execution_id, logical_step_no, repair_attempt)
    REFERENCES agent_loop_steps(execution_id, logical_step_no, repair_attempt)
);
`;

export const P20_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P19_MIGRATIONS,
  {
    id: 20,
    name: "agent_loop_step_provider_turn_chain",
    sql: P20_AGENT_LOOP_STEP_PROVIDER_TURN_CHAIN_DDL,
  },
];

const P21_CONVERSATION_DELIVERY_RUNTIME_DDL = `
CREATE TABLE conversation_response_jobs (
  message_id TEXT PRIMARY KEY REFERENCES human_messages(message_id),
  project_id TEXT NOT NULL,
  root_workspace_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('Queued','Running','RetryScheduled','NeedsAttention','Answered','Cancelled')),
  active_execution_id TEXT UNIQUE,
  next_attempt_no INTEGER NOT NULL CHECK (next_attempt_no >= 0),
  next_eligible_at TEXT,
  attention_reason TEXT,
  last_failure_class TEXT,
  last_failure_fingerprint TEXT,
  policy_version TEXT NOT NULL,
  response_body TEXT,
  response_execution_id TEXT,
  provider_reasoning_json TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_conversation_jobs_eligible
  ON conversation_response_jobs(state, next_eligible_at, created_at);

CREATE TABLE conversation_attempts (
  message_id TEXT NOT NULL REFERENCES human_messages(message_id),
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 0),
  execution_id TEXT NOT NULL UNIQUE,
  admitted_at TEXT NOT NULL,
  settled_at TEXT,
  settlement_kind TEXT,
  failure_class TEXT,
  failure_fingerprint TEXT,
  retry_decision_json TEXT,
  policy_version TEXT NOT NULL,
  PRIMARY KEY (message_id, attempt_no)
);

CREATE TABLE provider_deployment_breakers (
  binding_fingerprint TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('Closed','Open','HalfOpen')),
  consecutive_failures INTEGER NOT NULL CHECK (consecutive_failures >= 0),
  cooldown_until TEXT,
  failure_class TEXT,
  configuration_revision TEXT NOT NULL,
  half_open_execution_id TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at TEXT NOT NULL
);

INSERT INTO conversation_response_jobs (
  message_id, project_id, root_workspace_id, state, active_execution_id,
  next_attempt_no, next_eligible_at, attention_reason, last_failure_class,
  last_failure_fingerprint, policy_version, response_body,
  response_execution_id, provider_reasoning_json, revision, created_at,
  updated_at
)
SELECT
  message_id,
  project_id,
  root_workspace_id,
  CASE
    WHEN state = 'Pending' THEN 'Queued'
    WHEN state = 'Claimed' THEN 'Running'
    WHEN state = 'Answered' AND response_body IS NOT NULL THEN 'Answered'
    WHEN state = 'Answered' THEN 'Cancelled'
    ELSE 'Cancelled'
  END,
  CASE WHEN state = 'Claimed' THEN claimed_by_execution_id ELSE NULL END,
  CASE WHEN state = 'Pending' THEN attempt_no ELSE attempt_no + 1 END,
  NULL,
  CASE
    WHEN state = 'Answered' AND response_body IS NULL THEN 'LegacyInterrupted'
    WHEN state = 'Declined' THEN 'ProjectClosed'
    ELSE NULL
  END,
  NULL,
  NULL,
  'conversation-retry-v1',
  CASE WHEN state = 'Answered' THEN response_body ELSE NULL END,
  CASE WHEN state = 'Answered' THEN claimed_by_execution_id ELSE NULL END,
  provider_reasoning_json,
  0,
  created_at,
  COALESCE(settled_at, created_at)
FROM human_messages;

INSERT INTO conversation_attempts (
  message_id, attempt_no, execution_id, admitted_at, settled_at,
  settlement_kind, failure_class, failure_fingerprint, retry_decision_json,
  policy_version
)
SELECT
  hm.message_id,
  hm.attempt_no,
  hm.claimed_by_execution_id,
  COALESCE(e.admitted_at, hm.created_at),
  e.settled_at,
  e.settlement_kind,
  NULL,
  NULL,
  NULL,
  'conversation-retry-v1'
FROM human_messages hm
LEFT JOIN executions e ON e.execution_id = hm.claimed_by_execution_id
WHERE hm.claimed_by_execution_id IS NOT NULL;
`;

/** DID v1.24 / P17 Conversation Delivery Runtime; user_version 21. */
export const P21_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P20_MIGRATIONS,
  {
    id: 21,
    name: "conversation_delivery_runtime",
    sql: P21_CONVERSATION_DELIVERY_RUNTIME_DDL,
  },
];

export const P22_VERIFICATION_DELIVERY_CONVERGENCE_DDL = `
ALTER TABLE verifications ADD COLUMN summary_ref TEXT;

CREATE TRIGGER verifications_conclusion_summary_update
BEFORE UPDATE OF state, summary_ref ON verifications
WHEN NEW.state = 'Concluded'
  AND (NEW.summary_ref IS NULL OR length(trim(NEW.summary_ref)) = 0)
BEGIN
  SELECT RAISE(ABORT, 'concluded verification requires summary_ref');
END;

CREATE TRIGGER verifications_conclusion_summary_insert
BEFORE INSERT ON verifications
WHEN NEW.state = 'Concluded'
  AND (NEW.summary_ref IS NULL OR length(trim(NEW.summary_ref)) = 0)
BEGIN
  SELECT RAISE(ABORT, 'concluded verification requires summary_ref');
END;
`;

/** DID v1.26 Verification Delivery Convergence; user_version 22. */
export const P22_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P21_MIGRATIONS,
  {
    id: 22,
    name: "verification_delivery_convergence",
    sql: P22_VERIFICATION_DELIVERY_CONVERGENCE_DDL,
  },
];

export const P23_VERIFICATION_EVIDENCE_IDENTITY_DDL = `
ALTER TABLE verification_evidence ADD COLUMN tool_invocation_id TEXT;
ALTER TABLE verification_evidence ADD COLUMN observation_ref TEXT;
ALTER TABLE verification_evidence ADD COLUMN call_ref TEXT;

CREATE INDEX idx_verification_evidence_tool_invocation
  ON verification_evidence(tool_invocation_id);
`;

/** DID v1.26 Verification ToolObservation source identity; user_version 23. */
export const P23_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P22_MIGRATIONS,
  {
    id: 23,
    name: "verification_evidence_identity",
    sql: P23_VERIFICATION_EVIDENCE_IDENTITY_DDL,
  },
];

export const P24_EXECUTION_EPISODE_BINDING_DDL = `
ALTER TABLE executions ADD COLUMN episode_kind TEXT;
ALTER TABLE executions ADD COLUMN episode_ref TEXT;
ALTER TABLE executions ADD COLUMN episode_revision INTEGER;

UPDATE executions
SET episode_kind = 'WorkEpisode',
    episode_ref = focus_work_id,
    episode_revision = 0
WHERE binding_kind = 'workspace'
  AND focus_kind = 'work'
  AND focus_work_id IS NOT NULL;

UPDATE executions
SET episode_kind = 'ConversationResponseEpisode',
    episode_ref = (
      SELECT ca.message_id
      FROM conversation_attempts ca
      WHERE ca.execution_id = executions.execution_id
    ),
    episode_revision = 0
WHERE binding_kind = 'workspace'
  AND focus_kind = 'coordination'
  AND EXISTS (
    SELECT 1 FROM conversation_attempts ca
    WHERE ca.execution_id = executions.execution_id
  );

CREATE INDEX idx_executions_episode
  ON executions(episode_kind, episode_ref);

CREATE TABLE work_plans (
  work_id TEXT PRIMARY KEY REFERENCES works(work_id),
  target_work_revision INTEGER NOT NULL CHECK (target_work_revision >= 0),
  plan_revision INTEGER NOT NULL CHECK (plan_revision >= 1),
  items_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE work_selection_decision_requests (
  decision_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  candidate_work_ids_json TEXT NOT NULL,
  workspace_revision INTEGER NOT NULL CHECK (workspace_revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('Pending','Submitted')),
  selected_work_id TEXT REFERENCES works(work_id),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((state = 'Submitted') = (selected_work_id IS NOT NULL))
);

CREATE UNIQUE INDEX idx_work_selection_pending_workspace
  ON work_selection_decision_requests(workspace_id)
  WHERE state = 'Pending';
`;

/** DID v1.28 EGP exact EpisodeBinding; user_version 24. */
export const P24_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P23_MIGRATIONS,
  {
    id: 24,
    name: "execution_episode_binding",
    sql: P24_EXECUTION_EPISODE_BINDING_DDL,
  },
];

export const P25_EXECUTION_EPISODE_ONLY_DDL = `
ALTER TABLE executions RENAME TO executions_legacy_focus;

CREATE TABLE executions (
  execution_id        TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(project_id),
  binding_kind        TEXT NOT NULL CHECK (binding_kind IN ('workspace','execution_bound')),
  workspace_id        TEXT NOT NULL REFERENCES workspaces(workspace_id),
  episode_kind        TEXT CHECK (episode_kind IN
                        ('WorkEpisode','ConversationResponseEpisode','InboxEpisode',
                         'DecisionEpisode','LegacyAmbiguousEpisode')),
  episode_ref         TEXT,
  episode_revision    INTEGER CHECK (episode_revision IS NULL OR episode_revision >= 0),
  parent_execution_id TEXT REFERENCES executions(execution_id),
  mission             TEXT,
  session_id          TEXT NOT NULL REFERENCES sessions(session_id),
  admitted_at         TEXT NOT NULL,
  stop_requested_at   TEXT,
  settlement_kind     TEXT CHECK (settlement_kind IN
                        ('Completed','Interrupted','Failed','OutcomeUnknown')),
  settlement_json     TEXT,
  settled_at          TEXT,
  CHECK ((binding_kind = 'workspace') = (episode_kind IS NOT NULL)),
  CHECK ((binding_kind = 'workspace') = (episode_ref IS NOT NULL)),
  CHECK ((binding_kind = 'workspace') = (episode_revision IS NOT NULL)),
  CHECK ((binding_kind = 'execution_bound') = (parent_execution_id IS NOT NULL OR mission IS NOT NULL)),
  CHECK ((settlement_kind IS NULL) = (settled_at IS NULL)),
  CHECK ((settlement_kind IS NULL) = (settlement_json IS NULL))
);

INSERT INTO executions (
  execution_id, project_id, binding_kind, workspace_id,
  episode_kind, episode_ref, episode_revision,
  parent_execution_id, mission, session_id, admitted_at, stop_requested_at,
  settlement_kind, settlement_json, settled_at
)
SELECT
  execution_id, project_id, binding_kind, workspace_id,
  CASE
    WHEN binding_kind = 'workspace' AND episode_kind IS NULL
      THEN 'LegacyAmbiguousEpisode'
    ELSE episode_kind
  END,
  CASE
    WHEN binding_kind = 'workspace' AND episode_ref IS NULL
      THEN execution_id
    ELSE episode_ref
  END,
  CASE
    WHEN binding_kind = 'workspace' AND episode_revision IS NULL
      THEN 0
    ELSE episode_revision
  END,
  parent_execution_id, mission, session_id, admitted_at, stop_requested_at,
  settlement_kind, settlement_json, settled_at
FROM executions_legacy_focus;

DROP TABLE executions_legacy_focus;

CREATE UNIQUE INDEX idx_executions_active_main
  ON executions(workspace_id)
  WHERE binding_kind = 'workspace' AND settled_at IS NULL;
CREATE INDEX idx_executions_project ON executions(project_id);
CREATE INDEX idx_executions_unsettled
  ON executions(settled_at) WHERE settled_at IS NULL;
CREATE INDEX idx_executions_episode
  ON executions(episode_kind, episode_ref);
`;

/** DID v1.28 EGP Wave E legacy focus retirement; user_version 25. */
export const P25_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P24_MIGRATIONS,
  {
    id: 25,
    name: "execution_episode_only",
    sql: P25_EXECUTION_EPISODE_ONLY_DDL,
    foreignKeysOff: true,
  },
];

export const P26_AGENT_STATE_EPISODE_ONLY_DDL = `
ALTER TABLE agent_execution_state RENAME TO agent_execution_state_legacy_focus;

CREATE TABLE agent_execution_state (
  execution_id                    TEXT PRIMARY KEY REFERENCES executions(execution_id),
  episode_json                    TEXT NOT NULL,
  wake_reason                     TEXT NOT NULL,
  current_mode                    TEXT,
  active_skill_refs_json          TEXT NOT NULL,
  turn_no                         INTEGER NOT NULL,
  recent_directive_refs_json      TEXT NOT NULL,
  recent_action_fingerprints_json TEXT NOT NULL,
  updated_at                      TEXT NOT NULL
);

INSERT INTO agent_execution_state (
  execution_id, episode_json, wake_reason, current_mode,
  active_skill_refs_json, turn_no, recent_directive_refs_json,
  recent_action_fingerprints_json, updated_at
)
SELECT
  state.execution_id,
  CASE execution.episode_kind
    WHEN 'WorkEpisode' THEN json_object(
      '_tag', 'WorkEpisode',
      'workId', execution.episode_ref,
      'targetWorkRevision', execution.episode_revision
    )
    WHEN 'ConversationResponseEpisode' THEN json_object(
      '_tag', 'ConversationResponseEpisode',
      'messageId', execution.episode_ref,
      'responseJobRevision', execution.episode_revision
    )
    WHEN 'InboxEpisode' THEN json_object(
      '_tag', 'InboxEpisode',
      'entryKey', execution.episode_ref,
      'inputKind', 'LegacyMigrated'
    )
    WHEN 'DecisionEpisode' THEN json_object(
      '_tag', 'DecisionEpisode',
      'decisionId', execution.episode_ref,
      'decisionKind', 'SelectCurrentWork',
      'requestRevision', execution.episode_revision
    )
    WHEN 'LegacyAmbiguousEpisode' THEN json_object(
      '_tag', 'LegacyAmbiguousEpisode',
      'executionId', state.execution_id
    )
    ELSE json_object(
      '_tag', 'ExecutionBoundEpisode',
      'executionId', state.execution_id
    )
  END,
  state.wake_reason, state.current_mode, state.active_skill_refs_json,
  state.turn_no, state.recent_directive_refs_json,
  state.recent_action_fingerprints_json, state.updated_at
FROM agent_execution_state_legacy_focus AS state
JOIN executions AS execution ON execution.execution_id = state.execution_id;

DROP TABLE agent_execution_state_legacy_focus;
`;

/** DID v1.28 EGP Wave E agent-state focus retirement; user_version 26. */
export const P26_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P25_MIGRATIONS,
  {
    id: 26,
    name: "agent_state_episode_only",
    sql: P26_AGENT_STATE_EPISODE_ONLY_DDL,
  },
];

export const P27_FORMATION_GOVERNANCE_INBOX_BACKFILL_DDL = `
INSERT INTO inbox_entries (
  workspace_id, entry_key, kind, summary, correlation_id, admitted_at, consumed_at
)
SELECT
  parent_workspace_id,
  'gov:' || proposal_id || ':' || revision,
  'Governance',
  'formation proposal "' || json_extract(proposal_json, '$.name') ||
    '" revision ' || revision || ' awaiting human decision',
  NULL,
  updated_at,
  NULL
FROM formation_proposals
WHERE state = 'Pending'
ON CONFLICT(workspace_id, entry_key) DO NOTHING;
`;

/** DID v1.29 CRAC recovery: every pending formation proposal is actionable. */
export const P27_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P26_MIGRATIONS,
  {
    id: 27,
    name: "formation_governance_inbox_backfill",
    sql: P27_FORMATION_GOVERNANCE_INBOX_BACKFILL_DDL,
  },
];

export const P28_SETTLED_GOVERNANCE_INBOX_CLEANUP_DDL = `
UPDATE inbox_entries AS inbox
SET consumed_at = COALESCE(consumed_at, CURRENT_TIMESTAMP)
WHERE inbox.kind = 'Governance'
  AND inbox.consumed_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM formation_proposals AS proposal
    WHERE proposal.state <> 'Pending'
      AND proposal.parent_workspace_id = inbox.workspace_id
      AND inbox.entry_key =
        'gov:' || proposal.proposal_id || ':' || proposal.revision
  );
`;

/** DID v1.29 CRAC recovery: settled decisions leave no actionable stale row. */
export const P28_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P27_MIGRATIONS,
  {
    id: 28,
    name: "settled_governance_inbox_cleanup",
    sql: P28_SETTLED_GOVERNANCE_INBOX_CLEANUP_DDL,
  },
];

export const P29_SUBJECT_BOUND_PERMISSION_GRANTS_DDL = `
ALTER TABLE permission_grants ADD COLUMN subject_kind TEXT
  CHECK (subject_kind IS NULL OR subject_kind IN
    ('HumanPrincipal','WorkspaceAgent','Execution'));
ALTER TABLE permission_grants ADD COLUMN subject_ref TEXT;
ALTER TABLE permission_grants ADD COLUMN capability TEXT;
ALTER TABLE permission_grants ADD COLUMN target TEXT;
ALTER TABLE permission_grants ADD COLUMN valid_from TEXT;
ALTER TABLE permission_grants ADD COLUMN expires_at TEXT;
ALTER TABLE permission_grants ADD COLUMN revision INTEGER
  CHECK (revision IS NULL OR revision >= 0);

UPDATE permission_grants
SET state = 'Revoked'
WHERE subject_kind IS NULL OR subject_ref IS NULL OR capability IS NULL;

CREATE INDEX permission_grants_subject_active
  ON permission_grants(project_id, subject_kind, subject_ref, capability, state);
`;

/** CAPA-1: legacy unbound grants fail closed; user_version 29. */
export const P29_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P28_MIGRATIONS,
  {
    id: 29,
    name: "subject_bound_permission_grants",
    sql: P29_SUBJECT_BOUND_PERMISSION_GRANTS_DDL,
  },
];

export const P30_CONTROL_ACTION_APPROVALS_DDL = `
CREATE TABLE control_action_approvals (
  approval_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  stable_action_id TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  control_basis_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('Pending','Approved','Rejected','Consumed','Expired')),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_reason TEXT,
  consumed_at TEXT,
  CHECK ((state IN ('Approved','Rejected','Consumed')) = (decided_at IS NOT NULL)),
  CHECK ((state = 'Consumed') = (consumed_at IS NOT NULL))
);

CREATE UNIQUE INDEX control_action_approvals_exact_action
  ON control_action_approvals(execution_id, action_digest, control_basis_digest);
CREATE INDEX control_action_approvals_pending
  ON control_action_approvals(workspace_id, state, requested_at);
`;

/** CAPA-2: durable exact-action approval interruption; user_version 30. */
export const P30_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P29_MIGRATIONS,
  {
    id: 30,
    name: "control_action_approvals",
    sql: P30_CONTROL_ACTION_APPROVALS_DDL,
  },
];

export const P31_FORMATION_FULFILLMENT_DDL = `
CREATE TABLE formation_fulfillments (
  proposal_id TEXT NOT NULL REFERENCES formation_proposals(proposal_id),
  proposal_revision INTEGER NOT NULL CHECK (proposal_revision >= 1),
  expected_child_workspace_id TEXT NOT NULL,
  expected_initial_work_id TEXT,
  state TEXT NOT NULL CHECK (state IN
    ('AwaitingDecision','PendingApplication','WorkspaceCreated','Applied','Blocked')),
  typed_block TEXT,
  last_attempt_at TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (proposal_id, proposal_revision),
  CHECK ((state = 'Blocked') = (typed_block IS NOT NULL))
);

CREATE INDEX formation_fulfillments_state
  ON formation_fulfillments(state, last_attempt_at);

INSERT INTO formation_fulfillments (
  proposal_id, proposal_revision, expected_child_workspace_id,
  expected_initial_work_id, state, typed_block, last_attempt_at, revision
)
SELECT proposal_id, revision,
       'ws_' || substr(proposal_id, 5),
       CASE WHEN json_type(proposal_json, '$.initialWork') IS NULL
            THEN NULL ELSE 'wrk_' || substr(proposal_id, 5) END,
       CASE state
         WHEN 'Pending' THEN 'AwaitingDecision'
         WHEN 'Approved' THEN 'PendingApplication'
         ELSE 'Blocked'
       END,
       CASE state WHEN 'Rejected' THEN 'FormationRejected' ELSE NULL END,
       NULL,
       0
FROM formation_proposals;
`;

/** MAC-P2: durable distinction between formation decision and application. */
export const P31_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P30_MIGRATIONS,
  {
    id: 31,
    name: "formation_fulfillment",
    sql: P31_FORMATION_FULFILLMENT_DDL,
  },
];

export const P32_ACTION_APPROVALS_DDL = `
CREATE TABLE action_approvals (
  approval_id TEXT PRIMARY KEY,
  route_kind TEXT NOT NULL CHECK (route_kind IN ('Control','Executable')),
  project_id TEXT,
  workspace_id TEXT,
  execution_id TEXT,
  subject_ref TEXT NOT NULL,
  stable_action_id TEXT NOT NULL,
  action_version TEXT NOT NULL,
  side_effect_semantics TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  target_resource_space_ids_json TEXT NOT NULL DEFAULT '[]',
  control_basis_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('Pending','Approved','Rejected','Consumed','Expired')),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_reason TEXT,
  consumed_at TEXT,
  consumed_by TEXT,
  binding_proven INTEGER NOT NULL CHECK (binding_proven IN (0,1)),
  source_state TEXT,
  CHECK ((state IN ('Approved','Rejected','Consumed')) = (decided_at IS NOT NULL)),
  CHECK ((state = 'Consumed') = (consumed_at IS NOT NULL OR consumed_by IS NOT NULL))
);

INSERT INTO action_approvals (
  approval_id, route_kind, project_id, workspace_id, execution_id,
  subject_ref, stable_action_id, action_version, side_effect_semantics,
  action_digest, arguments_json,
  target_ref, target_resource_space_ids_json, control_basis_digest,
  state, revision, requested_at, expires_at, decided_at, decided_by,
  decision_reason, consumed_at, consumed_by, binding_proven, source_state
)
SELECT approval_id, 'Control', project_id, workspace_id, execution_id,
       'legacy:unbound', stable_action_id, 'legacy', 'InternalControl',
       action_digest, arguments_json,
       target_ref, '[]', control_basis_digest,
       CASE WHEN state IN ('Pending','Approved') THEN 'Expired' ELSE state END,
       revision, requested_at,
       CASE WHEN state IN ('Pending','Approved') THEN '1970-01-01T00:00:00.000Z' ELSE expires_at END,
       CASE WHEN state IN ('Pending','Approved','Expired') THEN NULL ELSE decided_at END,
       CASE WHEN state IN ('Pending','Approved','Expired') THEN NULL ELSE decided_by END,
       CASE WHEN state IN ('Pending','Approved') THEN 'MigrationUnprovableSubject' ELSE decision_reason END,
       CASE WHEN state = 'Consumed' THEN consumed_at ELSE NULL END,
       NULL, 0, state
FROM control_action_approvals;

INSERT INTO action_approvals (
  approval_id, route_kind, project_id, workspace_id, execution_id,
  subject_ref, stable_action_id, action_version, side_effect_semantics,
  action_digest, arguments_json,
  target_ref, target_resource_space_ids_json, control_basis_digest,
  state, revision, requested_at, expires_at, decided_at, decided_by,
  decision_reason, consumed_at, consumed_by, binding_proven, source_state
)
SELECT approval_id, 'Executable', NULL, NULL, NULL,
       'legacy:unbound', tool_name, tool_version, 'LegacyUnknown',
       action_digest, '{}',
       target_resource_space_ids_json, target_resource_space_ids_json,
       control_basis_digest,
       CASE WHEN consumed_by IS NULL THEN 'Expired' ELSE 'Consumed' END,
       CASE WHEN consumed_by IS NULL THEN 1 ELSE 2 END,
       expires_at,
       CASE WHEN consumed_by IS NULL THEN '1970-01-01T00:00:00.000Z' ELSE expires_at END,
       CASE WHEN consumed_by IS NULL THEN NULL ELSE expires_at END,
       CASE WHEN consumed_by IS NULL THEN NULL ELSE 'migration:p4' END,
       CASE WHEN consumed_by IS NULL THEN 'MigrationUnprovableSubject' ELSE NULL END,
       CASE WHEN consumed_by IS NULL THEN NULL ELSE expires_at END,
       consumed_by, 0,
       CASE WHEN consumed_by IS NULL THEN 'Approved' ELSE 'Consumed' END
FROM invocation_approvals;

DROP TABLE invocation_approvals;
DROP TABLE control_action_approvals;

CREATE UNIQUE INDEX action_approvals_exact_action
  ON action_approvals(route_kind, execution_id, action_digest, control_basis_digest)
  WHERE execution_id IS NOT NULL;
CREATE INDEX action_approvals_pending
  ON action_approvals(workspace_id, state, requested_at);
`;

/** MAC-P4: one physical exact-intent approval ledger; user_version 32. */
export const P32_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P31_MIGRATIONS,
  {
    id: 32,
    name: "action_approval_convergence",
    sql: P32_ACTION_APPROVALS_DDL,
  },
];

export const P33_ASSIGN_WORK_TARGET_BINDINGS_DDL = `
CREATE UNIQUE INDEX commands_id_project ON commands(command_id, project_id);
CREATE UNIQUE INDEX executions_id_project_workspace
  ON executions(execution_id, project_id, workspace_id);
CREATE UNIQUE INDEX workspaces_id_project_parent
  ON workspaces(workspace_id, project_id, parent_workspace_id);
CREATE UNIQUE INDEX works_id_project ON works(work_id, project_id);
CREATE UNIQUE INDEX permission_grants_id_project
  ON permission_grants(permission_grant_id, project_id);
CREATE UNIQUE INDEX action_approvals_id_project
  ON action_approvals(approval_id, project_id);

CREATE TABLE assign_work_target_bindings (
  command_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  provider_turn_id TEXT NOT NULL,
  logical_action_id TEXT NOT NULL,
  call_ref TEXT NOT NULL,
  parent_workspace_id TEXT NOT NULL,
  parent_work_id TEXT NOT NULL,
  parent_work_revision_at_command INTEGER NOT NULL CHECK (parent_work_revision_at_command >= 0),
  target_workspace_ref TEXT NOT NULL,
  target_ref_encoding_version INTEGER NOT NULL CHECK (target_ref_encoding_version = 1),
  parent_workspace_revision_at_command INTEGER NOT NULL CHECK (parent_workspace_revision_at_command >= 0),
  target_workspace_revision_at_resolution INTEGER NOT NULL CHECK (target_workspace_revision_at_resolution >= 0),
  target_workspace_id TEXT NOT NULL,
  target_lifecycle_at_commit TEXT NOT NULL CHECK (target_lifecycle_at_commit = 'Active'),
  work_id TEXT NOT NULL,
  predecessor_work_id TEXT NOT NULL,
  work_provenance_json TEXT NOT NULL,
  authority_kind TEXT NOT NULL CHECK (authority_kind IN ('PermissionGrant','ActionApproval')),
  permission_grant_id TEXT,
  action_approval_id TEXT,
  authority_evidence_json TEXT NOT NULL,
  authority_checked_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (execution_id, logical_action_id),
  UNIQUE (work_id),
  FOREIGN KEY (command_id, project_id) REFERENCES commands(command_id, project_id),
  FOREIGN KEY (execution_id, project_id, parent_workspace_id) REFERENCES executions(execution_id, project_id, workspace_id),
  FOREIGN KEY (parent_workspace_id, project_id) REFERENCES workspaces(workspace_id, project_id),
  FOREIGN KEY (target_workspace_id, project_id, parent_workspace_id) REFERENCES workspaces(workspace_id, project_id, parent_workspace_id),
  FOREIGN KEY (parent_work_id, project_id) REFERENCES works(work_id, project_id),
  FOREIGN KEY (work_id, project_id) REFERENCES works(work_id, project_id),
  FOREIGN KEY (predecessor_work_id, project_id) REFERENCES works(work_id, project_id),
  FOREIGN KEY (permission_grant_id, project_id) REFERENCES permission_grants(permission_grant_id, project_id),
  FOREIGN KEY (action_approval_id, project_id) REFERENCES action_approvals(approval_id, project_id),
  CHECK (
    (authority_kind = 'PermissionGrant' AND permission_grant_id IS NOT NULL AND action_approval_id IS NULL)
    OR
    (authority_kind = 'ActionApproval' AND permission_grant_id IS NULL AND action_approval_id IS NOT NULL)
  )
);
CREATE INDEX assign_work_target_bindings_target
  ON assign_work_target_bindings(project_id, target_workspace_id, target_workspace_ref);
CREATE INDEX assign_work_target_bindings_parent_work
  ON assign_work_target_bindings(project_id, parent_work_id, created_at);

CREATE TABLE assign_work_binding_attention_facts (
  attention_fact_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES domain_events(event_id),
  project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  target_workspace_id TEXT NOT NULL,
  logical_action_id TEXT NOT NULL,
  committed_command_id TEXT NOT NULL,
  failure_code TEXT NOT NULL CHECK (failure_code IN (
    'LegacyUnbound','MissingBinding','DuplicateBinding','MalformedBinding',
    'RefMismatch','AuthorityMismatch','ForeignTarget','PlacementMismatch',
    'SourceActionMismatch','ReceiptMismatch','WorkMismatch',
    'ProvenanceMismatch','EventMismatch','CommitLifecycleMismatch'
  )),
  first_detected_at TEXT NOT NULL,
  UNIQUE (execution_id, logical_action_id, committed_command_id),
  FOREIGN KEY (execution_id, project_id, target_workspace_id)
    REFERENCES executions(execution_id, project_id, workspace_id),
  FOREIGN KEY (committed_command_id, project_id)
    REFERENCES commands(command_id, project_id)
);
CREATE INDEX assign_work_binding_attention_target
  ON assign_work_binding_attention_facts(project_id, target_workspace_id, first_detected_at);
`;

export const P33_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P32_MIGRATIONS,
  {
    id: 33,
    name: "assign_work_target_bindings",
    sql: P33_ASSIGN_WORK_TARGET_BINDINGS_DDL,
  },
];

export const P34_ATTENTION_PROJECTION_DDL = `
CREATE TABLE attention_projection_rows (
  project_id TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source = 'AssignWorkTargetBindingFailure'),
  severity TEXT NOT NULL CHECK (severity = 'ActionRequired'),
  target_workspace_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  failure_code TEXT NOT NULL CHECK (failure_code IN (
    'LegacyUnbound','MissingBinding','DuplicateBinding','MalformedBinding',
    'RefMismatch','AuthorityMismatch','ForeignTarget','PlacementMismatch',
    'SourceActionMismatch','ReceiptMismatch','WorkMismatch',
    'ProvenanceMismatch','EventMismatch','CommitLifecycleMismatch'
  )),
  occurred_at TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  source_fact_id TEXT NOT NULL REFERENCES assign_work_binding_attention_facts(attention_fact_id),
  PRIMARY KEY (project_id, dedup_key),
  UNIQUE (project_id, source_event_id),
  FOREIGN KEY (target_workspace_id, project_id)
    REFERENCES workspaces(workspace_id, project_id)
);
CREATE INDEX attention_projection_target
  ON attention_projection_rows(project_id, target_workspace_id, occurred_at);
`;

/** P10 durable Attention business rows; user_version 34. */
export const P34_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P33_MIGRATIONS,
  {
    id: 34,
    name: "p10_attention_projection",
    sql: P34_ATTENTION_PROJECTION_DDL,
  },
];

/** FT-DG-01 OPEN-3 P1 intent source; user_version 35. No historical rows are
 * inferred from Workspace boundaries, receipts, or ownership claims. */
export const P35_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P34_MIGRATIONS,
  {
    id: 35,
    name: "workspace_resource_activation_intents",
    sql: `
      CREATE TABLE workspace_resource_activation_intents (
        project_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        resource_boundary_revision INTEGER NOT NULL CHECK (resource_boundary_revision >= 0),
        status TEXT NOT NULL CHECK (status IN ('Pending','Active')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        activated_at TEXT,
        PRIMARY KEY (project_id, workspace_id, resource_boundary_revision),
        FOREIGN KEY (workspace_id, project_id)
          REFERENCES workspaces(workspace_id, project_id),
        CHECK ((status = 'Active') = (activated_at IS NOT NULL))
      );
      CREATE INDEX idx_workspace_resource_activation_pending
        ON workspace_resource_activation_intents(project_id, created_at,
          workspace_id, resource_boundary_revision)
        WHERE status = 'Pending';

      CREATE TABLE workspace_resource_activation_attention_rows (
        project_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        resource_boundary_revision INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        PRIMARY KEY (project_id, workspace_id, resource_boundary_revision),
        FOREIGN KEY (project_id, workspace_id, resource_boundary_revision)
          REFERENCES workspace_resource_activation_intents
            (project_id, workspace_id, resource_boundary_revision)
      );

      CREATE INDEX workspace_resource_activation_attention_target
        ON workspace_resource_activation_attention_rows
          (project_id, workspace_id, occurred_at);
    `,
  },
];
