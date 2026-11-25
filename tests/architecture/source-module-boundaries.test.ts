import { readdirSync, readFileSync } from "node:fs";
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
] as const;

describe("R5 module ownership", () => {
  for (const group of moduleGroups) {
    it(`keeps ${group.packageRoot}/${group.directory} below its facade and package barrel`, () => {
      const directory = join(
        repoRoot,
        group.packageRoot,
        group.directory,
      );
      const violations: string[] = [];
      for (const name of readdirSync(directory, { recursive: true }).filter(
        (entry) => entry.endsWith(".ts"),
      )) {
        const file = posix.join(group.directory, name.replaceAll("\\", "/"));
        const ast = parse(readFileSync(join(directory, name), "utf8"), {
          sourceType: "module",
          plugins: ["typescript"],
        });
        for (const statement of ast.program.body) {
          if (
            statement.type !== "ImportDeclaration" &&
            statement.type !== "ExportNamedDeclaration" &&
            statement.type !== "ExportAllDeclaration"
          ) {
            continue;
          }
          const specifier = statement.source?.value;
          if (specifier === undefined || !specifier.startsWith(".")) continue;
          const target = posix
            .normalize(posix.join(posix.dirname(file), specifier))
            .replace(/\.(?:js|ts)$/u, "");
          if (target === group.facade || target === "index") {
            violations.push(`${file}: ${specifier}`);
          }
        }
      }
      expect(violations).toEqual([]);
    });
  }
});
