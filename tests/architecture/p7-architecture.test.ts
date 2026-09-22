import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_EDGES,
  checkEdges,
  type PackageManifest,
} from "./package-dag.js";

const repoRoot = join(import.meta.dirname, "..", "..");

const P7_APPLICATION_MODULES: ReadonlyArray<string> = [
  "packages/application/src/dependency-coordinator.ts",
  "packages/application/src/wake-sink.ts",
  "packages/application/src/wait-graph.ts",
  "packages/application/src/commands/declare-dependency.ts",
  "packages/application/src/commands/produce-deliverable.ts",
  "packages/application/src/commands/satisfy-dependency.ts",
  "packages/application/src/commands/deliver-command.ts",
  "packages/application/src/commands/dependency-transitions.ts",
];

const P7_COMMAND_MODULES: ReadonlyArray<{
  readonly file: string;
  readonly commandTypes: ReadonlyArray<string>;
}> = [
  {
    file: "packages/application/src/commands/declare-dependency.ts",
    commandTypes: ["DeclareDependency"],
  },
  {
    file: "packages/application/src/commands/produce-deliverable.ts",
    commandTypes: ["ProduceDeliverable"],
  },
  {
    file: "packages/application/src/commands/satisfy-dependency.ts",
    commandTypes: ["SatisfyDependency"],
  },
  {
    file: "packages/application/src/commands/dependency-transitions.ts",
    commandTypes: [
      "WithdrawDependency",
      "MarkDependencyUnfulfillable",
      "ReviseDependencyContract",
    ],
  },
];

const P7_ADAPTER_MODULES: ReadonlyArray<string> = [
  "adapters/persistence-sqlite/src/dependency-store.ts",
];

const P7_APPS_MODULES: ReadonlyArray<string> = [
  "apps/single-workspace/src/runnable-source-p7.ts",
  "apps/single-workspace/src/governance-directive.ts",
];

const WAIT_GRAPH_SEAM_EXPORTS: ReadonlyArray<string> = [
  "export interface DeadlockDetector",
  "export const conservativeDetector",
  "export interface ParticipatingEdge",
  "detector: DeadlockDetector = conservativeDetector",
];

interface RawManifest {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

const readRawManifest = (relativePath: string): RawManifest =>
  JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")) as RawManifest;

const manifests = (dirName: string): ReadonlyArray<PackageManifest> => {
  const dir = join(repoRoot, dirName);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => existsSync(join(dir, entry, "package.json")))
    .map((entry) => {
      const manifest = readRawManifest(join(dirName, entry, "package.json"));
      const deps = {
        ...manifest.dependencies,
        ...manifest.peerDependencies,
      };
      return {
        name: manifest.name.replace("@arbor/", ""),
        internalDependencies: Object.keys(deps)
          .filter((dep) => dep.startsWith("@arbor/"))
          .map((dep) => dep.replace("@arbor/", "")),
      };
    });
};

const sourceOf = (relativePath: string): string =>
  readFileSync(join(repoRoot, relativePath), "utf8");

const applicationSources = (): ReadonlyArray<{
  readonly path: string;
  readonly source: string;
}> => {
  const srcDir = join(repoRoot, "packages", "application", "src");
  const files: Array<{ readonly path: string; readonly source: string }> = [];
  for (const file of readdirSync(srcDir, {
    recursive: true,
    encoding: "utf8",
  })) {
    if (!file.endsWith(".ts")) {
      continue;
    }
    files.push({
      path: `packages/application/src/${file}`,
      source: readFileSync(join(srcDir, file), "utf8"),
    });
  }
  return files;
};

const dependencyKeysOf = (relativePath: string): ReadonlyArray<string> =>
  Object.keys(readRawManifest(relativePath).dependencies ?? {});

const headDependencyKeys = (
  relativePath: string,
): ReadonlyArray<string> | null => {
  try {
    const stdout = execSync(`git show HEAD:${relativePath}`, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const manifest = JSON.parse(stdout) as RawManifest;
    return Object.keys(manifest.dependencies ?? {}).sort();
  } catch {
    return null;
  }
};

const offendersImporting = (
  sources: ReadonlyArray<{ readonly path: string; readonly source: string }>,
  forbidden: (specifier: string) => boolean,
): ReadonlyArray<string> => {
  const importRe = /from\s+"([^"]+)"/g;
  return sources.flatMap((file) => {
    const hits: string[] = [];
    for (const match of file.source.matchAll(importRe)) {
      const specifier = match[1] ?? "";
      if (forbidden(specifier)) {
        hits.push(`${file.path}: "${specifier}"`);
      }
    }
    return hits;
  });
};

const P7_TOUCHED_MANIFESTS: ReadonlyArray<string> = [
  "packages/domain/package.json",
  "packages/ports/package.json",
  "packages/application/package.json",
  "adapters/persistence-sqlite/package.json",
  // `apps/single-workspace/package.json` is intentionally absent: it is no
  // longer solely P7-touched — later phases (P12-003 secret adapters) extend
  // the Composition Root's dependency set. Package-DAG rules still constrain
  // every edge (tests/architecture/package-dag.ts).
];

describe("p7-architecture", () => {
  it("P7 production modules exist at their frozen locations", () => {
    for (const relativePath of [
      ...P7_APPLICATION_MODULES,
      ...P7_ADAPTER_MODULES,
      ...P7_APPS_MODULES,
    ]) {
      const absolute = join(repoRoot, relativePath);
      expect(existsSync(absolute), relativePath).toBe(true);
      expect(sourceOf(relativePath).length, relativePath).toBeGreaterThan(0);
    }
  });

  it("the six P7 dependency command faces live in their command modules", () => {
    const commandTypes = P7_COMMAND_MODULES.flatMap(
      (entry) => entry.commandTypes,
    );
    expect(commandTypes).toHaveLength(6);
    for (const entry of P7_COMMAND_MODULES) {
      const source = sourceOf(entry.file);
      for (const commandType of entry.commandTypes) {
        expect(
          source.includes(`commandType: "${commandType}"`),
          `${entry.file}: ${commandType}`,
        ).toBe(true);
      }
    }
  });

  it("application stays below execution-runtime (DID §10.4.1, P6 rule continuation)", () => {
    const application = manifests("packages").find(
      (pkg) => pkg.name === "application",
    );
    expect(application).toBeDefined();
    expect(checkEdges([application as PackageManifest], ALLOWED_EDGES)).toEqual(
      [],
    );

    const sources = applicationSources();
    expect(sources.length).toBeGreaterThan(10);
    const offenders = offendersImporting(sources, (specifier) =>
      specifier === "@arbor/execution-runtime"
        ? true
        : specifier.startsWith("@arbor/execution-runtime/"),
    );
    expect(offenders).toEqual([]);

    const synthetic =
      'import { x } from "@arbor/execution-runtime";\nimport { y } from "@arbor/domain";';
    const syntheticHits: string[] = [];
    for (const match of synthetic.matchAll(/from\s+"([^"]+)"/g)) {
      const specifier = match[1] ?? "";
      if (
        specifier === "@arbor/execution-runtime" ||
        specifier.startsWith("@arbor/execution-runtime/")
      ) {
        syntheticHits.push(specifier);
      }
    }
    expect(syntheticHits).toEqual(["@arbor/execution-runtime"]);
  });

  it("no package or adapter depends on apps/* (P5 rule continuation)", () => {
    const apps = new Set(manifests("apps").map((app) => app.name));
    expect(apps.size).toBeGreaterThan(0);
    const production = [...manifests("packages"), ...manifests("adapters")];
    expect(production.length).toBeGreaterThan(0);
    const offenders = production.flatMap((pkg) =>
      pkg.internalDependencies
        .filter((dependency) => apps.has(dependency))
        .map((dependency) => `${pkg.name} -> ${dependency}`),
    );
    expect(offenders).toEqual([]);

    const synthetic: ReadonlyArray<PackageManifest> = [
      { name: "application", internalDependencies: ["single-workspace"] },
      { name: "persistence-sqlite", internalDependencies: ["ports"] },
    ];
    expect(
      synthetic.flatMap((pkg) =>
        pkg.internalDependencies
          .filter((dependency) => new Set(["single-workspace"]).has(dependency))
          .map((dependency) => `${pkg.name} -> ${dependency}`),
      ),
    ).toEqual(["application -> single-workspace"]);
  });

  it("production packages and adapters declare no npm dependency beyond {effect, @effect/*, @arbor/*}", () => {
    const allowed = (key: string) =>
      key === "effect" ||
      key.startsWith("@effect/") ||
      key.startsWith("@arbor/");
    for (const dirName of ["packages", "adapters"] as const) {
      const dir = join(repoRoot, dirName);
      for (const entry of readdirSync(dir)) {
        const relativePath = `${dirName}/${entry}/package.json`;
        if (!existsSync(join(repoRoot, relativePath))) {
          continue;
        }
        const offenders = dependencyKeysOf(relativePath).filter(
          (key) => !allowed(key),
        );
        expect(offenders, relativePath).toEqual([]);
      }
    }
  });

  it("P7-touched manifests add no dependency keys vs git HEAD", () => {
    for (const relativePath of P7_TOUCHED_MANIFESTS) {
      const head = headDependencyKeys(relativePath);
      if (head === null) {
        continue;
      }
      const current = [...dependencyKeysOf(relativePath)].sort();
      const added = current.filter((key) => !head.includes(key));
      expect(added, relativePath).toEqual([]);
    }
  });

  it("wait-graph exports the replaceable detector seam (OR-aware upgrade reserve, 05 §2)", () => {
    const source = sourceOf("packages/application/src/wait-graph.ts");
    for (const marker of WAIT_GRAPH_SEAM_EXPORTS) {
      expect(source.includes(marker), marker).toBe(true);
    }
  });
});
