import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const read = (relative: string): string =>
  readFileSync(join(repoRoot, relative), "utf8");

describe("p1 harness wiring", () => {
  it("typechecks and tests every P1 package root", () => {
    const testConfig = read("tsconfig.test.json");
    for (const glob of [
      "packages/**/src/**/*.ts",
      "packages/**/test/**/*.ts",
      "adapters/**/src/**/*.ts",
      "adapters/**/test/**/*.ts",
      "tests/**/*.ts",
    ]) {
      expect(testConfig).toContain(glob);
    }
    const vitest = read("vitest.config.ts");
    expect(vitest).toContain("packages/*/test/**/*.test.ts");
    expect(vitest).toContain("adapters/*/test/**/*.test.ts");
    expect(vitest).toContain("tests/**/*.test.ts");
  });

  it("references every P1 package in the build solution", () => {
    const root = read("tsconfig.json");
    for (const ref of [
      "./packages/domain",
      "./packages/ports",
      "./packages/application",
      "./adapters/persistence-sqlite",
      "./adapters/environment-local",
    ]) {
      expect(root).toContain(ref);
    }
  });
});
