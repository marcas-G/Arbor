import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("MAC-P4 final active-runtime convergence", () => {
  it("keeps legacy directive handlers outside active composition", () => {
    const composition = source("apps/single-workspace/src/composition.ts");
    const production = source("apps/single-workspace/src/production.ts");
    for (const activeSource of [composition, production]) {
      expect(activeSource).not.toContain("legacy-directive-handlers");
      expect(activeSource).not.toContain("legacy-governance-directive-handler");
      expect(activeSource).not.toContain("LegacyLegacyDirectiveHandlers");
    }
  });

  it("does not register the replay-only Specialist handler for new turns", () => {
    const actions = source("apps/single-workspace/src/control-actions.ts");
    const factory = actions.slice(
      actions.indexOf("export const makeSingleWorkspaceControlActionHandlers"),
    );
    expect(factory).not.toContain("spawnSpecialistHandler");
    expect(factory).not.toContain('action: "SpawnSpecialist"');
  });

  it("switches current production to one physical approval ledger", () => {
    const migrations = source("adapters/persistence-sqlite/src/migrations.ts");
    const composition = source("apps/single-workspace/src/composition.ts");
    const production = source("apps/single-workspace/src/production.ts");
    expect(migrations).toContain("CREATE TABLE action_approvals");
    expect(migrations).toContain("DROP TABLE invocation_approvals");
    expect(migrations).toContain("DROP TABLE control_action_approvals");
    expect(migrations).toContain("binding_proven");
    expect(migrations).toMatch(
      /export const P37_MIGRATIONS:[\s\S]*?id: 37,[\s\S]*?export const P38_MIGRATIONS:[\s\S]*?\.\.\.P37_MIGRATIONS,[\s\S]*?id: P38_EXECUTABLE_APPROVAL_MIGRATION\.migrationVersion/,
    );
    expect(
      source(
        "adapters/persistence-sqlite/src/p38-executable-approval-migration.ts",
      ),
    ).toContain("migrationVersion: 38");
    expect(migrations).toContain(
      "export const CURRENT_SCHEMA_VERSION = 51 as const;",
    );
    expect(migrations).toMatch(
      /export const CURRENT_MIGRATIONS:[\s\S]*?\.\.\.P38_MIGRATIONS,[\s\S]*?P40_TOOL_OBSERVATION_REPLAY_MIGRATION,[\s\S]*?P41_SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION,[\s\S]*?P42_PROJECT_RESOURCE_SOURCE_MIGRATION,[\s\S]*?P43_MIGRATION,[\s\S]*?P44_APPROVAL_REJECTED_NO_EFFECT_DENIAL_MIGRATION,[\s\S]*?P45_RETRY_VERIFICATION_ORIGIN_MIGRATION,[\s\S]*?P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION,[\s\S]*?P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION,[\s\S]*?P48_AH19_CONVERSATION_CHECKPOINT_OWNER_MIGRATION,[\s\S]*?P49_SANDBOX_POLICY_AND_GRANT_PROVENANCE_MIGRATION,[\s\S]*?P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_MIGRATION,[\s\S]*?P51_VERIFICATION_V2_CONSUMER_RECONCILIATION_MIGRATION/,
    );
    expect(migrations).toContain("export const P39_MAINTENANCE_MIGRATIONS:");
    const currentRegistryStart = migrations.indexOf(
      "export const CURRENT_MIGRATIONS:",
    );
    expect(currentRegistryStart).toBeGreaterThanOrEqual(0);
    const currentRegistryEnd = migrations.indexOf(
      "export const CURRENT_MIGRATION_BASELINE",
      currentRegistryStart,
    );
    const currentRegistry = migrations.slice(
      currentRegistryStart,
      currentRegistryEnd,
    );
    expect(currentRegistry).toContain("...P38_MIGRATIONS");
    expect(currentRegistry).toContain("P40_TOOL_OBSERVATION_REPLAY_MIGRATION");
    expect(currentRegistry).toContain(
      "P41_SUBMITTED_DECISION_BINDING_ATTENTION_MIGRATION",
    );
    expect(currentRegistry).toContain("P42_PROJECT_RESOURCE_SOURCE_MIGRATION");
    expect(currentRegistry).toContain("P43_MIGRATION");
    expect(currentRegistry).toContain(
      "P44_APPROVAL_REJECTED_NO_EFFECT_DENIAL_MIGRATION",
    );
    expect(currentRegistry).toContain(
      "P45_RETRY_VERIFICATION_ORIGIN_MIGRATION",
    );
    expect(currentRegistry).toContain(
      "P46_VERIFICATION_EVIDENCE_SNAPSHOT_MIGRATION",
    );
    expect(currentRegistry).toContain(
      "P47_AH14_LEGACY_ADOPTION_ATTENTION_MIGRATION",
    );
    expect(currentRegistry).toContain(
      "P48_AH19_CONVERSATION_CHECKPOINT_OWNER_MIGRATION",
    );
    expect(currentRegistry).not.toContain("P39_RECONCILIATION_MIGRATION");
    expect(currentRegistry).not.toContain("P39_MAINTENANCE_MIGRATIONS");
    expect(migrations).toContain(
      "export const CURRENT_MIGRATION_BASELINE = CURRENT_SCHEMA_VERSION;",
    );
    expect(composition).toContain(
      "const latestSupportedSchema = CURRENT_MIGRATION_BASELINE;",
    );
    expect(composition).toContain("if (current > latestSupportedSchema)");
    expect(composition).toContain("if (current !== CURRENT_SCHEMA_VERSION)");
    expect(composition).toContain("requires an offline upgrade to schema");
    expect(composition).toContain("sqliteAdapterError(");
    expect(production).toContain("runMigrations(CURRENT_MIGRATIONS)");
    expect(production).not.toMatch(/P39|p39WriterLock/);
  });
});
