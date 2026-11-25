import type { MigrationFile } from "../migrate.js";
import { P11B_MIGRATIONS } from "./v01-v10.js";

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
