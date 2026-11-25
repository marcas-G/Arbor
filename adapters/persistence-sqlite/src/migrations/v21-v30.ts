import type { MigrationFile } from "../migrate.js";
import { P20_MIGRATIONS } from "./v11-v20.js";

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
