import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("schema-upgrade qualification layering", () => {
  it("keeps exhaustive crash matrices opt-in while default gates retain representative boundaries and descriptor KATs", () => {
    const suite = source(
      "apps/single-workspace/test/schema-upgrade-operator.test.ts",
    );
    const implementation = source(
      "apps/single-workspace/src/schema-upgrade.ts",
    );
    const runner = source("scripts/testing/run-schema-upgrade-exhaustive.mjs");
    const packageJson = JSON.parse(source("package.json")) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };

    expect(suite).toContain("ARBOR_EXHAUSTIVE_SCHEMA_UPGRADE");
    expect(suite).toContain("const exhaustiveIt =");
    expect(suite).toContain(
      "validates every migration predecessor and accepted descriptor hash in-process",
    );
    for (const representative of [
      "serializes two competing CLI resumes at the prepared P51 commit boundary",
      "creates a P51 fresh target without accepting a source",
      "upgrades an exact schema-48 copy through pinned 0049/0050/0051 prefixes",
      "refuses a schema-48 copy with an unreconciled NULL grant revision",
      "upgrades an exact disposable schema44 copy",
      "upgrades an exact disposable schema46 copy through offline migrations 0047–0051",
      "upgrades an exact disposable schema47 copy through offline migrations 0048–0051 and resumes as a no-op",
    ]) {
      expect(suite).toContain(representative);
    }
    expect(suite.match(/\[exhaustive\]/gu)).toHaveLength(5);

    expect(implementation).toContain(
      "export const schemaUpgradeDescriptorPinKats",
    );
    expect(implementation).toContain("validateDescriptorPin(version)");
    expect(implementation).toContain("pinnedDescriptorHash(version)");

    expect(runner).toContain('ARBOR_EXHAUSTIVE_SCHEMA_UPGRADE: "1"');
    expect(runner).toContain(
      '"apps/single-workspace/test/schema-upgrade-operator.test.ts"',
    );
    expect(runner).toContain("--testNamePattern");
    expect(runner).toContain(String.raw`\[exhaustive\]`);
    expect(packageJson.scripts?.["test:schema-upgrade:exhaustive"]).toBe(
      "node scripts/testing/run-schema-upgrade-exhaustive.mjs",
    );
  });
});
