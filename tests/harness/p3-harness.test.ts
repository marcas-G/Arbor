import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const read = (relative: string): string =>
  readFileSync(join(repoRoot, relative), "utf8");

const P3_PACKAGES = [
  "packages/model-context",
  "packages/provider-runtime",
  "adapters/provider-fake",
];

describe("p3 harness wiring", () => {
  it("creates each P3 package root with a manifest, tsconfig, and entry", () => {
    for (const pkg of P3_PACKAGES) {
      for (const file of ["package.json", "tsconfig.json", "src/index.ts"]) {
        expect(existsSync(join(repoRoot, pkg, file)), `${pkg}/${file}`).toBe(
          true,
        );
      }
    }
  });

  it("references every P3 package in the build solution", () => {
    const root = read("tsconfig.json");
    for (const ref of [
      "./packages/model-context",
      "./packages/provider-runtime",
      "./adapters/provider-fake",
    ]) {
      expect(root).toContain(ref);
    }
  });

  it("adds the agent-runtime -> model-context edge", () => {
    const manifest = JSON.parse(
      read("packages/agent-runtime/package.json"),
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies?.["@arbor/model-context"]).toBe("workspace:*");
  });

  it("keeps provider-runtime dependent on ports only", () => {
    const manifest = JSON.parse(
      read("packages/provider-runtime/package.json"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@arbor/ports",
    ]);
  });
});
