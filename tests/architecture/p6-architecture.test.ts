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

const P6_APPLICATION_SOURCES: ReadonlyArray<string> = [
  "packages/application/src/formation-plan.ts",
  "packages/application/src/formation-consumer.ts",
  "packages/application/src/capability-ceiling.ts",
  "packages/application/src/specialist-settlement.ts",
  "packages/application/src/inbox-consumption.ts",
  "packages/application/src/critical-steer.ts",
  "packages/application/src/commands/record-decision.ts",
  "packages/application/src/commands/send-message.ts",
  "packages/application/src/commands/steer-work.ts",
];

const P6_PROMPT_PROGRAMS: ReadonlyArray<string> = [
  "packages/agent-runtime/promptPrograms/formation/v1.md",
  "packages/agent-runtime/promptPrograms/communication/v1.md",
  "packages/agent-runtime/promptPrograms/bootstrap/v1.md",
  "packages/agent-runtime/promptPrograms/human-steer/v1.md",
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

const dependencyKeysOf = (relativePath: string): ReadonlyArray<string> => {
  const manifest = readRawManifest(relativePath);
  return Object.keys(manifest.dependencies ?? {});
};

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

describe("p6-architecture", () => {
  it("P6 production modules exist at their frozen locations", () => {
    for (const relativePath of P6_APPLICATION_SOURCES) {
      const absolute = join(repoRoot, relativePath);
      expect(existsSync(absolute), relativePath).toBe(true);
      expect(
        readFileSync(absolute, "utf8").length,
        relativePath,
      ).toBeGreaterThan(0);
    }
  });

  it("application stays below execution-runtime (DID §10.4.1)", () => {
    const application = manifests("packages").find(
      (pkg) => pkg.name === "application",
    );
    expect(application).toBeDefined();
    expect(checkEdges([application as PackageManifest], ALLOWED_EDGES)).toEqual(
      [],
    );

    const sources = applicationSources();
    expect(sources.length).toBeGreaterThan(10);
    const importRe = /from\s+"([^"]+)"/g;
    const offenders: ReadonlyArray<string> = sources.flatMap((file) => {
      const hits: string[] = [];
      for (const match of file.source.matchAll(importRe)) {
        const specifier = match[1] ?? "";
        if (
          specifier === "@arbor/execution-runtime" ||
          specifier.startsWith("@arbor/execution-runtime/")
        ) {
          hits.push(`${file.path}: "${specifier}"`);
        }
      }
      return hits;
    });
    expect(offenders).toEqual([]);
  });

  it("application import guard is non-vacuous on a synthetic offender", () => {
    const importRe = /from\s+"([^"]+)"/g;
    const synthetic =
      'import { x } from "@arbor/execution-runtime";\nimport { y } from "@arbor/domain";';
    const hits: string[] = [];
    for (const match of synthetic.matchAll(importRe)) {
      const specifier = match[1] ?? "";
      if (
        specifier === "@arbor/execution-runtime" ||
        specifier.startsWith("@arbor/execution-runtime/")
      ) {
        hits.push(specifier);
      }
    }
    expect(hits).toEqual(["@arbor/execution-runtime"]);
  });

  it("agent-runtime ships the four P6 prompt program families", () => {
    for (const relativePath of P6_PROMPT_PROGRAMS) {
      const absolute = join(repoRoot, relativePath);
      expect(existsSync(absolute), relativePath).toBe(true);
      const content = readFileSync(absolute, "utf8");
      expect(content.length, relativePath).toBeGreaterThan(0);
      expect(content).toMatch(/^contractRevision:/m);
      expect(content).toMatch(/^textVersion:/m);
      expect(content).toMatch(/^textHash:/m);
    }
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
  });

  it("packages declare no npm dependency beyond {effect, @arbor/*}", () => {
    const packagesDir = join(repoRoot, "packages");
    const allowed = (key: string) =>
      key === "effect" || key.startsWith("@arbor/");
    for (const entry of readdirSync(packagesDir)) {
      const manifestPath = join(packagesDir, entry, "package.json");
      if (!existsSync(manifestPath)) {
        continue;
      }
      const keys = dependencyKeysOf(`packages/${entry}/package.json`);
      const offenders = keys.filter((key) => !allowed(key));
      expect(offenders, `packages/${entry}`).toEqual([]);
    }
  });

  it("application and agent-runtime add no new dependency keys vs git HEAD", () => {
    for (const relativePath of [
      "packages/application/package.json",
      "packages/agent-runtime/package.json",
    ] as const) {
      const head = headDependencyKeys(relativePath);
      if (head === null) {
        continue;
      }
      const current = [...dependencyKeysOf(relativePath)].sort();
      const added = current.filter((key) => !head.includes(key));
      expect(added, relativePath).toEqual([]);
    }
  });
});
