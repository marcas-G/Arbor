import type { MigrationFile } from "./migrate.js";

/** Fixed descriptor fingerprint: SHA-256 of `48\nname\nSQL-SHA256`. */
export const P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_FINGERPRINT =
  "2d5860493f471c226cafc54b7b6b4e75adaad1ff5ca3f19713ef106e5512c80f";

/** Native OS Sandbox committed policy and grant issuer storage. It is applied
 * only by the offline schema-upgrade path after the exact schema-48 prefix. */
export const P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_MIGRATION = {
  id: 49,
  name: "sandbox_policy_and_grant_provenance",
  requiresUserVersion: 48,
  offlineOnly: true,
  sql: `
CREATE TEMP TABLE sandbox_policy_0049_preflight (
  valid INTEGER NOT NULL CHECK (valid = 1)
);
INSERT INTO sandbox_policy_0049_preflight (valid)
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM permission_grants
    WHERE revision IS NULL
      AND NOT (state = 'Revoked'
        AND (subject_kind IS NULL OR subject_ref IS NULL OR capability IS NULL))
  ) THEN 0
  WHEN EXISTS (
    SELECT 1 FROM sqlite_schema
    WHERE name IN (
      'sandbox_policy_grant_issuer_provenance',
      'sandbox_policy_grant_issuer_provenance_no_update',
      'sandbox_policy_grant_issuer_provenance_no_delete',
      'sandbox_policy_decisions',
      'sandbox_policy_grant_provenance_exact_binding',
      'sandbox_policy_decisions_no_update',
      'sandbox_policy_decisions_no_delete'
    )
  ) THEN 0
  ELSE 1
END;

UPDATE permission_grants
SET revision = 0
WHERE revision IS NULL
  AND state = 'Revoked'
  AND (subject_kind IS NULL OR subject_ref IS NULL OR capability IS NULL);
DROP TABLE sandbox_policy_0049_preflight;

CREATE TABLE sandbox_policy_grant_issuer_provenance (
  permission_grant_id TEXT PRIMARY KEY NOT NULL
    REFERENCES permission_grants(permission_grant_id) ON DELETE RESTRICT,
  grant_permission_command_id TEXT NOT NULL UNIQUE
    REFERENCES commands(command_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  issuer_principal TEXT NOT NULL,
  operator_config_revision INTEGER NOT NULL CHECK (operator_config_revision >= 1),
  operator_config_digest TEXT NOT NULL
    CHECK (length(operator_config_digest) = 64
       AND operator_config_digest NOT GLOB '*[^0-9a-f]*')
);
CREATE TRIGGER sandbox_policy_grant_issuer_provenance_no_update
BEFORE UPDATE ON sandbox_policy_grant_issuer_provenance
BEGIN SELECT RAISE(ABORT, 'immutable sandbox policy grant provenance'); END;
CREATE TRIGGER sandbox_policy_grant_issuer_provenance_no_delete
BEFORE DELETE ON sandbox_policy_grant_issuer_provenance
BEGIN SELECT RAISE(ABORT, 'immutable sandbox policy grant provenance'); END;

CREATE TABLE sandbox_policy_decisions (
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  episode_binding_json TEXT NOT NULL CHECK (json_valid(episode_binding_json)),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
  expected_execution_revision INTEGER NOT NULL CHECK (expected_execution_revision >= 0),
  expected_policy_revision INTEGER NOT NULL CHECK (expected_policy_revision >= 0),
  profile_id TEXT NOT NULL CHECK (profile_id IN ('ReadOnly','WorkspaceWrite','FullAccess')),
  provider_id TEXT NOT NULL CHECK (provider_id = trim(provider_id) AND length(provider_id) > 0),
  network_policy_json TEXT NOT NULL CHECK (json_valid(network_policy_json)),
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9a-f]*'),
  permission_grant_id TEXT NOT NULL,
  grant_permission_command_id TEXT NOT NULL,
  grant_issuer_principal TEXT NOT NULL,
  operator_config_revision INTEGER NOT NULL CHECK (operator_config_revision >= 1),
  operator_config_digest TEXT NOT NULL CHECK (length(operator_config_digest) = 64 AND operator_config_digest NOT GLOB '*[^0-9a-f]*'),
  actor_principal TEXT NOT NULL,
  decision_command_id TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (project_id, workspace_id, execution_id, episode_binding_json, policy_revision),
  UNIQUE (execution_id, policy_revision),
  CHECK (policy_revision = expected_policy_revision + 1),
  FOREIGN KEY (execution_id, project_id, workspace_id)
    REFERENCES executions(execution_id, project_id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (permission_grant_id, grant_permission_command_id, grant_issuer_principal,
               operator_config_revision, operator_config_digest)
    REFERENCES sandbox_policy_grant_issuer_provenance
      (permission_grant_id, grant_permission_command_id, issuer_principal,
       operator_config_revision, operator_config_digest) ON DELETE RESTRICT,
  FOREIGN KEY (decision_command_id)
    REFERENCES commands(command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX sandbox_policy_grant_provenance_exact_binding
  ON sandbox_policy_grant_issuer_provenance
    (permission_grant_id, grant_permission_command_id, issuer_principal,
     operator_config_revision, operator_config_digest);
CREATE TRIGGER sandbox_policy_decisions_no_update BEFORE UPDATE ON sandbox_policy_decisions
BEGIN SELECT RAISE(ABORT, 'sandbox policy decisions are immutable'); END;
CREATE TRIGGER sandbox_policy_decisions_no_delete BEFORE DELETE ON sandbox_policy_decisions
BEGIN SELECT RAISE(ABORT, 'sandbox policy decisions are retained'); END;
`,
} satisfies MigrationFile & { readonly requiresUserVersion: 48 };
