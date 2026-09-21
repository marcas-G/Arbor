import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALLOWED_EDGES, type PackageManifest } from "./package-dag.js";

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

const production = (): ReadonlyArray<PackageManifest> => [
  ...manifests("packages"),
  ...manifests("adapters"),
];

const appNames = (): ReadonlyArray<string> =>
  manifests("apps").map((app) => app.name);

const dependentsOnApps = (
  packages: ReadonlyArray<PackageManifest>,
  apps: ReadonlySet<string>,
): ReadonlyArray<string> =>
  packages.flatMap((pkg) =>
    pkg.internalDependencies
      .filter((dependency) => apps.has(dependency))
      .map((dependency) => `${pkg.name} -> ${dependency}`),
  );

describe("P5 composition-root boundary (DID §10.1/§10.4.1)", () => {
  it("has a non-vacuous set of apps and packages", () => {
    expect(appNames().length).toBeGreaterThan(0);
    expect(production().length).toBeGreaterThan(0);
    expect(
      manifests("apps").find((app) => app.name === "single-workspace"),
    ).toBeDefined();
  });

  it("no package or adapter depends on apps/*", () => {
    expect(dependentsOnApps(production(), new Set(appNames()))).toEqual([]);
  });

  it("apps/* are not part of the package DAG matrix", () => {
    const matrix = new Set(Object.keys(ALLOWED_EDGES));
    for (const app of appNames()) {
      expect(matrix.has(app)).toBe(false);
    }
  });

  it("the app is a Composition Root, depending on packages and adapters", () => {
    const app = manifests("apps").find(
      (candidate) => candidate.name === "single-workspace",
    );
    expect(app).toBeDefined();
    const deps = app?.internalDependencies ?? [];
    expect(deps).toContain("application");
    expect(deps).toContain("execution-runtime");
    expect(deps).toContain("tool-runtime");
    expect(deps).toContain("persistence-sqlite");
    expect(deps).not.toContain("single-workspace");
  });

  it("rejects a synthetic production -> apps edge (non-vacuous)", () => {
    const synthetic: ReadonlyArray<PackageManifest> = [
      { name: "tool-runtime", internalDependencies: ["single-workspace"] },
      { name: "application", internalDependencies: ["domain", "ports"] },
    ];
    expect(dependentsOnApps(synthetic, new Set(["single-workspace"]))).toEqual([
      "tool-runtime -> single-workspace",
    ]);
  });
});
