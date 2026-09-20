import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const read = (relative: string): string =>
  readFileSync(join(repoRoot, relative), "utf8");

const P4_PACKAGES = [
  "packages/tool-runtime",
  "adapters/sandbox-local",
  "adapters/blob-local",
];

describe("p4 harness wiring", () => {
  it("creates each P4 package root with a manifest, tsconfig, and entry", () => {
    for (const pkg of P4_PACKAGES) {
      for (const file of ["package.json", "tsconfig.json", "src/index.ts"]) {
        expect(existsSync(join(repoRoot, pkg, file)), `${pkg}/${file}`).toBe(
          true,
        );
      }
    }
  });

  it("references every P4 package in the build solution", () => {
    const root = read("tsconfig.json");
    for (const ref of [
      "./packages/tool-runtime",
      "./adapters/sandbox-local",
      "./adapters/blob-local",
    ]) {
      expect(root).toContain(ref);
    }
  });

  it("keeps tool-runtime dependent on domain/ports only", () => {
    const manifest = JSON.parse(read("packages/tool-runtime/package.json")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@arbor/domain",
      "@arbor/ports",
    ]);
  });

  it("declares the P4 adapter edges in the architecture matrix", () => {
    const dag = read("tests/architecture/package-dag.ts");
    expect(dag).toContain('"sandbox-local": ["domain", "ports"]');
    expect(dag).toContain('"blob-local": ["domain", "ports"]');
  });
});
