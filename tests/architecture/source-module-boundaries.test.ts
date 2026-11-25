import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");

const moduleGroups = [
  {
    packageRoot: "packages/application/src",
    directory: "external-command-codec",
    facade: "external-command-codec",
  },
  {
    packageRoot: "packages/provider-runtime/src",
    directory: "runtime",
    facade: "runtime",
  },
  {
    packageRoot: "packages/ports/src",
    directory: "provider",
    facade: "provider",
  },
  {
    packageRoot: "packages/agent-runtime/src",
    directory: "agent-loop-driver",
    facade: "agent-loop-driver",
  },
  {
    packageRoot: "packages/execution-runtime/src",
    directory: "execution",
    facade: "execution-runtime",
  },
  {
    packageRoot: "packages/execution-runtime/src",
    directory: "recovery",
    facade: "recovery",
  },
  {
    packageRoot: "adapters/persistence-sqlite/src",
    directory: "migrations",
    facade: "migrations",
  },
  {
    packageRoot: "adapters/persistence-sqlite/src",
    directory: "attention-projection",
    facade: "attention-projection",
  },
  {
    packageRoot: "adapters/persistence-sqlite/src",
    directory: "recovery-attention-fact-store",
    facade: "recovery-attention-fact-store",
  },
  {
    packageRoot: "adapters/persistence-sqlite/src",
    directory: "ownership",
    facade: "ownership",
  },
  {
    packageRoot: "packages/tool-runtime/src",
    directory: "runtime",
    facade: "runtime",
  },
] as const;

const relativeSpecifiers = (source: string): ReadonlyArray<string> => {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript"],
  });
  const specifiers: string[] = [];
  for (const statement of ast.program.body) {
    if (
      statement.type !== "ImportDeclaration" &&
      statement.type !== "ExportNamedDeclaration" &&
      statement.type !== "ExportAllDeclaration"
    ) {
      continue;
    }
    const specifier = statement.source?.value;
    if (specifier?.startsWith(".")) specifiers.push(specifier);
  }
  return specifiers;
};

const findCycles = (
  edges: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<string> => {
  const visited = new Set<string>();
  const active: string[] = [];
  const cycles: string[] = [];
  const visit = (file: string): void => {
    const repeated = active.indexOf(file);
    if (repeated >= 0) {
      cycles.push([...active.slice(repeated), file].join(" -> "));
      return;
    }
    if (visited.has(file)) return;
    active.push(file);
    for (const target of edges.get(file) ?? []) visit(target);
    active.pop();
    visited.add(file);
  };
  for (const file of edges.keys()) visit(file);
  return cycles;
};

describe("module ownership and local dependency DAG", () => {
  for (const group of moduleGroups) {
    it(`keeps ${group.packageRoot}/${group.directory} below its facade and package barrel`, () => {
      const packageRoot = join(repoRoot, group.packageRoot);
      const directory = join(packageRoot, group.directory);
      const privateFiles = readdirSync(directory, { recursive: true })
        .filter((entry) => entry.endsWith(".ts"))
        .map((entry) => posix.join(group.directory, entry.replaceAll("\\", "/")));
      expect(privateFiles.length).toBeGreaterThan(0);
      const files = [`${group.facade}.ts`, ...privateFiles];
      const localFiles = new Set(
        files.map((file) => file.replace(/\.ts$/u, "")),
      );
      const violations: string[] = [];
      const edges = new Map<string, string[]>();
      for (const file of files) {
        const source = readFileSync(join(packageRoot, file), "utf8");
        const key = file.replace(/\.ts$/u, "");
        const dependencies: string[] = [];
        for (const specifier of relativeSpecifiers(source)) {
          const resolved = posix.normalize(
            posix.join(posix.dirname(file), specifier),
          );
          const target = resolved.replace(/\.(?:js|ts)$/u, "");
          if (
            key !== group.facade &&
            (target === group.facade || target === "index")
          ) {
            violations.push(`${file}: reverse dependency ${specifier}`);
          }
          if (
            /\.(?:js|ts)$/u.test(resolved) &&
            !existsSync(join(packageRoot, `${target}.ts`)) &&
            !existsSync(join(packageRoot, resolved))
          ) {
            violations.push(`${file}: missing relative target ${specifier}`);
          }
          if (localFiles.has(target)) dependencies.push(target);
        }
        edges.set(key, dependencies);
      }
      expect(violations).toEqual([]);
      expect(findCycles(edges)).toEqual([]);
    });
  }
});
