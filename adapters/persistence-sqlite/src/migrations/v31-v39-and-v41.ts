import type { MigrationFile } from "../migrate.js";
import { P38_EXECUTABLE_APPROVAL_MIGRATION } from "../executable-approval-migration.js";
import { P39_RECONCILIATION_DDL } from "../reconciliation-ddl.js";
import { P36_TOOL_INVOCATION_ADMISSION_DDL } from "./v01-v10.js";
import { P30_MIGRATIONS } from "./v21-v30.js";

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

/** AH7-DG-02 P39 owner migration descriptor. It is applied by the privileged
 * maintenance path after the P37/P38 descriptors; the P39 runtime remains
 * stopped at version 39 until P40 is available. */
export const P39_RECONCILIATION_MIGRATION: MigrationFile = {
  id: 39,
  name: "ah7_reconciliation_attempts",
  sql: P39_RECONCILIATION_DDL,
  foreignKeysOff: true,
};

/** AH7-DG-03 accepted forward migration; preserves legacy rows as
 * LegacyUnknown and advances the production SQLite baseline to user_version 36. */
export const P36_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P35_MIGRATIONS.filter((migration) => migration.id !== 36),
  {
    id: 36,
    name: "ah7_tool_invocation_admission",
    sql: P36_TOOL_INVOCATION_ADMISSION_DDL,
    foreignKeysOff: true,
  },
];

/** AH10 DeliverReplay durable fact, projection marker and fair Attention poll
 * state; user_version 37. This is forward-only after P36. */
export const P37_DELIVER_REPLAY_DDL = `
CREATE TABLE deliver_replay_attention_facts (
  attention_fact_id       TEXT PRIMARY KEY,
  event_id                TEXT NOT NULL UNIQUE,
  project_id              TEXT NOT NULL,
  execution_id            TEXT NOT NULL,
  target_workspace_id     TEXT NOT NULL,
  logical_action_id       TEXT NOT NULL,
  message_id              TEXT NOT NULL,
  failure_code            TEXT NOT NULL CHECK (failure_code IN (
    'LegacyMessageMissingEvent','LegacyEventMissingMessage',
    'LegacyMessageBindingMismatch','LegacyInboxConflict',
    'PriorReceiptDecodeMismatch','PriorReceiptResultMismatch',
    'RejectedReceiptEffectConflict','PriorReceiptEffectConflict'
  )),
  first_detected_at       TEXT NOT NULL,
  UNIQUE (execution_id, logical_action_id, message_id),
  UNIQUE (attention_fact_id, project_id),
  FOREIGN KEY (execution_id, project_id, target_workspace_id)
    REFERENCES executions(execution_id, project_id, workspace_id)
);
CREATE INDEX deliver_replay_attention_target
  ON deliver_replay_attention_facts(project_id, target_workspace_id, first_detected_at);
CREATE INDEX deliver_replay_attention_project_fact
  ON deliver_replay_attention_facts(project_id, attention_fact_id);

CREATE TABLE deliver_replay_attention_pending (
  queue_sequence     INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id         TEXT NOT NULL,
  attention_fact_id  TEXT NOT NULL UNIQUE,
  enqueued_at        TEXT NOT NULL,
  FOREIGN KEY (attention_fact_id, project_id)
    REFERENCES deliver_replay_attention_facts(attention_fact_id, project_id)
);
CREATE INDEX deliver_replay_attention_pending_project_order
  ON deliver_replay_attention_pending(project_id, queue_sequence);

CREATE TABLE deliver_replay_attention_rows (
  attention_fact_id TEXT PRIMARY KEY
    REFERENCES deliver_replay_attention_facts(attention_fact_id)
);

CREATE TRIGGER deliver_replay_pending_delete_requires_marker
BEFORE DELETE ON deliver_replay_attention_pending
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM deliver_replay_attention_rows
   WHERE attention_fact_id = OLD.attention_fact_id
)
BEGIN
  SELECT RAISE(ABORT, 'DeliverReplay pending item requires a P10 marker');
END;

CREATE TABLE p10_attention_project_poll_state (
  project_id                    TEXT PRIMARY KEY,
  last_attempt_sequence          INTEGER NOT NULL DEFAULT 0 CHECK (last_attempt_sequence >= 0),
  consecutive_failed_attempts   INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failed_attempts >= 0),
  next_eligible_at               TEXT NOT NULL,
  last_failure_code              TEXT CHECK (last_failure_code IS NULL OR last_failure_code IN (
    'PollLeaseExpired','JournalIdentityUnprovable','MissingP9Fact',
    'FactTupleMismatch','FactProjectMismatch','EventBindingMismatch',
    'QueueFactMismatch','MarkerBindingMismatch','QueueDeleteWithoutMarker'
  )),
  last_failure_at                 TEXT
);
CREATE INDEX p10_attention_project_due
  ON p10_attention_project_poll_state(next_eligible_at,last_attempt_sequence,project_id);
CREATE TABLE p10_attention_dispatch_state (
  singleton                INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_attempt_sequence    INTEGER NOT NULL CHECK (next_attempt_sequence >= 1),
  active_project_id        TEXT,
  lease_owner              TEXT,
  lease_generation         INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  claim_started_at         TEXT,
  lease_expires_at         TEXT,
  CHECK ((active_project_id IS NULL) = (lease_owner IS NULL)),
  CHECK ((lease_owner IS NULL) = (claim_started_at IS NULL)),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);
INSERT INTO p10_attention_dispatch_state(singleton,next_attempt_sequence)
VALUES (1,1);
`;

export const P37_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P36_MIGRATIONS,
  {
    id: 37,
    name: "ah10_deliver_replay_attention_rows",
    sql: P37_DELIVER_REPLAY_DDL,
  },
];

/** EA-DG-01 P38 forward migration. P37/0037 must already be present in the
 * cumulative prefix; the runner preserves the accepted FK-off rebuild. */
export const P38_MIGRATIONS: ReadonlyArray<MigrationFile> = [
  ...P37_MIGRATIONS,
  {
    id: P38_EXECUTABLE_APPROVAL_MIGRATION.migrationVersion,
    name: "executable_approval_handoff",
    sql: P38_EXECUTABLE_APPROVAL_MIGRATION.sql,
    foreignKeysOff: P38_EXECUTABLE_APPROVAL_MIGRATION.foreignKeysOff,
  },
];

/** P41 / 0041 physical storage descriptor; its exact cumulative predecessor
 * is enforced by requiresUserVersion before the descriptor transaction. */
export const P41_SUBMITTED_DECISION_BINDING_ATTENTION_DDL = `
CREATE TABLE submitted_decision_binding_attention_facts (
  attention_fact_id TEXT NOT NULL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  logical_step_no INTEGER NOT NULL CHECK (logical_step_no >= 0),
  repair_attempt INTEGER NOT NULL CHECK (repair_attempt >= 0),
  provider_turn_id TEXT NOT NULL,
  logical_action_id TEXT NOT NULL,
  failure_code TEXT NOT NULL CHECK (failure_code IN (
    'DecisionRequestWorkspaceMismatch',
    'StepManifestMismatch',
    'SettledExecutionWithPendingDecisionAction'
  )),
  first_detected_at TEXT NOT NULL,
  UNIQUE (execution_id, logical_step_no, repair_attempt, logical_action_id),
  UNIQUE (attention_fact_id, project_id, workspace_id),
  FOREIGN KEY (execution_id, project_id, workspace_id)
    REFERENCES executions(execution_id, project_id, workspace_id)
);

CREATE INDEX submitted_decision_binding_fact_project_time
  ON submitted_decision_binding_attention_facts
    (project_id, first_detected_at, attention_fact_id);

CREATE TRIGGER submitted_decision_binding_fact_no_update
BEFORE UPDATE ON submitted_decision_binding_attention_facts
BEGIN
  SELECT RAISE(ABORT, 'submitted decision binding facts are immutable');
END;

CREATE TRIGGER submitted_decision_binding_fact_no_delete
BEFORE DELETE ON submitted_decision_binding_attention_facts
BEGIN
  SELECT RAISE(ABORT, 'submitted decision binding facts are retained');
END;

CREATE TABLE submitted_decision_binding_attention_rows (
  project_id TEXT NOT NULL,
  attention_fact_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  PRIMARY KEY (project_id, attention_fact_id),
  FOREIGN KEY (attention_fact_id, project_id, workspace_id)
    REFERENCES submitted_decision_binding_attention_facts
      (attention_fact_id, project_id, workspace_id)
);
`;

/** Fingerprint of LF UTF-8 descriptor lines: 41, migration name, DDL SHA-256. */
export const P41_SUBMITTED_DECISION_BINDING_ATTENTION_FINGERPRINT =
  "1c4b30b9fc08569c8b50a9333ea115562a2ac93ee81cc869cda97d5fe75149a1";

export const P41_SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION: MigrationFile =
  {
    id: 41,
    name: "p41_submitted_decision_binding_attention",
    sql: P41_SUBMITTED_DECISION_BINDING_ATTENTION_DDL,
    requiresUserVersion: 40,
  };
/** Trusted maintenance-only suffix. IDs and SQL pins are ordered after P36;
 * schema 39 is never part of ordinary runtime migration registration. */
export const P39_MAINTENANCE_MIGRATIONS: ReadonlyArray<MigrationFile> =
  Object.freeze([
    ...P37_MIGRATIONS.filter(({ id }) => id === 37).map((migration) =>
      Object.freeze(migration),
    ),
    ...P38_MIGRATIONS.filter(({ id }) => id === 38).map((migration) =>
      Object.freeze(migration),
    ),
    Object.freeze(P39_RECONCILIATION_MIGRATION),
  ]);

/** Pin every executable SQL body in the privileged migration path. */
export const P39_MAINTENANCE_MIGRATION_MANIFEST: Readonly<
  Record<number, { readonly name: string; readonly sha256: string }>
> = Object.freeze({
  37: Object.freeze({
    name: "ah10_deliver_replay_attention_rows",
    sha256: "0d23988891b3a19a36b6a836a9697d674667681dde2123be4dcae6659e39e737",
  }),
  38: Object.freeze({
    name: "executable_approval_handoff",
    sha256: "fa109e056d88c49dada808a7b0bcc9edce4595d1812990c0fa4facd0b248110d",
  }),
  39: Object.freeze({
    name: "ah7_reconciliation_attempts",
    sha256: "6e791168987f23f5c282ce7d6bd2c5b5ad8361942dab968adbcca64aab753aec",
  }),
});
