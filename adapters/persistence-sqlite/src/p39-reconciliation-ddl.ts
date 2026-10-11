/** P4 owner DDL for user_version 39. This descriptor is intentionally not
 * appended to P36_MIGRATIONS/CURRENT_MIGRATIONS: 0039 is valid only after the
 * ordered 0036→0037→0038 prefix, and user_version 39 is maintenance-only until
 * P40 installs the canonical Observation evidence branch. */
export const P39_RECONCILIATION_DDL = `
ALTER TABLE tool_invocations RENAME TO tool_invocations_legacy_p39;

CREATE TABLE tool_invocations (
  invocation_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  side_effect_semantics TEXT NOT NULL CHECK (side_effect_semantics IN
    ('ReadOnly','Idempotent','Reconcilable','NonIdempotent')),
  arguments_json TEXT NOT NULL,
  resolved_regions_json TEXT NOT NULL,
  approval_id TEXT,
  effect_admission_state TEXT NOT NULL CHECK (effect_admission_state IN
    ('NotAdmitted','MayHaveStarted','LegacyUnknown')),
  recovery_binding_state TEXT NOT NULL CHECK (recovery_binding_state IN
    ('Bound','LegacyBindingUnproven','HistoricalSettled')),
  recovery_binding_sha256 TEXT,
  settlement_provenance TEXT CHECK (settlement_provenance IN
    ('Ordinary','Reconciliation','LegacyHistorical')),
  selected_attempt_no INTEGER,
  selected_fact_id TEXT,
  intent_at TEXT NOT NULL,
  settled_at TEXT,
  settlement_kind TEXT CHECK (settlement_kind IN
    ('Success','ExpectedFailure','Denied','Interrupted','OutcomeUnknown',
     'RuntimeFailure','ReconciledNoEffect')),
  settlement_json TEXT,
  result_ref TEXT REFERENCES artifacts(artifact_id),
  CHECK ((settled_at IS NULL) = (settlement_kind IS NULL)),
  CHECK ((settled_at IS NULL) = (settlement_provenance IS NULL)),
  CHECK (
    (settlement_provenance = 'Reconciliation'
      AND selected_attempt_no IS NOT NULL AND selected_fact_id IS NOT NULL
      AND settlement_kind IN ('Success','ExpectedFailure','ReconciledNoEffect')
      AND effect_admission_state = 'MayHaveStarted'
      AND recovery_binding_state = 'Bound')
    OR
    (settlement_provenance IN ('Ordinary','LegacyHistorical')
      AND selected_attempt_no IS NULL AND selected_fact_id IS NULL)
    OR
    (settlement_provenance IS NULL AND settled_at IS NULL
      AND selected_attempt_no IS NULL AND selected_fact_id IS NULL)
  ),
  CHECK (recovery_binding_state <> 'HistoricalSettled' OR
         (settled_at IS NOT NULL AND settlement_provenance = 'LegacyHistorical')),
  CHECK (recovery_binding_state <> 'LegacyBindingUnproven' OR settled_at IS NULL),
  CHECK ((recovery_binding_state = 'Bound') =
         (recovery_binding_sha256 IS NOT NULL)),
  CHECK (settlement_kind <> 'Denied' OR
         (effect_admission_state = 'NotAdmitted' AND result_ref IS NULL)),
  CHECK (settlement_kind <> 'ReconciledNoEffect' OR
         (settlement_provenance = 'Reconciliation'
          AND effect_admission_state = 'MayHaveStarted' AND result_ref IS NOT NULL
          AND json_extract(settlement_json, '$.reasonCode') IN
            ('AuthoritySnapshotChanged','ResourceSnapshotChanged',
             'ApprovalNoLongerAuthorized','StopRequested','ReplayLimitReached'))),
  FOREIGN KEY (invocation_id, recovery_binding_sha256)
    REFERENCES tool_invocation_recovery_bindings(invocation_id, binding_sha256)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (invocation_id, selected_attempt_no, selected_fact_id)
    REFERENCES tool_reconciliation_facts(invocation_id, attempt_no, fact_id)
    DEFERRABLE INITIALLY DEFERRED
);

INSERT INTO tool_invocations (
  invocation_id, execution_id, workspace_id, tool_name, tool_version,
  side_effect_semantics, arguments_json, resolved_regions_json, approval_id,
  effect_admission_state, recovery_binding_state, recovery_binding_sha256,
  settlement_provenance, selected_attempt_no, selected_fact_id, intent_at,
  settled_at, settlement_kind, settlement_json, result_ref
)
SELECT invocation_id, execution_id, workspace_id, tool_name, tool_version,
  side_effect_semantics, arguments_json, resolved_regions_json, approval_id,
  effect_admission_state,
  CASE WHEN settled_at IS NULL THEN 'LegacyBindingUnproven' ELSE 'HistoricalSettled' END,
  NULL,
  CASE WHEN settled_at IS NULL THEN NULL ELSE 'LegacyHistorical' END,
  NULL, NULL, intent_at, settled_at, settlement_kind, settlement_json, result_ref
FROM tool_invocations_legacy_p39;

CREATE TABLE tool_invocation_recovery_bindings (
  invocation_id TEXT PRIMARY KEY REFERENCES tool_invocations(invocation_id),
  binding_version INTEGER NOT NULL CHECK (binding_version = 1),
  canonical_binding_json TEXT NOT NULL,
  binding_sha256 TEXT NOT NULL CHECK
    (length(binding_sha256) = 64 AND binding_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  UNIQUE (invocation_id, binding_sha256)
);

CREATE TABLE tool_invocation_effect_attempts (
  invocation_id TEXT NOT NULL REFERENCES tool_invocations(invocation_id),
  attempt_no INTEGER NOT NULL CHECK (attempt_no IN (0,1)),
  admission_state TEXT NOT NULL CHECK (admission_state IN
    ('NotAdmitted','MayHaveStarted','LegacyUnknown')),
  tool_definition_hash TEXT,
  side_effect_semantics TEXT NOT NULL CHECK (side_effect_semantics IN
    ('ReadOnly','Idempotent','Reconcilable','NonIdempotent')),
  profile_id TEXT,
  profile_version TEXT,
  profile_hash TEXT,
  profile_protocol TEXT,
  effect_key TEXT,
  binding_sha256 TEXT,
  admitted_at TEXT,
  admission_source TEXT NOT NULL CHECK (admission_source IN
    ('P36Backfill','P39Claim','P39Admission')),
  admission_time_precision TEXT NOT NULL CHECK (admission_time_precision IN
    ('NotAdmitted','TransactionTimestamp','UnknownLegacy')),
  PRIMARY KEY (invocation_id, attempt_no),
  FOREIGN KEY (invocation_id, binding_sha256)
    REFERENCES tool_invocation_recovery_bindings(invocation_id, binding_sha256),
  CHECK (
    (admission_state = 'NotAdmitted' AND admitted_at IS NULL
      AND admission_time_precision = 'NotAdmitted'
      AND admission_source IN ('P36Backfill','P39Claim'))
    OR
    (admission_state = 'MayHaveStarted' AND admitted_at IS NOT NULL
      AND admission_time_precision = 'TransactionTimestamp'
      AND admission_source = 'P39Admission')
    OR
    (admission_state IN ('MayHaveStarted','LegacyUnknown') AND admitted_at IS NULL
      AND admission_time_precision = 'UnknownLegacy'
      AND admission_source = 'P36Backfill')
  ),
  CHECK ((profile_id IS NULL AND profile_version IS NULL AND profile_hash IS NULL
          AND profile_protocol IS NULL AND effect_key IS NULL)
      OR (profile_id IS NOT NULL AND profile_version IS NOT NULL
          AND profile_hash IS NOT NULL AND profile_protocol IS NOT NULL
          AND effect_key IS NOT NULL)),
  CHECK (profile_id IS NULL OR binding_sha256 IS NOT NULL)
);

INSERT INTO tool_invocation_effect_attempts (
  invocation_id, attempt_no, admission_state, tool_definition_hash,
  side_effect_semantics, profile_id, profile_version, profile_hash,
  profile_protocol, effect_key, binding_sha256, admitted_at,
  admission_source, admission_time_precision
)
SELECT invocation_id, 0, effect_admission_state, NULL, side_effect_semantics,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'P36Backfill',
  CASE WHEN effect_admission_state = 'NotAdmitted' THEN 'NotAdmitted'
       ELSE 'UnknownLegacy' END
FROM tool_invocations;

CREATE INDEX idx_effect_attempts_unsettled
  ON tool_invocation_effect_attempts(invocation_id, admission_state);

CREATE TABLE tool_reconciliation_facts (
  fact_id TEXT PRIMARY KEY CHECK
    (length(fact_id) = 64 AND fact_id NOT GLOB '*[^0-9a-f]*'),
  invocation_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  binding_sha256 TEXT,
  profile_hash TEXT,
  effect_key TEXT,
  fact_origin TEXT NOT NULL CHECK
    (fact_origin IN ('ProfileReconciliation','P36LegacyUnprofiled')),
  legacy_reason TEXT CHECK
    (legacy_reason IS NULL OR legacy_reason = 'LegacyProfileUnavailable'),
  fact_disposition TEXT NOT NULL CHECK
    (fact_disposition IN ('RecoveryInput','PostTerminalEvidence')),
  outcome TEXT NOT NULL CHECK (outcome IN ('NotOccurred','Occurred','StillUnknown')),
  reason_code TEXT,
  evidence_ref TEXT REFERENCES artifacts(artifact_id),
  evidence_sha256 TEXT,
  result_ref TEXT REFERENCES artifacts(artifact_id),
  observed_at TEXT NOT NULL,
  UNIQUE (invocation_id, attempt_no, fact_id),
  FOREIGN KEY (invocation_id, attempt_no)
    REFERENCES tool_invocation_effect_attempts(invocation_id, attempt_no),
  FOREIGN KEY (invocation_id, binding_sha256)
    REFERENCES tool_invocation_recovery_bindings(invocation_id, binding_sha256),
  CHECK (
    (fact_origin = 'P36LegacyUnprofiled'
      AND outcome = 'StillUnknown' AND reason_code = 'ProfileUnavailable'
      AND legacy_reason = 'LegacyProfileUnavailable'
      AND binding_sha256 IS NULL AND profile_hash IS NULL AND effect_key IS NULL)
    OR
    (fact_origin = 'ProfileReconciliation' AND legacy_reason IS NULL
      AND binding_sha256 IS NOT NULL AND profile_hash IS NOT NULL
      AND effect_key IS NOT NULL)
  ),
  CHECK (binding_sha256 IS NULL OR
    (length(binding_sha256) = 64 AND binding_sha256 NOT GLOB '*[^0-9a-f]*')),
  CHECK (profile_hash IS NULL OR length(profile_hash) > 0),
  CHECK (effect_key IS NULL OR length(trim(effect_key)) > 0),
  CHECK ((outcome = 'StillUnknown' AND reason_code IN
      ('ProfileUnavailable','EffectIdentityUnavailable','ExternalSourceUnavailable',
       'ExternalSourceNotAuthoritative','EvidenceStale','EvidenceBindingMismatch',
       'AttemptNotFinal','ResultEvidenceUnavailable','ProfileVersionUnavailable'))
      OR (outcome <> 'StillUnknown' AND reason_code IS NULL)),
  CHECK (fact_disposition <> 'PostTerminalEvidence' OR
    (outcome = 'StillUnknown' AND reason_code = 'EvidenceBindingMismatch')),
  CHECK ((outcome = 'Occurred' AND result_ref IS NOT NULL)
      OR (outcome <> 'Occurred' AND result_ref IS NULL)),
  CHECK ((evidence_ref IS NULL) = (evidence_sha256 IS NULL)),
  CHECK (evidence_sha256 IS NULL OR
    (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*')),
  CHECK (outcome <> 'NotOccurred' OR evidence_ref IS NOT NULL)
);

CREATE INDEX idx_reconciliation_facts_invocation
  ON tool_reconciliation_facts(invocation_id, attempt_no, observed_at);
CREATE UNIQUE INDEX reconciliation_facts_invocation_ref
  ON tool_reconciliation_facts(invocation_id, fact_id);
CREATE UNIQUE INDEX reconciliation_facts_attempt_ref
  ON tool_reconciliation_facts(invocation_id, attempt_no, fact_id);
CREATE UNIQUE INDEX reconciliation_facts_exact_redelivery
  ON tool_reconciliation_facts(
    invocation_id, attempt_no, fact_origin, outcome, fact_disposition,
    ifnull(binding_sha256,''), ifnull(profile_hash,''), ifnull(effect_key,''),
    ifnull(reason_code,''), ifnull(legacy_reason,''), ifnull(evidence_ref,''),
    ifnull(evidence_sha256,''), ifnull(result_ref,''));

CREATE TRIGGER recovery_binding_no_update
BEFORE UPDATE ON tool_invocation_recovery_bindings
BEGIN SELECT RAISE(ABORT, 'recovery binding is immutable'); END;
CREATE TRIGGER recovery_binding_no_delete
BEFORE DELETE ON tool_invocation_recovery_bindings
BEGIN SELECT RAISE(ABORT, 'recovery binding is retained'); END;
CREATE TRIGGER effect_attempt_identity_immutable
BEFORE UPDATE OF invocation_id, attempt_no, tool_definition_hash,
  side_effect_semantics, profile_id, profile_version, profile_hash,
  profile_protocol, effect_key, binding_sha256
ON tool_invocation_effect_attempts
BEGIN SELECT RAISE(ABORT, 'effect attempt identity is immutable'); END;
CREATE TRIGGER effect_attempt_admission_monotone
BEFORE UPDATE OF admission_state ON tool_invocation_effect_attempts
WHEN NOT (OLD.admission_state = NEW.admission_state OR
          (OLD.admission_state = 'NotAdmitted' AND NEW.admission_state = 'MayHaveStarted'))
BEGIN SELECT RAISE(ABORT, 'effect attempt admission is monotone'); END;
CREATE TRIGGER effect_attempt_admission_evidence_immutable
BEFORE UPDATE ON tool_invocation_effect_attempts
WHEN (OLD.admission_state <> 'NotAdmitted' AND (
       NEW.admitted_at IS NOT OLD.admitted_at OR
       NEW.admission_source IS NOT OLD.admission_source OR
       NEW.admission_time_precision IS NOT OLD.admission_time_precision))
  OR (OLD.admission_state = 'NotAdmitted' AND
      NEW.admission_state = 'NotAdmitted' AND (
       NEW.admitted_at IS NOT OLD.admitted_at OR
       NEW.admission_source IS NOT OLD.admission_source OR
       NEW.admission_time_precision IS NOT OLD.admission_time_precision))
BEGIN SELECT RAISE(ABORT, 'effect attempt admission evidence is immutable'); END;
CREATE TRIGGER effect_attempt_no_delete
BEFORE DELETE ON tool_invocation_effect_attempts
BEGIN SELECT RAISE(ABORT, 'effect attempts are retained'); END;
CREATE TRIGGER reconciliation_fact_no_update
BEFORE UPDATE ON tool_reconciliation_facts
BEGIN SELECT RAISE(ABORT, 'reconciliation facts are immutable'); END;
CREATE TRIGGER reconciliation_fact_no_delete
BEFORE DELETE ON tool_reconciliation_facts
BEGIN SELECT RAISE(ABORT, 'reconciliation facts are retained'); END;
CREATE TRIGGER reconciliation_fact_disposition_matches_terminal
BEFORE INSERT ON tool_reconciliation_facts
WHEN ((SELECT settled_at FROM tool_invocations WHERE invocation_id = NEW.invocation_id) IS NULL
      AND NEW.fact_disposition <> 'RecoveryInput')
  OR ((SELECT settled_at FROM tool_invocations WHERE invocation_id = NEW.invocation_id) IS NOT NULL
      AND NEW.fact_disposition <> 'PostTerminalEvidence')
BEGIN SELECT RAISE(ABORT, 'reconciliation fact disposition does not match terminal state'); END;

CREATE TRIGGER tool_invocation_settlement_no_rewrite
BEFORE UPDATE ON tool_invocations
WHEN OLD.settled_at IS NOT NULL AND (
  NEW.settled_at IS NOT OLD.settled_at OR
  NEW.settlement_kind IS NOT OLD.settlement_kind OR
  NEW.settlement_json IS NOT OLD.settlement_json OR
  NEW.result_ref IS NOT OLD.result_ref OR
  NEW.settlement_provenance IS NOT OLD.settlement_provenance OR
  NEW.selected_attempt_no IS NOT OLD.selected_attempt_no OR
  NEW.selected_fact_id IS NOT OLD.selected_fact_id)
BEGIN SELECT RAISE(ABORT, 'terminal settlement and selected fact are immutable'); END;
CREATE TRIGGER tool_invocation_admission_monotone
BEFORE UPDATE OF effect_admission_state ON tool_invocations
WHEN NOT (OLD.effect_admission_state = NEW.effect_admission_state OR
          (OLD.effect_admission_state = 'NotAdmitted' AND NEW.effect_admission_state = 'MayHaveStarted'))
BEGIN SELECT RAISE(ABORT, 'tool invocation admission is monotone'); END;
CREATE TRIGGER tool_invocation_binding_immutable
BEFORE UPDATE OF recovery_binding_state, recovery_binding_sha256 ON tool_invocations
WHEN OLD.recovery_binding_state <> NEW.recovery_binding_state OR
     OLD.recovery_binding_sha256 IS NOT NEW.recovery_binding_sha256
BEGIN SELECT RAISE(ABORT, 'recovery binding is immutable'); END;

CREATE TRIGGER tool_invocation_reconciliation_fact_required_insert
BEFORE INSERT ON tool_invocations
WHEN NEW.settlement_provenance = 'Reconciliation' AND NOT EXISTS (
  SELECT 1 FROM tool_reconciliation_facts AS f
  WHERE f.invocation_id = NEW.invocation_id
    AND f.attempt_no = NEW.selected_attempt_no
    AND f.fact_id = NEW.selected_fact_id
    AND f.binding_sha256 = NEW.recovery_binding_sha256
    AND f.fact_origin = 'ProfileReconciliation'
    AND f.fact_disposition = 'RecoveryInput'
    AND ((NEW.settlement_kind = 'Success'
          AND f.outcome = 'Occurred' AND f.result_ref = NEW.result_ref)
      OR (NEW.settlement_kind = 'ExpectedFailure'
          AND f.outcome = 'Occurred')
      OR (NEW.settlement_kind = 'ReconciledNoEffect'
          AND f.outcome = 'NotOccurred' AND f.result_ref IS NULL
          AND NEW.result_ref IS NOT NULL)))
BEGIN SELECT RAISE(ABORT, 'reconciliation settlement requires matching authoritative fact'); END;
CREATE TRIGGER tool_invocation_reconciliation_fact_required_update
BEFORE UPDATE OF settled_at, settlement_kind, settlement_provenance,
  selected_attempt_no, selected_fact_id, recovery_binding_sha256,
  effect_admission_state, result_ref ON tool_invocations
WHEN NEW.settlement_provenance = 'Reconciliation' AND NOT EXISTS (
  SELECT 1 FROM tool_reconciliation_facts AS f
  WHERE f.invocation_id = NEW.invocation_id
    AND f.attempt_no = NEW.selected_attempt_no
    AND f.fact_id = NEW.selected_fact_id
    AND f.binding_sha256 = NEW.recovery_binding_sha256
    AND f.fact_origin = 'ProfileReconciliation'
    AND f.fact_disposition = 'RecoveryInput'
    AND ((NEW.settlement_kind = 'Success'
          AND f.outcome = 'Occurred' AND f.result_ref = NEW.result_ref)
      OR (NEW.settlement_kind = 'ExpectedFailure'
          AND f.outcome = 'Occurred')
      OR (NEW.settlement_kind = 'ReconciledNoEffect'
          AND f.outcome = 'NotOccurred' AND f.result_ref IS NULL
          AND NEW.result_ref IS NOT NULL)))
BEGIN SELECT RAISE(ABORT, 'reconciliation settlement requires matching authoritative fact'); END;

DROP TABLE tool_invocations_legacy_p39;
CREATE INDEX idx_tool_invocations_execution ON tool_invocations(execution_id);
CREATE INDEX idx_tool_invocations_unsettled
  ON tool_invocations(settled_at) WHERE settled_at IS NULL;
`;
