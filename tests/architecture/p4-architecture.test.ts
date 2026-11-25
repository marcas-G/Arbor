import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse } from "@babel/parser";
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

  it("keeps ToolRuntime failures stage-owned and cleanup out of the defect channel", () => {
    const errors = readFileSync(
      join(repoRoot, "packages/ports/src/errors.ts"),
      "utf8",
    );
    const runtime = readFileSync(
      join(repoRoot, "packages/tool-runtime/src/runtime.ts"),
      "utf8",
    );
    expect(errors).toContain("ToolRuntimeOperationalFailure");
    expect(errors).toContain("ToolRuntimeCleanupFailure");
    expect(errors).toContain(
      'effectDisposition: "NotStarted" | "OutcomeUncertain"',
    );
    expect(errors).not.toContain('readonly _tag: "ToolRuntimeError"');
    const runtimeDirectory = join(repoRoot, "packages/tool-runtime/src/runtime");
    const runtimeModules = readdirSync(runtimeDirectory, { recursive: true })
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(runtimeDirectory, name), "utf8"));
    const runtimeSource = [runtime, ...runtimeModules].join("\n");
    expect(runtimeSource).not.toContain("Effect.orDie");
    for (const stage of [
      "WorkspaceLookup",
      "EnvironmentResolution",
      "AuthorityResolution",
      "ApprovalLookup",
      "IntentJournal",
      "ResourceAdmission",
      "SandboxOpen",
      "Executor",
      "SettlementJournal",
      "SandboxClose",
    ]) {
      expect(runtimeSource).toContain(stage);
    }
  });

  it("keeps runtime lifecycle modules below the public entry and package barrel", () => {
    const directory = join(repoRoot, "packages/tool-runtime/src/runtime");
    const violations: string[] = [];
    for (const name of readdirSync(directory, { recursive: true }).filter(
      (entry) => entry.endsWith(".ts"),
    )) {
      const file = `runtime/${name.replaceAll("\\", "/")}`;
      const ast = parse(readFileSync(join(directory, name), "utf8"), {
        sourceType: "module",
        plugins: ["typescript"],
      });
      for (const statement of ast.program.body) {
        if (
          statement.type !== "ImportDeclaration" &&
          statement.type !== "ExportNamedDeclaration" &&
          statement.type !== "ExportAllDeclaration"
        ) continue;
        const specifier = statement.source?.value;
        if (specifier === undefined || !specifier.startsWith(".")) continue;
        const target = posix.normalize(
          posix.join(posix.dirname(file), specifier),
        ).replace(/\.(?:js|ts)$/u, "");
        if (target === "runtime" || target === "index") {
          violations.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("allows the P4 adapters only domain/ports", () => {
    for (const adapter of ["sandbox-local", "blob-local"]) {
      expect([...depsOf(adapter)].sort()).toEqual(["domain", "ports"]);
    }
  });
});
