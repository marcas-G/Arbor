/**
 * W-04 architecture lock (fs source scan): src/pages/tree stays a read-only
 * navigation surface — zero command-issuance vocabulary in any source file
 * (code or comments), and the page tests only ever mock /views/ query
 * fetches (route-path literals /p/** are navigation assertions, not fetch
 * URLs; the runtime guard `startsWith("/views/")` must stay in place).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN_TERMS: ReadonlyArray<string> = [
  "submitCommand",
  "useCommandSubmission",
  "catalog",
  "RecordDecision",
  "SteerWork",
  "StopExecution",
  "/commands",
  "AcceptWorkOutcome",
  "GrantPermission",
];

function collectSourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      collectSourceFiles(path, found);
    } else if (/\.(ts|tsx|css)$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

const treeRoot = join(process.cwd(), "src", "pages", "tree");
const pageTestPath = join(process.cwd(), "test", "tree-page.test.tsx");

describe("W-04 tree page read-only lock", () => {
  it("src/pages/tree/** contains no command-issuance vocabulary", () => {
    const scanned = collectSourceFiles(treeRoot);
    expect(scanned.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const path of scanned) {
      const source = readFileSync(path, { encoding: "utf8" });
      for (const forbidden of FORBIDDEN_TERMS) {
        if (source.includes(forbidden)) {
          violations.push(`${path}: ${forbidden}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("page tests only fetch /views/ URLs (guard present, no other fetch URL literals)", () => {
    const source = readFileSync(pageTestPath, { encoding: "utf8" });
    expect(source.includes('startsWith("/views/")')).toBe(true);
    const literals = [
      ...source.matchAll(/"([^"]*)"/g),
      ...source.matchAll(/`([^`]*)`/g),
    ].map((match) => match[1] ?? "");
    // "/" is the history-reset root; /p/** are router pathnames (navigation
    // assertions, not fetch URLs). Anything else must be a /views/ query.
    const fetchUrlLiterals = literals.filter(
      (literal) =>
        literal.startsWith("/") &&
        literal !== "/" &&
        !literal.startsWith("/p/"),
    );
    expect(fetchUrlLiterals.length).toBeGreaterThan(0);
    expect(
      fetchUrlLiterals.every((literal) => literal.startsWith("/views/")),
    ).toBe(true);
  });
});
