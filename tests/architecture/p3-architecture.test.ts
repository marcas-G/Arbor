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

describe("P3 package DAG", () => {
  it("declares only allowed edges for the P3 packages", () => {
    expect(checkEdges(all())).toEqual([]);
  });

  it("bounds model-context and provider-runtime dependencies", () => {
    expect([...depsOf("model-context")].sort()).toEqual(["domain", "ports"]);
    expect([...depsOf("provider-runtime")].sort()).toEqual(["ports"]);
  });

  it("keeps agent-runtime free of provider-runtime implementation", () => {
    expect(depsOf("agent-runtime")).not.toContain("provider-runtime");
    expect(depsOf("agent-runtime")).not.toContain("tool-runtime");
  });

  it("keeps model-context free of tool-runtime", () => {
    expect(depsOf("model-context")).not.toContain("tool-runtime");
  });

  it("allows the provider-fake adapter only domain/ports", () => {
    expect([...depsOf("provider-fake")].sort()).toEqual(["domain", "ports"]);
  });
});
