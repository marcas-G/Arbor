/** P38 EA-DG-01 migration body. Deliberately not included in
 * P4_MIGRATIONS/P36_MIGRATIONS until the 0037 prerequisite is integrated. The
 * runner must set foreign_keys=OFF before its migration transaction because
 * 0033 assigns a composite FK to action_approvals(approval_id, project_id). */
export const P38_EXECUTABLE_APPROVAL_MIGRATION = {
  migrationVersion: 38,
  requiresUserVersion: 37,
  foreignKeysOff: true,
  sql: `
CREATE TABLE action_approvals_p38 (
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
    ('Pending','Approved','Rejected','Consumed','Expired','Cancelled')),
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
  logical_step_no INTEGER,
  repair_attempt INTEGER,
  action_index INTEGER,
  logical_action_id TEXT,
  call_ref TEXT,
  tool_invocation_id TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancellation_reason TEXT,
  CHECK ((decided_at IS NULL) = (decided_by IS NULL)),
  CHECK (state NOT IN ('Approved','Rejected','Consumed') OR
    (decided_at IS NOT NULL AND decided_by IS NOT NULL)),
  CHECK (state != 'Pending' OR
    (decided_at IS NULL AND decided_by IS NULL AND decision_reason IS NULL AND
     consumed_at IS NULL AND consumed_by IS NULL AND cancelled_at IS NULL AND
     cancelled_by IS NULL AND cancellation_reason IS NULL)),
  CHECK ((consumed_at IS NULL) = (consumed_by IS NULL)),
  CHECK ((state = 'Consumed') = (consumed_at IS NOT NULL)),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL)),
  CHECK ((cancelled_at IS NULL) = (cancellation_reason IS NULL)),
  CHECK (state != 'Cancelled' OR
    (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND
     cancellation_reason IS NOT NULL)),
  CHECK (state = 'Cancelled' OR cancelled_at IS NULL),
  CHECK (route_kind != 'Executable' OR binding_proven != 0 OR
    (state IN ('Expired','Consumed') AND logical_step_no IS NULL AND
     repair_attempt IS NULL AND action_index IS NULL AND logical_action_id IS NULL AND
     call_ref IS NULL AND tool_invocation_id IS NULL)),
  CHECK (route_kind != 'Executable' OR binding_proven != 1 OR
    (project_id IS NOT NULL AND workspace_id IS NOT NULL AND execution_id IS NOT NULL AND
     logical_step_no IS NOT NULL AND logical_step_no >= 0 AND
     repair_attempt IS NOT NULL AND repair_attempt >= 0 AND
     action_index IS NOT NULL AND action_index >= 0 AND
     logical_action_id IS NOT NULL AND call_ref IS NOT NULL AND
     tool_invocation_id IS NOT NULL)),
  CHECK (route_kind != 'Control' OR
    (logical_step_no IS NULL AND repair_attempt IS NULL AND action_index IS NULL AND
     logical_action_id IS NULL AND call_ref IS NULL AND tool_invocation_id IS NULL))
);

INSERT INTO action_approvals_p38 (
  approval_id, route_kind, project_id, workspace_id, execution_id,
  subject_ref, stable_action_id, action_version, side_effect_semantics,
  action_digest, arguments_json, target_ref, target_resource_space_ids_json,
  control_basis_digest, state, revision, requested_at, expires_at, decided_at,
  decided_by, decision_reason, consumed_at, consumed_by, binding_proven,
  source_state, logical_step_no, repair_attempt, action_index, logical_action_id,
  call_ref, tool_invocation_id, cancelled_at, cancelled_by, cancellation_reason
)
SELECT approval_id, route_kind, project_id, workspace_id, execution_id,
  subject_ref, stable_action_id, action_version, side_effect_semantics,
  action_digest, arguments_json, target_ref, target_resource_space_ids_json,
  control_basis_digest, state, revision, requested_at, expires_at, decided_at,
  decided_by, decision_reason, consumed_at, consumed_by, binding_proven,
  source_state, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
FROM action_approvals;

DROP INDEX action_approvals_exact_action;
DROP INDEX action_approvals_pending;
DROP INDEX action_approvals_id_project;
DROP TABLE action_approvals;
ALTER TABLE action_approvals_p38 RENAME TO action_approvals;

CREATE UNIQUE INDEX action_approvals_control_exact_action
  ON action_approvals(execution_id, action_digest, control_basis_digest)
  WHERE route_kind = 'Control' AND execution_id IS NOT NULL;
CREATE UNIQUE INDEX action_approvals_executable_logical_action
  ON action_approvals(execution_id, logical_step_no, repair_attempt,
                      action_index, logical_action_id)
  WHERE route_kind = 'Executable' AND binding_proven = 1;
CREATE UNIQUE INDEX action_approvals_id_project
  ON action_approvals(approval_id, project_id);
CREATE INDEX action_approvals_pending
  ON action_approvals(workspace_id, state, requested_at);
`,
} as const;
