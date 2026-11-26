import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

const historicalSchemaFixtureOwners = [
  // Migration descriptors and exact predecessor-prefix qualification.
  "adapters/persistence-sqlite/test/native-os-sandbox-storage-migration.test.ts",
  "adapters/persistence-sqlite/test/p40-observation-store-gates.test.ts",
  "adapters/persistence-sqlite/test/p41-submitted-decision-binding-storage.test.ts",
  "adapters/persistence-sqlite/test/p42-project-resource-source-migration.test.ts",
  "adapters/persistence-sqlite/test/p43-work-blocker-store.test.ts",
  "adapters/persistence-sqlite/test/p44-approval-rejected-no-effect-migration.test.ts",
  "adapters/persistence-sqlite/test/p45-retry-verification-origin-migration.test.ts",
  "adapters/persistence-sqlite/test/p47-ah14-legacy-adoption-attention-migration.test.ts",
  "adapters/persistence-sqlite/test/p48-ah19-conversation-checkpoint-owner-migration.test.ts",
  "adapters/persistence-sqlite/test/p51-verification-v2-consumer-reconciliation-migration.test.ts",
  "adapters/persistence-sqlite/test/p56-linux-network-compatibility.test.ts",
  "adapters/persistence-sqlite/test/sandbox-policy-grant-provenance-repository.test.ts",
  "adapters/persistence-sqlite/test/verification-signal-reconciliation-store.test.ts",
  "adapters/persistence-sqlite/test/schema42-database-fixture.test.ts",
  "adapters/persistence-sqlite/test/schema44-database-fixture.test.ts",
  "apps/single-workspace/test/p6-inbox-rebuild-fixture-child.test.ts",
  // P6 is an exact historical schema-48 operator; its shared template is not
  // an ordinary current-runtime fixture.
  "apps/single-workspace/test/p6-inbox-rebuild.test.ts",
  "apps/single-workspace/test/retry-verification-origin-backfill.test.ts",
  "apps/single-workspace/test/schema-upgrade-operator.test.ts",
  "tests/functional/process/ah10-child/support-legacy-image.ts",
  "tests/functional/support/schema44-bootstrap.ts",
  // Explicit legacy/fail-closed replay qualification.
  "adapters/persistence-sqlite/test/p40-observation-schema44-fail-closed.test.ts",
  "tests/p4-schema44-profileless-shell2-recovery.test.ts",
  "tests/workspace-sandbox-authorization.test.ts",
  // The runtime schema gate deliberately manufactures old versions to reject
  // them and explicitly upgrades 48 -> current in its positive control.
  "apps/single-workspace/test/p38-runtime-schema-boundary.test.ts",
] as const;

const fixtureInfrastructure = new Set([
  "tests/support/schema42-database.ts",
  "tests/support/schema44-database.ts",
]);

const historicalFixtureSymbol = new RegExp(
  String.raw`\bcreate${"Schema"}(?:42|44|45|46|47|48|50)TestDatabase(?:Factory)?\b`,
  "u",
);

describe("current production schema test-fixture boundary", () => {
  it("keeps numbered schema fixtures confined to an explicit historical qualification allowlist", () => {
    // Include tracked and non-ignored working-tree files. During development,
    // a newly added qualification test must be checked before it is staged;
    // otherwise the allowlist can claim to protect it while this test silently
    // omits it from the scan.
    const workingTreeTypescript = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.ts"],
      {
        cwd: root,
        encoding: "utf8",
      },
    )
      .trim()
      .split(/\r?\n/u)
      .filter((path) => path.length > 0 && existsSync(join(root, path)));
    const actualOwners = workingTreeTypescript
      .filter((path) => !fixtureInfrastructure.has(path))
      .filter((path) =>
        historicalFixtureSymbol.test(readFileSync(join(root, path), "utf8")),
      )
      .sort();

    expect(actualOwners).toEqual([...historicalSchemaFixtureOwners].sort());
  });
});
