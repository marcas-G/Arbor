/**
 * P13 `02` §8 / `06` EC-7 + EC-8 (source-scan half; the interactive-control
 * path scan belongs to P13-008): no command-panel source under src/ may
 * mention the two specially-forbidden commandTypes — not even in comments.
 * Mechanical, whole-src, no path whitelist yet.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN_COMMAND_TYPES = ["SelectCurrentWork", "SendMessage"];

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

const srcRoot = join(process.cwd(), "src");

describe("no forbidden command controls in src", () => {
  it("src/** never mentions the specially-forbidden commandTypes", () => {
    const scanned = collectSourceFiles(srcRoot);
    expect(scanned.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const path of scanned) {
      const source = readFileSync(path, { encoding: "utf8" });
      for (const forbidden of FORBIDDEN_COMMAND_TYPES) {
        if (source.includes(forbidden)) {
          violations.push(`${path}: ${forbidden}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
