import type { MigrationFile } from "./migrate.js";

/** S3 carve-out representation and exact delegation provenance. Existing
 * claims remain unchanged except for the neutral empty-exclusion value; no
 * Child ownership or Parent exclusion is inferred. */
export const P53_CANONICAL_OWNERSHIP_CARVEOUTS_MIGRATION: MigrationFile = {
  id: 53,
  name: "canonical_ownership_carveouts",
  requiresUserVersion: 52,
  sql: `
ALTER TABLE resource_ownership
  ADD COLUMN exclusions_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(exclusions_json));
ALTER TABLE resource_ownership
  ADD COLUMN delegating_workspace_id TEXT REFERENCES workspaces(workspace_id);
ALTER TABLE resource_ownership
  ADD COLUMN delegation_source_id TEXT;
ALTER TABLE resource_ownership
  ADD COLUMN claim_revision INTEGER NOT NULL DEFAULT 0
    CHECK (claim_revision >= 0);
CREATE UNIQUE INDEX resource_ownership_delegation_source_unique
  ON resource_ownership(delegation_source_id)
  WHERE delegation_source_id IS NOT NULL;

ALTER TABLE workspace_resource_activation_intents
  ADD COLUMN parent_workspace_id TEXT REFERENCES workspaces(workspace_id);
ALTER TABLE workspace_resource_activation_intents
  ADD COLUMN delegation_source_id TEXT;
ALTER TABLE workspace_resource_activation_intents
  ADD COLUMN delegation_json TEXT CHECK (delegation_json IS NULL OR json_valid(delegation_json));
ALTER TABLE workspace_resource_activation_intents
  ADD COLUMN expected_parent_workspace_revision INTEGER;
ALTER TABLE workspace_resource_activation_intents
  ADD COLUMN expected_child_workspace_revision INTEGER;
ALTER TABLE workspace_resource_activation_intents
  ADD COLUMN expected_parent_boundary_revision INTEGER;
ALTER TABLE workspace_resource_activation_intents
  ADD COLUMN expected_parent_ownership_revision INTEGER;
ALTER TABLE workspace_resource_activation_intents
  ADD COLUMN expected_child_ownership_revision INTEGER;
CREATE UNIQUE INDEX workspace_resource_activation_delegation_source_unique
  ON workspace_resource_activation_intents(delegation_source_id)
  WHERE delegation_source_id IS NOT NULL;
`,
};
