import type { MigrationFile } from "./migrate.js";

/** P9 immutable AH14 evidence and the rebuildable P10 Attention marker. */
export const P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION = {
  id: 47,
  name: "ah14_legacy_adoption_evidence_attention",
  requiresUserVersion: 46,
  offlineOnly: true,
  sql: `
CREATE TABLE legacy_adoption_attention_facts (
  attention_fact_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  provider_turn_id TEXT NOT NULL,
  logical_step_no INTEGER NOT NULL CHECK (logical_step_no >= 0),
  repair_attempt INTEGER NOT NULL CHECK (repair_attempt >= 0),
  failure_code TEXT NOT NULL CHECK (failure_code = 'LegacyActionDispositionUnproven'),
  evidence_sha256 TEXT NOT NULL
    CHECK (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  first_detected_at TEXT NOT NULL,
  UNIQUE (execution_id, evidence_sha256),
  UNIQUE (attention_fact_id, project_id, workspace_id),
  UNIQUE (attention_fact_id, project_id, workspace_id, evidence_sha256)
);

CREATE TRIGGER legacy_adoption_attention_facts_immutable_update
BEFORE UPDATE ON legacy_adoption_attention_facts
BEGIN SELECT RAISE(ABORT, 'legacy_adoption_attention_fact_immutable'); END;
CREATE TRIGGER legacy_adoption_attention_facts_immutable_delete
BEFORE DELETE ON legacy_adoption_attention_facts
BEGIN SELECT RAISE(ABORT, 'legacy_adoption_attention_fact_immutable'); END;

CREATE TABLE legacy_adoption_attention_resolution_facts (
  resolution_fact_id TEXT PRIMARY KEY,
  attention_fact_id TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  provider_turn_id TEXT NOT NULL,
  original_evidence_sha256 TEXT NOT NULL
    CHECK (length(original_evidence_sha256) = 64 AND original_evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  resolution_evidence_sha256 TEXT NOT NULL
    CHECK (length(resolution_evidence_sha256) = 64 AND resolution_evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  action_disposition_summary_json TEXT NOT NULL CHECK (json_valid(action_disposition_summary_json)),
  action_disposition_summary_sha256 TEXT NOT NULL
    CHECK (length(action_disposition_summary_sha256) = 64 AND action_disposition_summary_sha256 NOT GLOB '*[^0-9a-f]*'),
  resolution_code TEXT NOT NULL
    CHECK (resolution_code IN ('DispositionProvenNotAdmitted','DispositionProvenSettled')),
  resolved_at TEXT NOT NULL,
  FOREIGN KEY (
    attention_fact_id, project_id, workspace_id, original_evidence_sha256
  ) REFERENCES legacy_adoption_attention_facts (
    attention_fact_id, project_id, workspace_id, evidence_sha256
  )
);
CREATE INDEX legacy_adoption_attention_resolution_execution
  ON legacy_adoption_attention_resolution_facts(project_id, execution_id, provider_turn_id);
CREATE TRIGGER legacy_adoption_attention_resolution_facts_immutable_update
BEFORE UPDATE ON legacy_adoption_attention_resolution_facts
BEGIN SELECT RAISE(ABORT, 'legacy_adoption_attention_resolution_fact_immutable'); END;
CREATE TRIGGER legacy_adoption_attention_resolution_facts_immutable_delete
BEFORE DELETE ON legacy_adoption_attention_resolution_facts
BEGIN SELECT RAISE(ABORT, 'legacy_adoption_attention_resolution_fact_immutable'); END;

CREATE TABLE legacy_adoption_attention_rows (
  project_id TEXT NOT NULL,
  attention_fact_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  PRIMARY KEY (project_id, attention_fact_id),
  FOREIGN KEY (attention_fact_id, project_id, workspace_id)
    REFERENCES legacy_adoption_attention_facts(attention_fact_id, project_id, workspace_id)
);
CREATE INDEX legacy_adoption_attention_rows_workspace
  ON legacy_adoption_attention_rows(project_id, workspace_id, attention_fact_id);
`,
} satisfies MigrationFile & { readonly requiresUserVersion: 46 };
