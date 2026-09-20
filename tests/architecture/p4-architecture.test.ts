import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkEdges, type PackageManifest } from "./package-dag.js";

const repoRoot = join(import.meta.dirname, "..", "..");

const manifests = (dirName: string): ReadonlyArray<PackageManifest> => {
  const dir = join(repoRoot, dirName);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => existsSync(join(dir, entry, "package.json")))
    .map((entry) => {
      const manifest = JSON.parse(
        readFileSync(join(dir, entry, "package.json"), "utf8"),
      ) as {
        name: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const deps = { ...manifest.dependencies, ...manifest.peerDependencies };
      return {
        name: manifest.name.replace("@arbor/", ""),
        internalDependencies: Object.keys(deps)
          .filter((dep) => dep.startsWith("@arbor/"))
          .map((dep) => dep.replace("@arbor/", "")),
      };
    });
};

const all = (): ReadonlyArray<PackageManifest> => [
  ...manifests("packages"),
  ...manifests("adapters"),
];

const depsOf = (name: string): ReadonlyArray<string> =>
  all().find((pkg) => pkg.name === name)?.internalDependencies ?? [];

describe("P4 package DAG", () => {
  it("declares only allowed edges for the P4 packages", () => {
    expect(checkEdges(all())).toEqual([]);
  });

  it("bounds tool-runtime dependencies", () => {
    expect([...depsOf("tool-runtime")].sort()).toEqual(["domain", "ports"]);
  });

  it("keeps tool-runtime free of model-context and agent-runtime", () => {
    expect(depsOf("tool-runtime")).not.toContain("model-context");
    expect(depsOf("tool-runtime")).not.toContain("agent-runtime");
    expect(depsOf("model-context")).not.toContain("tool-runtime");
    expect(depsOf("agent-runtime")).not.toContain("tool-runtime");
  });

  it("allows the P4 adapters only domain/ports", () => {
    for (const adapter of ["sandbox-local", "blob-local"]) {
      expect([...depsOf(adapter)].sort()).toEqual(["domain", "ports"]);
    }
  });
});
