import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkDomainImports,
  checkEdges,
  type PackageManifest,
} from "./package-dag.js";

const repoRoot = join(import.meta.dirname, "..", "..");

const readPackages = (): ReadonlyArray<PackageManifest> => {
  const packagesDir = join(repoRoot, "packages");
  if (!existsSync(packagesDir)) {
    return [];
  }
  return readdirSync(packagesDir)
    .filter((dir) => existsSync(join(packagesDir, dir, "package.json")))
    .map((dir) => {
      const manifest = JSON.parse(
        readFileSync(join(packagesDir, dir, "package.json"), "utf8"),
      ) as {
        name: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const allDeps = {
        ...manifest.dependencies,
        ...manifest.peerDependencies,
      };
      return {
        name: manifest.name.replace("@arbor/", ""),
        internalDependencies: Object.keys(allDeps)
          .filter((dep) => dep.startsWith("@arbor/"))
          .map((dep) => dep.replace("@arbor/", "")),
      };
    });
};

const readDomainSources = (): ReadonlyArray<{
  readonly path: string;
  readonly source: string;
}> => {
  const srcDir = join(repoRoot, "packages", "domain", "src");
  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => ({
      path: `packages/domain/src/${entry}`,
      source: readFileSync(join(srcDir, entry), "utf8"),
    }));
};

describe("package DAG architecture", () => {
  it("P0 packages declare only allowed internal edges", () => {
    expect(checkEdges(readPackages())).toEqual([]);
  });

  it("domain declares no internal dependency", () => {
    const domain = readPackages().find((pkg) => pkg.name === "domain");
    expect(domain?.internalDependencies).toEqual([]);
  });

  it("domain imports only relative, effect, or node: specifiers", () => {
    expect(checkDomainImports(readDomainSources())).toEqual([]);
  });

  it("checker fails on a forbidden edge", () => {
    expect(
      checkEdges([{ name: "domain", internalDependencies: ["ports"] }]),
    ).toEqual(["forbidden edge: domain -> ports"]);
  });

  it("checker fails on an unknown package", () => {
    expect(checkEdges([{ name: "mystery", internalDependencies: [] }])).toEqual(
      ["unknown package: mystery"],
    );
  });

  it("checker fails on a deep import", () => {
    expect(
      checkEdges([
        { name: "application", internalDependencies: ["domain/src/internal"] },
      ]),
    ).toEqual(["deep import: application -> domain/src/internal"]);
  });

  it("domain import checker fails on an infrastructure import", () => {
    expect(
      checkDomainImports([
        { path: "x.ts", source: 'import { db } from "sqlite";' },
      ]),
    ).toEqual(['x.ts: forbidden import "sqlite"']);
  });
});
