import type { MigrationFile } from "./migrate.js";

/** Fixed descriptor fingerprint: SHA-256 of `49\nname\nSQL-SHA256`. */
export const P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_FINGERPRINT =
  "3a4c8ed3e75b3017869ebfc67b60320bb56639719ba48810f09792eadc12426e";

/** Native OS Sandbox provider-unavailable source fact and retained P10 queue.
 * It follows the exact accepted 0049 schema and is offline-only. */
export const P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_MIGRATION = {
  id: 50,
  name: "sandbox_provider_unavailable_fact",
  requiresUserVersion: 49,
  offlineOnly: true,
  sql: `
CREATE TABLE sandbox_provider_unavailable_facts (
  attention_fact_id TEXT NOT NULL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  episode_binding_json TEXT NOT NULL CHECK (json_valid(episode_binding_json)),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
  policy_digest TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_version TEXT NOT NULL,
  probe_evidence_ref TEXT,
  failure_code TEXT NOT NULL CHECK (
    failure_code = trim(failure_code)
    AND length(trim(failure_code)) > 0
    AND length(CAST(failure_code AS BLOB)) BETWEEN 1 AND 128
  ),
  first_detected_at TEXT NOT NULL,
  UNIQUE (execution_id, policy_revision),
  UNIQUE (attention_fact_id, project_id, workspace_id),
  FOREIGN KEY (execution_id, project_id, workspace_id)
    REFERENCES executions(execution_id, project_id, workspace_id),
  FOREIGN KEY (project_id, workspace_id, execution_id,
               episode_binding_json, policy_revision)
    REFERENCES sandbox_policy_decisions
      (project_id, workspace_id, execution_id, episode_binding_json,
       policy_revision) ON DELETE RESTRICT
);

CREATE INDEX sandbox_provider_unavailable_fact_project_time
  ON sandbox_provider_unavailable_facts
    (project_id, first_detected_at, attention_fact_id);

CREATE TRIGGER sandbox_provider_unavailable_fact_no_update
BEFORE UPDATE ON sandbox_provider_unavailable_facts
BEGIN
  SELECT RAISE(ABORT, 'sandbox provider unavailable facts are immutable');
END;

CREATE TRIGGER sandbox_provider_unavailable_fact_no_delete
BEFORE DELETE ON sandbox_provider_unavailable_facts
BEGIN
  SELECT RAISE(ABORT, 'sandbox provider unavailable facts are retained');
END;

CREATE TABLE sandbox_provider_unavailable_attention_rows (
  project_id TEXT NOT NULL,
  attention_fact_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  PRIMARY KEY (project_id, attention_fact_id),
  FOREIGN KEY (attention_fact_id, project_id, workspace_id)
    REFERENCES sandbox_provider_unavailable_facts
      (attention_fact_id, project_id, workspace_id)
);

CREATE TABLE sandbox_provider_unavailable_attention_queue (
  project_id TEXT NOT NULL,
  attention_fact_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('Pending','Claimed','Consumed')),
  claim_id TEXT UNIQUE,
  claim_expires_at TEXT,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  enqueued_at TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (project_id, attention_fact_id),
  CHECK (
    (state = 'Pending' AND claim_id IS NULL AND claim_expires_at IS NULL
      AND consumed_at IS NULL)
    OR
    (state = 'Claimed' AND claim_id IS NOT NULL
      AND claim_expires_at IS NOT NULL AND consumed_at IS NULL)
    OR
    (state = 'Consumed' AND claim_id IS NULL
      AND claim_expires_at IS NULL AND consumed_at IS NOT NULL)
  ),
  FOREIGN KEY (attention_fact_id, project_id, workspace_id)
    REFERENCES sandbox_provider_unavailable_facts
      (attention_fact_id, project_id, workspace_id)
);

CREATE INDEX sandbox_provider_unavailable_queue_due
  ON sandbox_provider_unavailable_attention_queue
    (state, claim_expires_at, enqueued_at, project_id, attention_fact_id);

CREATE TRIGGER sandbox_provider_unavailable_queue_no_identity_update
BEFORE UPDATE OF project_id, attention_fact_id, workspace_id, enqueued_at
ON sandbox_provider_unavailable_attention_queue
BEGIN
  SELECT RAISE(ABORT, 'sandbox provider unavailable queue identity is immutable');
END;

CREATE TRIGGER sandbox_provider_unavailable_queue_no_delete
BEFORE DELETE ON sandbox_provider_unavailable_attention_queue
BEGIN
  SELECT RAISE(ABORT, 'sandbox provider unavailable queue markers are retained');
END;
`,
} satisfies MigrationFile & { readonly requiresUserVersion: 49 };
