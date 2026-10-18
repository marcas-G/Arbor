import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const productionRoots = ["packages", "apps", "adapters"];
const fixedP39HostProbe =
  "adapters/persistence-sqlite/src/p39-windows-security.ts";

const sourceFiles = (root: string): ReadonlyArray<string> => {
  const absoluteRoot = join(repoRoot, root);
  if (!existsSync(absoluteRoot)) return [];
  return readdirSync(absoluteRoot, { withFileTypes: true }).flatMap((entry) => {
    const path = join(absoluteRoot, entry.name);
    if (entry.isDirectory()) {
      if (["test", "tests", "__tests__"].includes(entry.name)) return [];
      return sourceFiles(relative(repoRoot, path));
    }
    if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".diagnostic.ts")
    ) {
      return [path];
    }
    return [];
  });
};

describe("SandboxProcessPort architecture boundary", () => {
  it("routes production process creation through the sandbox provider adapter", () => {
    const directSpawnImports = productionRoots
      .flatMap(sourceFiles)
      .filter((file) => {
        const normalized = relative(repoRoot, file).split(sep).join("/");
        const source = readFileSync(file, "utf8");
        return (
          /from\s+["']node:child_process["']|require\(["']node:child_process["']\)/u.test(
            source,
          ) && normalized !== fixedP39HostProbe
        );
      })
      .map((file) => relative(repoRoot, file).split(sep).join("/"));

    expect(directSpawnImports).toEqual([]);
    expect(
      readFileSync(
        join(repoRoot, "packages/ports/src/sandbox-process.ts"),
        "utf8",
      ),
    ).toContain("SandboxProcessPort");
  });
});
