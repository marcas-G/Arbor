import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  "adapters/persistence-sqlite/test/p47-ah14-legacy-adoption-attention-store.test.ts",
  "adapters/persistence-sqlite/test/p48-ah19-conversation-checkpoint-owner-migration.test.ts",
  "adapters/persistence-sqlite/test/p48-ah19-conversation-checkpoint-owner-store.test.ts",
  "adapters/persistence-sqlite/test/schema42-database-fixture.test.ts",
  "adapters/persistence-sqlite/test/schema44-database-fixture.test.ts",
  "apps/single-workspace/test/p6-inbox-rebuild-fixture-child.test.ts",
  "apps/single-workspace/test/retry-verification-origin-backfill.test.ts",
  "apps/single-workspace/test/schema-upgrade-operator.test.ts",
  "tests/functional/process/agent-loop-ah10-direct-child-assign-work-receipt-binding.functional.test.ts",
  "tests/functional/support/schema44-bootstrap.ts",
  // Explicit legacy/fail-closed replay qualification.
  "adapters/persistence-sqlite/test/p40-observation-schema44-fail-closed.test.ts",
  "tests/functional/pending/ah10-verification-recorded-at-fingerprint.functional.test.ts",
  "tests/functional/pending/f23-exact-tuple-receipt-integrity.functional.test.ts",
  "tests/functional/pending/p8-conclusion-criteria-snapshot.functional.test.ts",
  "tests/p4-schema44-profileless-shell2-recovery.test.ts",
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
    const trackedTypescript = execFileSync("git", ["ls-files", "--", "*.ts"], {
      cwd: root,
      encoding: "utf8",
    })
      .trim()
      .split(/\r?\n/u)
      .filter((path) => path.length > 0);
    const actualOwners = trackedTypescript
      .filter((path) => !fixtureInfrastructure.has(path))
      .filter((path) =>
        historicalFixtureSymbol.test(readFileSync(join(root, path), "utf8")),
      )
      .sort();

    expect(actualOwners).toEqual([...historicalSchemaFixtureOwners].sort());
  });
});
