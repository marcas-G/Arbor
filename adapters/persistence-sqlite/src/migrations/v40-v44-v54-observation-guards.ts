import type { MigrationFile } from "../migrate.js";

/** P40 owner DDL; the descriptor below is executable only after trusted P39
 * maintenance has committed version 39. */
const P40_VALID_ARTIFACT_REF_SQL = `
length(NEW.result_ref) = 40 AND substr(NEW.result_ref, 1, 4) = 'art_' AND
substr(NEW.result_ref, 13, 1) = '-' AND substr(NEW.result_ref, 18, 1) = '-' AND
substr(NEW.result_ref, 23, 1) = '-' AND substr(NEW.result_ref, 28, 1) = '-' AND
lower(substr(NEW.result_ref, 5, 8)) NOT GLOB '*[^0-9a-f]*' AND
lower(substr(NEW.result_ref, 14, 4)) NOT GLOB '*[^0-9a-f]*' AND
lower(substr(NEW.result_ref, 19, 4)) NOT GLOB '*[^0-9a-f]*' AND
lower(substr(NEW.result_ref, 24, 4)) NOT GLOB '*[^0-9a-f]*' AND
lower(substr(NEW.result_ref, 29, 12)) NOT GLOB '*[^0-9a-f]*' AND
substr(NEW.result_ref, 19, 1) = '7' AND
lower(substr(NEW.result_ref, 24, 1)) IN ('8','9','a','b')`;

const P40_SETTLEMENT_PROVENANCE_SQL = `(
  (NEW.settlement_provenance = 'Ordinary'
   AND NEW.selected_attempt_no IS NULL AND NEW.selected_fact_id IS NULL)
  OR
  (NEW.settlement_provenance = 'Reconciliation'
   AND NEW.recovery_binding_state = 'Bound'
   AND NEW.recovery_binding_sha256 IS NOT NULL
   AND NEW.selected_attempt_no IS NOT NULL AND NEW.selected_fact_id IS NOT NULL)
)`;

export const P40_TOOL_OBSERVATION_REPLAY_DDL = `
ALTER TABLE tool_invocations ADD COLUMN observation_format_version TEXT
  CHECK (observation_format_version IS NULL OR
         observation_format_version = 'p4-canonical-tool-observation-v1');
ALTER TABLE tool_invocations ADD COLUMN observation_json BLOB
  CHECK (observation_json IS NULL OR
         (typeof(observation_json) = 'blob'
          AND length(observation_json) BETWEEN 1 AND 16384
          AND json_valid(CAST(observation_json AS TEXT))));
ALTER TABLE tool_invocations ADD COLUMN observation_sha256 TEXT
  CHECK (observation_sha256 IS NULL OR
         (length(observation_sha256) = 64
          AND observation_sha256 NOT GLOB '*[^0-9a-f]*'));

CREATE TRIGGER tool_invocations_observation_insert_guard
BEFORE INSERT ON tool_invocations
WHEN COALESCE(CASE
  WHEN NEW.settled_at IS NULL THEN
    NEW.settlement_kind IS NOT NULL OR NEW.settlement_json IS NOT NULL OR
    NEW.result_ref IS NOT NULL OR NEW.observation_format_version IS NOT NULL OR
    NEW.observation_json IS NOT NULL OR NEW.observation_sha256 IS NOT NULL
  WHEN NEW.settlement_kind = 'Denied' THEN NOT (
    NEW.effect_admission_state = 'NotAdmitted' AND NEW.result_ref IS NULL AND
    NEW.observation_format_version IS NULL AND NEW.observation_json IS NULL AND
    NEW.observation_sha256 IS NULL AND json_valid(NEW.settlement_json) AND
    json_extract(NEW.settlement_json, '$._tag') = 'Denied' AND
    json_extract(NEW.settlement_json, '$.projectionVersion') = 1 AND
    json_type(NEW.settlement_json, '$.reasonCode') = 'text' AND
    json_extract(NEW.settlement_json, '$.reasonCode') IN (
      'InvocationAuthorityDenied','ApprovalRequired','ApprovalNotFound',
      'ApprovalMismatch','ApprovalExpired','ApprovalConsumedByOtherInvocation',
      'ResourceResolutionDenied','ResourceAdmissionDenied','ApprovalNoLongerAuthorized'
    )
  )
  WHEN NEW.settlement_kind IN
    ('Success','ExpectedFailure','Interrupted','OutcomeUnknown','RuntimeFailure','ReconciledNoEffect')
  THEN NOT (
    NEW.settlement_json IS NOT NULL AND
    NEW.observation_format_version = 'p4-canonical-tool-observation-v1' AND
    NEW.observation_json IS NOT NULL AND NEW.observation_sha256 IS NOT NULL AND
    json_valid(NEW.settlement_json) AND
    json_valid(CAST(NEW.observation_json AS TEXT)) AND
    json_extract(NEW.settlement_json, '$._tag') = NEW.settlement_kind AND
    json_extract(CAST(NEW.observation_json AS TEXT), '$._tag') = NEW.settlement_kind AND
    CASE NEW.settlement_kind
      WHEN 'Success' THEN
        NEW.effect_admission_state = 'MayHaveStarted' AND
        ${P40_SETTLEMENT_PROVENANCE_SQL} AND
        json_type(CAST(NEW.observation_json AS TEXT), '$.observation.text') = 'text' AND
        json_type(CAST(NEW.observation_json AS TEXT), '$.observation.truncated') IN ('true','false') AND
        ((NEW.result_ref IS NULL AND
          json_type(CAST(NEW.observation_json AS TEXT), '$.resultRef') IS 'null') OR
         (NEW.result_ref IS NOT NULL AND
          json_type(CAST(NEW.observation_json AS TEXT), '$.resultRef') = 'text' AND
          json_extract(CAST(NEW.observation_json AS TEXT), '$.resultRef') = NEW.result_ref AND
          ${P40_VALID_ARTIFACT_REF_SQL}))
      WHEN 'ExpectedFailure' THEN
        NEW.effect_admission_state = 'MayHaveStarted' AND
        ${P40_SETTLEMENT_PROVENANCE_SQL} AND
        NEW.result_ref IS NULL AND
        json_type(CAST(NEW.observation_json AS TEXT), '$.observation.text') = 'text' AND
        json_type(CAST(NEW.observation_json AS TEXT), '$.observation.truncated') IN ('true','false')
      WHEN 'Interrupted' THEN
        NEW.effect_admission_state IN ('NotAdmitted','MayHaveStarted') AND
        NEW.settlement_provenance = 'Ordinary' AND
        NEW.selected_attempt_no IS NULL AND NEW.selected_fact_id IS NULL AND
        NEW.result_ref IS NULL
      WHEN 'OutcomeUnknown' THEN
        NEW.effect_admission_state = 'MayHaveStarted' AND
        NEW.settlement_provenance = 'Ordinary' AND
        NEW.selected_attempt_no IS NULL AND NEW.selected_fact_id IS NULL AND
        NEW.result_ref IS NULL AND
        json_type(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs') = 'array' AND
        json_array_length(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs') BETWEEN 1 AND 8 AND
        NOT EXISTS (
          SELECT 1 FROM json_each(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs')
           WHERE type <> 'text' OR length(CAST(value AS BLOB)) NOT BETWEEN 1 AND 128
        ) AND
        json(json_extract(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs')) =
          json(json_extract(NEW.settlement_json, '$.reconciliationRefs'))
      WHEN 'RuntimeFailure' THEN
        NEW.effect_admission_state = 'MayHaveStarted' AND
        NEW.settlement_provenance = 'Ordinary' AND
        NEW.selected_attempt_no IS NULL AND NEW.selected_fact_id IS NULL AND
        NEW.result_ref IS NULL AND
        json_type(CAST(NEW.observation_json AS TEXT), '$.cause') = 'text' AND
        length(CAST(json_extract(CAST(NEW.observation_json AS TEXT), '$.cause') AS BLOB)) <= 1024 AND
        json_extract(CAST(NEW.observation_json AS TEXT), '$.cause') =
          json_extract(NEW.settlement_json, '$.cause')
      WHEN 'ReconciledNoEffect' THEN
        NEW.settlement_provenance = 'Reconciliation' AND
        NEW.effect_admission_state = 'MayHaveStarted' AND
        NEW.recovery_binding_state = 'Bound' AND
        NEW.recovery_binding_sha256 IS NOT NULL AND
        NEW.selected_attempt_no IS NOT NULL AND NEW.selected_fact_id IS NOT NULL AND
        NEW.result_ref IS NOT NULL AND
        json_extract(NEW.settlement_json, '$.reasonCode') IN (
          'AuthoritySnapshotChanged','ResourceSnapshotChanged',
          'ApprovalNoLongerAuthorized','StopRequested','ReplayLimitReached'
        ) AND
        json_extract(CAST(NEW.observation_json AS TEXT), '$.reasonCode') =
          json_extract(NEW.settlement_json, '$.reasonCode') AND
        json_extract(NEW.settlement_json, '$.reconciliationFactRef') = NEW.selected_fact_id AND
        json_extract(CAST(NEW.observation_json AS TEXT), '$.reconciliationFactRef') = NEW.selected_fact_id AND
        json_type(CAST(NEW.observation_json AS TEXT), '$.observation.text') = 'text' AND
        json_type(CAST(NEW.observation_json AS TEXT), '$.observation.truncated') IN ('true','false') AND
        json_type(CAST(NEW.observation_json AS TEXT), '$.resultRef') = 'text' AND
        json_extract(CAST(NEW.observation_json AS TEXT), '$.resultRef') = NEW.result_ref AND
        ${P40_VALID_ARTIFACT_REF_SQL} AND
        EXISTS (
          SELECT 1 FROM tool_reconciliation_facts AS f
           WHERE f.fact_id = NEW.selected_fact_id
             AND f.invocation_id = NEW.invocation_id
             AND f.attempt_no = NEW.selected_attempt_no
             AND f.fact_origin = 'ProfileReconciliation'
             AND f.fact_disposition = 'RecoveryInput'
             AND f.binding_sha256 = NEW.recovery_binding_sha256
             AND f.outcome = 'NotOccurred' AND f.reason_code IS NULL
             AND f.evidence_ref IS NOT NULL AND f.evidence_sha256 IS NOT NULL
             AND length(f.evidence_sha256) = 64
             AND f.evidence_sha256 NOT GLOB '*[^0-9a-f]*'
             AND f.result_ref IS NULL
        )
      ELSE 0
    END
  )
  ELSE 1
END, 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'invalid P40 tool observation evidence');
END;

CREATE TRIGGER tool_invocations_observation_update_guard
BEFORE UPDATE ON tool_invocations
WHEN (OLD.settled_at IS NULL AND COALESCE(CASE
  WHEN NEW.settled_at IS NULL THEN
    NEW.settlement_kind IS NOT NULL OR NEW.settlement_json IS NOT NULL OR
    NEW.result_ref IS NOT NULL OR NEW.observation_format_version IS NOT NULL OR
    NEW.observation_json IS NOT NULL OR NEW.observation_sha256 IS NOT NULL
  WHEN NEW.settlement_kind = 'Denied' THEN NOT (
    NEW.effect_admission_state = 'NotAdmitted' AND NEW.result_ref IS NULL AND
    NEW.observation_format_version IS NULL AND NEW.observation_json IS NULL AND
    NEW.observation_sha256 IS NULL AND json_valid(NEW.settlement_json) AND
    json_extract(NEW.settlement_json, '$._tag') = 'Denied' AND
    json_extract(NEW.settlement_json, '$.projectionVersion') = 1 AND
    json_type(NEW.settlement_json, '$.reasonCode') = 'text' AND
    json_extract(NEW.settlement_json, '$.reasonCode') IN (
      'InvocationAuthorityDenied','ApprovalRequired','ApprovalNotFound',
      'ApprovalMismatch','ApprovalExpired','ApprovalConsumedByOtherInvocation',
      'ResourceResolutionDenied','ResourceAdmissionDenied','ApprovalNoLongerAuthorized'
    )
  )
  WHEN NEW.settlement_kind IN
    ('Success','ExpectedFailure','Interrupted','OutcomeUnknown','RuntimeFailure','ReconciledNoEffect')
  THEN NOT (
    NEW.settlement_json IS NOT NULL AND
    NEW.observation_format_version = 'p4-canonical-tool-observation-v1' AND
    NEW.observation_json IS NOT NULL AND NEW.observation_sha256 IS NOT NULL AND
    json_valid(NEW.settlement_json) AND
    json_valid(CAST(NEW.observation_json AS TEXT)) AND
    json_extract(NEW.settlement_json, '$._tag') = NEW.settlement_kind AND
    json_extract(CAST(NEW.observation_json AS TEXT), '$._tag') = NEW.settlement_kind AND
    CASE NEW.settlement_kind
      WHEN 'Success' THEN
        NEW.effect_admission_state = 'MayHaveStarted' AND
        ${P40_SETTLEMENT_PROVENANCE_SQL} AND
        json_type(CAST(NEW.observation_json AS TEXT), '$.observation.text') = 'text' AND
        json_type(CAST(NEW.observation_json AS TEXT), '$.observation.truncated') IN ('true','false') AND
        ((NEW.result_ref IS NULL AND json_type(CAST(NEW.observation_json AS TEXT), '$.resultRef') IS 'null') OR
         (NEW.result_ref IS NOT NULL AND json_extract(CAST(NEW.observation_json AS TEXT), '$.resultRef') = NEW.result_ref AND
          ${P40_VALID_ARTIFACT_REF_SQL}))
      WHEN 'ExpectedFailure' THEN NEW.effect_admission_state = 'MayHaveStarted' AND
        ${P40_SETTLEMENT_PROVENANCE_SQL} AND NEW.result_ref IS NULL AND
        json_type(CAST(NEW.observation_json AS TEXT), '$.observation.text') = 'text' AND
        json_type(CAST(NEW.observation_json AS TEXT), '$.observation.truncated') IN ('true','false')
      WHEN 'Interrupted' THEN NEW.effect_admission_state IN ('NotAdmitted','MayHaveStarted') AND
        NEW.settlement_provenance = 'Ordinary' AND NEW.selected_attempt_no IS NULL AND
        NEW.selected_fact_id IS NULL AND NEW.result_ref IS NULL
      WHEN 'OutcomeUnknown' THEN NEW.effect_admission_state = 'MayHaveStarted' AND
        NEW.settlement_provenance = 'Ordinary' AND NEW.selected_attempt_no IS NULL AND
        NEW.selected_fact_id IS NULL AND NEW.result_ref IS NULL AND
        json_type(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs') = 'array' AND
        json_array_length(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs') BETWEEN 1 AND 8 AND
        NOT EXISTS (SELECT 1 FROM json_each(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs')
          WHERE type <> 'text' OR length(CAST(value AS BLOB)) NOT BETWEEN 1 AND 128) AND
        json(json_extract(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs')) =
        json(json_extract(NEW.settlement_json, '$.reconciliationRefs'))
      WHEN 'RuntimeFailure' THEN NEW.effect_admission_state = 'MayHaveStarted' AND
        NEW.settlement_provenance = 'Ordinary' AND NEW.selected_attempt_no IS NULL AND
        NEW.selected_fact_id IS NULL AND NEW.result_ref IS NULL AND
        json_type(CAST(NEW.observation_json AS TEXT), '$.cause') = 'text' AND
        length(CAST(json_extract(CAST(NEW.observation_json AS TEXT), '$.cause') AS BLOB)) <= 1024 AND
        json_extract(CAST(NEW.observation_json AS TEXT), '$.cause') = json_extract(NEW.settlement_json, '$.cause')
      WHEN 'ReconciledNoEffect' THEN
        NEW.settlement_provenance = 'Reconciliation' AND
        NEW.effect_admission_state = 'MayHaveStarted' AND NEW.recovery_binding_state = 'Bound' AND
        NEW.recovery_binding_sha256 IS NOT NULL AND NEW.selected_attempt_no IS NOT NULL AND
        NEW.selected_fact_id IS NOT NULL AND NEW.result_ref IS NOT NULL AND
        json_extract(NEW.settlement_json, '$.reasonCode') IN (
          'AuthoritySnapshotChanged','ResourceSnapshotChanged',
          'ApprovalNoLongerAuthorized','StopRequested','ReplayLimitReached') AND
        json_extract(CAST(NEW.observation_json AS TEXT), '$.reasonCode') =
          json_extract(NEW.settlement_json, '$.reasonCode') AND
        json_extract(NEW.settlement_json, '$.reconciliationFactRef') = NEW.selected_fact_id AND
        json_extract(CAST(NEW.observation_json AS TEXT), '$.reconciliationFactRef') = NEW.selected_fact_id AND
        json_type(CAST(NEW.observation_json AS TEXT), '$.observation.text') = 'text' AND
        json_type(CAST(NEW.observation_json AS TEXT), '$.observation.truncated') IN ('true','false') AND
        json_extract(CAST(NEW.observation_json AS TEXT), '$.resultRef') = NEW.result_ref AND
        EXISTS (SELECT 1 FROM tool_reconciliation_facts f
          WHERE f.fact_id = NEW.selected_fact_id AND f.invocation_id = NEW.invocation_id
            AND f.attempt_no = NEW.selected_attempt_no AND f.fact_origin = 'ProfileReconciliation'
            AND f.fact_disposition = 'RecoveryInput' AND f.binding_sha256 = NEW.recovery_binding_sha256
            AND f.outcome = 'NotOccurred' AND f.reason_code IS NULL
            AND f.evidence_ref IS NOT NULL AND f.evidence_sha256 IS NOT NULL
            AND length(f.evidence_sha256) = 64
            AND f.evidence_sha256 NOT GLOB '*[^0-9a-f]*' AND f.result_ref IS NULL)
      ELSE 0
    END
  )
  ELSE 1
END, 1) = 1)
OR (OLD.settled_at IS NOT NULL AND (
  NEW.invocation_id IS NOT OLD.invocation_id OR
  NEW.execution_id IS NOT OLD.execution_id OR
  NEW.workspace_id IS NOT OLD.workspace_id OR
  NEW.tool_name IS NOT OLD.tool_name OR
  NEW.tool_version IS NOT OLD.tool_version OR
  NEW.side_effect_semantics IS NOT OLD.side_effect_semantics OR
  NEW.arguments_json IS NOT OLD.arguments_json OR
  NEW.resolved_regions_json IS NOT OLD.resolved_regions_json OR
  NEW.approval_id IS NOT OLD.approval_id OR
  NEW.effect_admission_state IS NOT OLD.effect_admission_state OR
  NEW.intent_at IS NOT OLD.intent_at OR
  NEW.settled_at IS NOT OLD.settled_at OR
  NEW.settlement_kind IS NOT OLD.settlement_kind OR
  NEW.settlement_json IS NOT OLD.settlement_json OR
  NEW.result_ref IS NOT OLD.result_ref OR
  NEW.observation_format_version IS NOT OLD.observation_format_version OR
  NEW.observation_json IS NOT OLD.observation_json OR
  NEW.observation_sha256 IS NOT OLD.observation_sha256 OR
  NEW.settlement_provenance IS NOT OLD.settlement_provenance OR
  NEW.recovery_binding_state IS NOT OLD.recovery_binding_state OR
  NEW.recovery_binding_sha256 IS NOT OLD.recovery_binding_sha256 OR
  NEW.selected_attempt_no IS NOT OLD.selected_attempt_no OR
  NEW.selected_fact_id IS NOT OLD.selected_fact_id
))
BEGIN
  SELECT RAISE(ABORT, 'invalid or immutable P40 tool observation evidence');
END;

CREATE TABLE tool_observation_replay_attention_facts (
  attention_fact_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES domain_events(event_id),
  project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  target_workspace_id TEXT NOT NULL,
  logical_action_id TEXT NOT NULL,
  provider_turn_id TEXT NOT NULL,
  call_ref TEXT NOT NULL,
  invocation_id TEXT NOT NULL REFERENCES tool_invocations(invocation_id),
  failure_code TEXT NOT NULL CHECK (failure_code IN (
    'Missing','UnsupportedVersion','Malformed','HashMismatch',
    'SettlementMismatch','IntentMismatch','ResultRefMismatch','UnexpectedResultRef'
  )),
  first_detected_at TEXT NOT NULL,
  UNIQUE (execution_id, invocation_id),
  UNIQUE (attention_fact_id, project_id, target_workspace_id, event_id),
  FOREIGN KEY (execution_id, project_id, target_workspace_id)
    REFERENCES executions(execution_id, project_id, workspace_id)
);
CREATE INDEX tool_observation_replay_fact_target
  ON tool_observation_replay_attention_facts
    (project_id, target_workspace_id, first_detected_at);
CREATE TRIGGER tool_observation_replay_attention_fact_no_update
BEFORE UPDATE ON tool_observation_replay_attention_facts
BEGIN SELECT RAISE(ABORT, 'tool observation replay facts are immutable'); END;
CREATE TRIGGER tool_observation_replay_attention_fact_no_delete
BEFORE DELETE ON tool_observation_replay_attention_facts
BEGIN SELECT RAISE(ABORT, 'tool observation replay facts are retained'); END;

CREATE TABLE tool_observation_replay_attention_rows (
  project_id TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'ToolObservationReplayEvidenceFailure'
    CHECK (source = 'ToolObservationReplayEvidenceFailure'),
  severity TEXT NOT NULL DEFAULT 'ActionRequired' CHECK (severity = 'ActionRequired'),
  target_workspace_id TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT 'A terminal tool outcome could not be replayed from durable observation evidence; recovery is paused.'
    CHECK (summary = 'A terminal tool outcome could not be replayed from durable observation evidence; recovery is paused.'),
  failure_code TEXT NOT NULL CHECK (failure_code IN (
    'Missing','UnsupportedVersion','Malformed','HashMismatch',
    'SettlementMismatch','IntentMismatch','ResultRefMismatch','UnexpectedResultRef'
  )),
  occurred_at TEXT NOT NULL,
  source_event_id TEXT NOT NULL UNIQUE REFERENCES domain_events(event_id),
  source_fact_id TEXT NOT NULL,
  PRIMARY KEY (project_id, dedup_key),
  CHECK (dedup_key = source_fact_id),
  FOREIGN KEY (source_fact_id, project_id, target_workspace_id, source_event_id)
    REFERENCES tool_observation_replay_attention_facts
      (attention_fact_id, project_id, target_workspace_id, event_id),
  FOREIGN KEY (target_workspace_id, project_id)
    REFERENCES workspaces(workspace_id, project_id)
);
CREATE INDEX tool_observation_replay_row_target
  ON tool_observation_replay_attention_rows
    (project_id, target_workspace_id, occurred_at);
`;

export const P40_TOOL_OBSERVATION_REPLAY_MIGRATION: MigrationFile = {
  id: 40,
  name: "tool_observation_replay_evidence",
  sql: P40_TOOL_OBSERVATION_REPLAY_DDL,
  requiresUserVersion: 39,
};

const p40InvocationObservationGuardsForP44 = (() => {
  const startMarker =
    "CREATE TRIGGER tool_invocations_observation_insert_guard";
  const endMarker = "CREATE TABLE tool_observation_replay_attention_facts";
  const start = P40_TOOL_OBSERVATION_REPLAY_DDL.indexOf(startMarker);
  const end = P40_TOOL_OBSERVATION_REPLAY_DDL.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error("P40 invocation observation guards are unavailable.");
  }
  const source = P40_TOOL_OBSERVATION_REPLAY_DDL.slice(start, end).trim();
  const oldAllowlistEntry =
    "'InvocationAuthorityDenied','ApprovalRequired','ApprovalNotFound',";
  if (source.split(oldAllowlistEntry).length - 1 !== 2) {
    throw new Error("P40 Denied guard shape changed; refusing P44 derivation.");
  }
  return source.replaceAll(
    oldAllowlistEntry,
    "'InvocationAuthorityDenied','ApprovalRequired','ApprovalRejected','ApprovalNotFound',",
  );
})();

/** P4 approval rejection is a frozen terminal no-effect Denied outcome. This
 * one-way repair preserves the P40 trigger predicates and adds only its reason
 * code. */
export const P44_APPROVAL_REJECTED_NO_EFFECT_DENIAL_MIGRATION = {
  id: 44,
  name: "approval_rejected_no_effect_denial",
  requiresUserVersion: 43,
  sql: `
DROP TRIGGER tool_invocations_observation_insert_guard;
DROP TRIGGER tool_invocations_observation_update_guard;
${p40InvocationObservationGuardsForP44}
`,
} satisfies MigrationFile & { readonly requiresUserVersion: 43 };

const p40InvocationObservationGuardsForP54 = (() => {
  const allowlist =
    "'ResourceResolutionDenied','ResourceAdmissionDenied','ApprovalNoLongerAuthorized'";
  if (p40InvocationObservationGuardsForP44.split(allowlist).length - 1 !== 2) {
    throw new Error(
      "P40 Denied guard allowlists changed; refusing Native V2 derivation.",
    );
  }
  return p40InvocationObservationGuardsForP44.replaceAll(
    allowlist,
    "'ResourceResolutionDenied','ResourceAdmissionDenied','ApprovalNoLongerAuthorized','ProcessExecutionDisabled','NativeOsTupleUnavailable'",
  );
})();

/** Native V2 adds only two closed P4 Denied codes to the current P40 guards. */
export const P54_NATIVE_PROCESS_MODE_NO_EFFECT_DENIAL_MIGRATION = {
  id: 54,
  name: "native_process_mode_no_effect_denial",
  requiresUserVersion: 53,
  sql: `
DROP TRIGGER tool_invocations_observation_insert_guard;
DROP TRIGGER tool_invocations_observation_update_guard;
${p40InvocationObservationGuardsForP54}
`,
} satisfies MigrationFile & { readonly requiresUserVersion: 53 };
