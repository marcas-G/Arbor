import { P43_BLOCKED_WORKEPISODE_MIGRATION } from "./blocked-workepisode-migration.js";
import { P53_CANONICAL_OWNERSHIP_CARVEOUTS_MIGRATION } from "./canonical-ownership-carveouts-migration.js";
import { P48_AH19_CONVERSATION_CHECKPOINT_OWNER_MIGRATION } from "./conversation-checkpoint-owner-migration.js";
import { P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION } from "./legacy-adoption-attention-migration.js";
import type { MigrationFile } from "./migrate.js";
import {
  P38_MIGRATIONS,
  P41_SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION,
} from "./migrations/v31-v39-and-v41.js";
import {
  P40_TOOL_OBSERVATION_REPLAY_MIGRATION,
  P44_APPROVAL_REJECTED_NO_EFFECT_DENIAL_MIGRATION,
  P54_NATIVE_PROCESS_MODE_NO_EFFECT_DENIAL_MIGRATION,
} from "./migrations/v40-v44-v54-observation-guards.js";
import { P42_PROJECT_RESOURCE_SOURCE_MIGRATION } from "./project-resource-source-migration.js";
import { P45_RETRY_VERIFICATION_ORIGIN_MIGRATION } from "./retry-verification-origin-migration.js";
import { P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_MIGRATION } from "./sandbox-policy-and-grant-provenance-migration.js";
import { P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_MIGRATION } from "./sandbox-provider-unavailable-fact-migration.js";
import { P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION } from "./verification-evidence-snapshot-migration.js";
import { P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_MIGRATION } from "./verification-v2-consumer-reconciliation-migration.js";
import { P52_WORK_CONTRACT_REVISION_MIGRATION } from "./work-contract-revision-migration.js";
import { P57_WORKSPACE_SANDBOX_AUTHORIZATION_MIGRATION } from "./workspace-sandbox-authorization-migration.js";

export * from "./migrations/v01-v10.js";
export * from "./migrations/v11-v20.js";
export * from "./migrations/v21-v30.js";
export * from "./migrations/v31-v39-and-v41.js";
export * from "./migrations/v40-v44-v54-observation-guards.js";

/** PP-W401 additive Session provenance migration. Historical rows remain NULL
 * and are never inferred into a Work frontier. */
export const P55_SESSION_CAUSAL_PROVENANCE_MIGRATION: MigrationFile = {
  id: 55,
  name: "session_causal_provenance",
  sql: `ALTER TABLE session_entries ADD COLUMN causal_binding_json TEXT;`,
  requiresUserVersion: 54,
} satisfies MigrationFile & { readonly requiresUserVersion: 54 };

/** DID 1.66 §8.3: semantic compatibility boundary for Linux V2 policy JSON.
 * Existing columns already carry tagged JSON; no old row, pending action or
 * policy receipt is rewritten. The transactional user_version advance makes
 * older binaries reject this database before they can misread new V2 writes. */
export const P56_LINUX_WORKSPACE_NETWORK_V2_MIGRATION = {
  id: 56,
  name: "linux_workspace_network_v2_compatibility_boundary",
  requiresUserVersion: 55,
  sql: "SELECT 1;",
} satisfies MigrationFile & { readonly requiresUserVersion: 55 };

export { P57_WORKSPACE_SANDBOX_AUTHORIZATION_MIGRATION };

/**
 * Schema 57 is the current runtime target. P39 remains an exact privileged
 * maintenance-only step and is deliberately absent from this registry; the
 * trusted offline coordinator applies it before this ordinary suffix.
 */
export const P43_MIGRATION = {
  id: P43_BLOCKED_WORKEPISODE_MIGRATION.migrationVersion,
  name: "blocked_workepisode_and_inbox_workspace_sequence",
  requiresUserVersion: 42,
  sql: P43_BLOCKED_WORKEPISODE_MIGRATION.sql,
} satisfies MigrationFile & { readonly requiresUserVersion: 42 };

export const CURRENT_SCHEMA_VERSION = 57 as const;
export const CURRENT_MIGRATIONS: ReadonlyArray<MigrationFile> = Object.freeze([
  ...P38_MIGRATIONS,
  P40_TOOL_OBSERVATION_REPLAY_MIGRATION,
  P41_SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION,
  P42_PROJECT_RESOURCE_SOURCE_MIGRATION,
  P43_MIGRATION,
  P44_APPROVAL_REJECTED_NO_EFFECT_DENIAL_MIGRATION,
  P45_RETRY_VERIFICATION_ORIGIN_MIGRATION,
  P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION,
  P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION,
  P48_AH19_CONVERSATION_CHECKPOINT_OWNER_MIGRATION,
  P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_MIGRATION,
  P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_MIGRATION,
  P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_MIGRATION,
  P52_WORK_CONTRACT_REVISION_MIGRATION,
  P53_CANONICAL_OWNERSHIP_CARVEOUTS_MIGRATION,
  P54_NATIVE_PROCESS_MODE_NO_EFFECT_DENIAL_MIGRATION,
  P55_SESSION_CAUSAL_PROVENANCE_MIGRATION,
  P56_LINUX_WORKSPACE_NETWORK_V2_MIGRATION,
  P57_WORKSPACE_SANDBOX_AUTHORIZATION_MIGRATION,
]);
export const CURRENT_MIGRATION_BASELINE = CURRENT_SCHEMA_VERSION;
