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
      "export const CURRENT_MIGRATIONS = P38_MIGRATIONS;",
    );
    expect(migrations).toContain("export const P39_MAINTENANCE_MIGRATIONS:");
    const currentRegistryStart = migrations.indexOf(
      "export const CURRENT_MIGRATIONS = P38_MIGRATIONS;",
    );
    const maintenanceRegistryStart = migrations.indexOf(
      "export const P39_MAINTENANCE_MIGRATIONS:",
    );
    expect(currentRegistryStart).toBeGreaterThanOrEqual(0);
    expect(maintenanceRegistryStart).toBeGreaterThan(currentRegistryStart);
    const currentRegistry = migrations.slice(
      currentRegistryStart,
      maintenanceRegistryStart,
    );
    expect(currentRegistry).not.toContain("P39_MAINTENANCE_MIGRATIONS");
    expect(currentRegistry).not.toContain("P43_BLOCKED_WORKEPISODE_MIGRATION");
    expect(migrations).not.toContain("P43_BLOCKED_WORKEPISODE_MIGRATION");
    expect(migrations).toContain(
      "export const CURRENT_MIGRATION_BASELINE = Math.max(",
    );
    expect(composition).toContain(
      "const latestSupportedSchema = CURRENT_MIGRATION_BASELINE;",
    );
    expect(composition).toContain("if (current > latestSupportedSchema)");
    expect(composition).toContain("if (current >= 39)");
    expect(composition).toContain('code: "P39_RUNTIME_START_REFUSED"');
    expect(composition).toContain("sqliteAdapterError(");
    expect(production).toContain("runMigrations(CURRENT_MIGRATIONS)");
    expect(production).not.toMatch(/P39|p39WriterLock/);
  });
});
