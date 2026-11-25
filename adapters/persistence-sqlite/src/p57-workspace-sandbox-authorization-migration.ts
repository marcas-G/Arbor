import type { MigrationFile } from "./migrate.js";

/** Staged owner descriptor. Do not promote the runtime schema head until the
 * offline upgrader/signature/manifest and execution-policy consumers land. */
export const P57_WORKSPACE_SANDBOX_AUTHORIZATION_MIGRATION = {
  id: 57,
  name: "workspace_sandbox_authorization",
  requiresUserVersion: 56,
  offlineOnly: true,
  foreignKeysOff: true,
  sql: `
CREATE TABLE workspace_sandbox_authorizations (
  project_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  authorization_revision INTEGER NOT NULL CHECK (typeof(authorization_revision) = 'integer'
    AND authorization_revision BETWEEN 1 AND 9007199254740991),
  previous_revision INTEGER,
  command_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('Granted','Revoked')),
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  parent_workspace_id TEXT,
  parent_authorization_revision INTEGER,
  PRIMARY KEY (project_id, workspace_id, authorization_revision),
  CHECK ((authorization_revision = 1 AND previous_revision IS NULL AND state = 'Granted')
    OR (authorization_revision > 1 AND previous_revision = authorization_revision - 1)),
  CHECK ((parent_workspace_id IS NULL AND parent_authorization_revision IS NULL)
    OR (parent_workspace_id IS NOT NULL AND parent_workspace_id <> workspace_id
      AND parent_authorization_revision IS NOT NULL
      AND parent_authorization_revision >= 1 AND state = 'Granted')),
  CHECK (json_extract(record_json, '$.version') IS 1
    AND json_extract(record_json, '$.projectId') IS project_id
    AND json_extract(record_json, '$.workspaceId') IS workspace_id
    AND json_extract(record_json, '$.authorizationRevision') IS authorization_revision
    AND json_extract(record_json, '$.commandId') IS command_id
    AND json_extract(record_json, '$.state') IS state),
  CHECK (CASE WHEN state = 'Granted' AND json_extract(record_json, '$.origin.kind') = 'Parent'
    THEN parent_workspace_id IS NOT NULL
      AND json_extract(record_json, '$.origin.parentWorkspaceId') IS parent_workspace_id
      AND json_extract(record_json, '$.origin.parentAuthorizationRevision') IS parent_authorization_revision
    ELSE parent_workspace_id IS NULL AND parent_authorization_revision IS NULL END),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES workspaces(workspace_id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, workspace_id, previous_revision)
    REFERENCES workspace_sandbox_authorizations(project_id, workspace_id, authorization_revision) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, parent_workspace_id, parent_authorization_revision)
    REFERENCES workspace_sandbox_authorizations(project_id, workspace_id, authorization_revision) ON DELETE RESTRICT,
  FOREIGN KEY (command_id) REFERENCES commands(command_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER workspace_sandbox_authorizations_successor_guard
BEFORE INSERT ON workspace_sandbox_authorizations
WHEN NEW.authorization_revision <> COALESCE((SELECT MAX(authorization_revision) + 1
  FROM workspace_sandbox_authorizations
  WHERE project_id = NEW.project_id AND workspace_id = NEW.workspace_id), 1)
BEGIN SELECT RAISE(ABORT, 'workspace sandbox authorization head conflict'); END;
CREATE TRIGGER workspace_sandbox_authorizations_no_update
BEFORE UPDATE ON workspace_sandbox_authorizations
BEGIN SELECT RAISE(ABORT, 'workspace sandbox authorizations are immutable'); END;
CREATE TRIGGER workspace_sandbox_authorizations_no_delete
BEFORE DELETE ON workspace_sandbox_authorizations
BEGIN SELECT RAISE(ABORT, 'workspace sandbox authorizations are retained'); END;

CREATE TABLE sandbox_policy_decisions_0057 (
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
  permission_grant_id TEXT,
  grant_permission_command_id TEXT,
  grant_issuer_principal TEXT,
  operator_config_revision INTEGER NOT NULL CHECK (operator_config_revision >= 1),
  operator_config_digest TEXT NOT NULL CHECK (length(operator_config_digest) = 64 AND operator_config_digest NOT GLOB '*[^0-9a-f]*'),
  actor_principal TEXT NOT NULL,
  decision_command_id TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  authority_kind TEXT NOT NULL DEFAULT 'LegacyHumanGrant'
    CHECK (authority_kind IN ('LegacyHumanGrant','WorkspaceAuthorization')),
  workspace_authorization_revision INTEGER,
  PRIMARY KEY (project_id, workspace_id, execution_id, episode_binding_json, policy_revision),
  UNIQUE (execution_id, policy_revision),
  CHECK (policy_revision = expected_policy_revision + 1),
  CHECK ((authority_kind = 'LegacyHumanGrant' AND permission_grant_id IS NOT NULL
      AND grant_permission_command_id IS NOT NULL AND grant_issuer_principal IS NOT NULL
      AND workspace_authorization_revision IS NULL)
    OR (authority_kind = 'WorkspaceAuthorization' AND permission_grant_id IS NULL
      AND grant_permission_command_id IS NULL AND grant_issuer_principal IS NULL
      AND workspace_authorization_revision IS NOT NULL
      AND typeof(workspace_authorization_revision) = 'integer'
      AND workspace_authorization_revision BETWEEN 1 AND 9007199254740991
      AND profile_id <> 'FullAccess')),
  FOREIGN KEY (execution_id, project_id, workspace_id)
    REFERENCES executions(execution_id, project_id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (permission_grant_id, grant_permission_command_id, grant_issuer_principal,
               operator_config_revision, operator_config_digest)
    REFERENCES sandbox_policy_grant_issuer_provenance
      (permission_grant_id, grant_permission_command_id, issuer_principal,
       operator_config_revision, operator_config_digest) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, workspace_id, workspace_authorization_revision)
    REFERENCES workspace_sandbox_authorizations(project_id, workspace_id, authorization_revision) ON DELETE RESTRICT,
  FOREIGN KEY (decision_command_id)
    REFERENCES commands(command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
INSERT INTO sandbox_policy_decisions_0057 (
  project_id, workspace_id, execution_id, episode_binding_json, policy_revision,
  expected_execution_revision, expected_policy_revision, profile_id, provider_id,
  network_policy_json, policy_digest, permission_grant_id, grant_permission_command_id,
  grant_issuer_principal, operator_config_revision, operator_config_digest, actor_principal,
  decision_command_id, issued_at, expires_at
)
SELECT project_id, workspace_id, execution_id, episode_binding_json, policy_revision,
  expected_execution_revision, expected_policy_revision, profile_id, provider_id,
  network_policy_json, policy_digest, permission_grant_id, grant_permission_command_id,
  grant_issuer_principal, operator_config_revision, operator_config_digest, actor_principal,
  decision_command_id, issued_at, expires_at
FROM sandbox_policy_decisions;
DROP TABLE sandbox_policy_decisions;
ALTER TABLE sandbox_policy_decisions_0057 RENAME TO sandbox_policy_decisions;
CREATE TRIGGER sandbox_policy_decisions_no_update BEFORE UPDATE ON sandbox_policy_decisions
BEGIN SELECT RAISE(ABORT, 'sandbox policy decisions are immutable'); END;
CREATE TRIGGER sandbox_policy_decisions_no_delete BEFORE DELETE ON sandbox_policy_decisions
BEGIN SELECT RAISE(ABORT, 'sandbox policy decisions are retained'); END;

-- The engine also checks after commit. Check here while rollback is still
-- possible, including the existing provider-unavailable inbound references.
CREATE TEMP TABLE p57_authority_foreign_key_check (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO p57_authority_foreign_key_check
SELECT CASE WHEN EXISTS (SELECT 1 FROM pragma_foreign_key_check) THEN 0 ELSE 1 END;
DROP TABLE p57_authority_foreign_key_check;
`,
} satisfies MigrationFile & { readonly requiresUserVersion: 56 };
