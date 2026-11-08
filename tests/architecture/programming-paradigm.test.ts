import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const productionRoots = ["packages", "apps", "adapters"];
const sourceExtensions = /\.(ts|tsx)$/;
const excludedSegments = [
  "\\test\\",
  "\\tests\\",
  "/test/",
  "/tests/",
  "fixtures",
];
const baselineTypeEscapeCount = 51;

const walk = (directory: string): string[] => {
  const entries = readdirSync(directory, {
    withFileTypes: true,
  }) as Array<{ name: string; isDirectory: () => boolean }>;
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return sourceExtensions.test(entry.name) ? [path] : [];
  });
};

describe("programming paradigm regression guards", () => {
  it("does not increase production unknown-to-unknown type escapes", () => {
    const matches = productionRoots
      .flatMap((directory) => walk(join(root, directory)))
      .filter(
        (path) => !excludedSegments.some((segment) => path.includes(segment)),
      )
      .flatMap((path) =>
        readFileSync(path, "utf8")
          .split("\n")
          .filter(
            (line) =>
              line.includes("as unknown as") &&
              !line.trimStart().startsWith("//") &&
              !line.trimStart().startsWith("*"),
          ),
      );
    expect(matches.length).toBeLessThanOrEqual(baselineTypeEscapeCount);
  });

  it("keeps the Domain package free of infrastructure imports", () => {
    const domainFiles = walk(join(root, "packages", "domain"));
    const forbidden =
      /from\s+["'](?:node:|effect\/unstable\/sql|@arbor\/(?:ports|application|provider|tool-runtime|persistence))/;
    const violations = domainFiles.flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => forbidden.test(line))
        .map((line) => `${path}: ${line.trim()}`),
    );
    expect(violations).toEqual([]);
  });

  it("keeps the proof-level manifest present", () => {
    const manifest = readFileSync(
      join(root, "planning", "programming-paradigm", "07-test-proof-levels.md"),
      "utf8",
    );
    for (const level of ["Pure", "Port", "Application", "Process", "Public"]) {
      expect(manifest).toContain(`| ${level} |`);
    }
  });
});
