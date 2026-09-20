import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_EDGES,
  checkEdges,
  type PackageManifest,
} from "./package-dag.js";

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

describe("P2 package DAG", () => {
  it("declares only allowed edges for the P2 packages", () => {
    expect(checkEdges(all())).toEqual([]);
  });

  it("bounds execution-runtime and agent-runtime dependencies", () => {
    expect([...depsOf("execution-runtime")].sort()).toEqual([
      "agent-runtime",
      "application",
      "domain",
      "ports",
    ]);
    expect([...depsOf("agent-runtime")].sort()).toEqual([
      "application",
      "domain",
      "ports",
    ]);
  });

  it("keeps runtime packages free of adapter edges", () => {
    for (const runtime of [
      "execution-runtime",
      "agent-runtime",
      "application",
      "ports",
    ]) {
      expect(depsOf(runtime)).not.toContain("persistence-sqlite");
      expect(depsOf(runtime)).not.toContain("worker-local");
    }
  });

  it("allows the worker-local adapter only domain/ports", () => {
    expect([...depsOf("worker-local")].sort()).toEqual(["domain", "ports"]);
    expect(ALLOWED_EDGES["worker-local"]).toEqual(["domain", "ports"]);
  });

  it("keeps testkit out of production dependencies", () => {
    for (const pkg of all()) {
      if (pkg.name !== "testkit") {
        expect(pkg.internalDependencies).not.toContain("testkit");
      }
    }
  });
});
