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
    expect(composition).toContain("P35_MIGRATIONS as CURRENT_MIGRATIONS");
    expect(production).toContain("runMigrations(P35_MIGRATIONS)");
  });
});
