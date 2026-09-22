import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkDomainImports,
  checkEdges,
  checkForbiddenPatterns,
  type PackageManifest,
} from "./package-dag.js";

const repoRoot = join(import.meta.dirname, "..", "..");

const readManifests = (dirName: string): ReadonlyArray<PackageManifest> => {
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

const readPackages = (): ReadonlyArray<PackageManifest> => [
  ...readManifests("packages"),
  ...readManifests("adapters"),
];

const readSources = (
  dirName: string,
): ReadonlyArray<{ readonly path: string; readonly source: string }> => {
  const dir = join(repoRoot, dirName);
  if (!existsSync(dir)) {
    return [];
  }
  const files: Array<{ readonly path: string; readonly source: string }> = [];
  for (const entry of readdirSync(dir)) {
    const srcDir = join(dir, entry, "src");
    if (!existsSync(srcDir)) {
      continue;
    }
    for (const file of readdirSync(srcDir, {
      recursive: true,
      encoding: "utf8",
    })) {
      if (!file.endsWith(".ts")) {
        continue;
      }
      files.push({
        path: `${dirName}/${entry}/src/${file}`,
        source: readFileSync(join(srcDir, file), "utf8"),
      });
    }
  }
  return files;
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

const dependenciesOf = (name: string): ReadonlyArray<string> =>
  readPackages().find((pkg) => pkg.name === name)?.internalDependencies ?? [];

describe("package DAG architecture", () => {
  it("all packages declare only allowed internal edges", () => {
    expect(checkEdges(readPackages())).toEqual([]);
  });

  it("ports depends on domain only", () => {
    expect([...dependenciesOf("ports")].sort()).toEqual(["domain"]);
  });

  it("api-contracts depends on domain only (DID 10.4.1, P10-002)", () => {
    expect([...dependenciesOf("api-contracts")].sort()).toEqual(["domain"]);
  });

  it("application depends on domain and ports only", () => {
    expect([...dependenciesOf("application")].sort()).toEqual([
      "domain",
      "ports",
    ]);
  });

  it("adapters depend on domain and ports only", () => {
    for (const adapter of ["persistence-sqlite", "environment-local"]) {
      expect([...dependenciesOf(adapter)].sort()).toEqual(["domain", "ports"]);
    }
  });

  it("no catch-all error handling or service locator outside domain", () => {
    const sources = [
      ...readSources("packages"),
      ...readSources("adapters"),
    ].filter((file) => !file.path.startsWith("packages/domain/"));
    expect(checkForbiddenPatterns(sources)).toEqual([]);
  });

  it("checker fails on a synthetic forbidden pattern", () => {
    expect(
      checkForbiddenPatterns([
        { path: "x.ts", source: "Effect.catchAll(foo)" },
      ]),
    ).toEqual(["x.ts: forbidden catch-all error handling"]);
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
