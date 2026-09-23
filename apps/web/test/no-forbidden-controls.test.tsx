/**
 * P13 `02` §8 / `06` EC-7 + EC-8 (source-scan half; the interactive-control
 * path scan belongs to P13-008) and P14 `05` seams S3/S8/S9: no source under
 * src/ may mention the forbidden commandTypes or provider-streaming
 * transport — not even in comments. Mechanical, whole-src, no path whitelist.
 * P14 TR-B adds the positive half: `SubmitHumanMessage` (the 8th
 * human-actionable command) MUST be present, while SendMessage stays banned.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN_COMMAND_TYPES = [
  "SelectCurrentWork",
  "SendMessage",
  "AdmitExecution",
];

/** P14 seam S9: no push/streaming transport may exist in the browser client. */
const FORBIDDEN_STREAMING_CHANNELS = ["EventSource"];

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

  it("src/** opens no provider-streaming channel (S9)", () => {
    const scanned = collectSourceFiles(srcRoot);
    const violations: string[] = [];
    for (const path of scanned) {
      const source = readFileSync(path, { encoding: "utf8" });
      for (const forbidden of FORBIDDEN_STREAMING_CHANNELS) {
        if (source.includes(forbidden)) {
          violations.push(`${path}: ${forbidden}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("src/** exposes the 8th human-actionable command SubmitHumanMessage (TR-B)", () => {
    const scanned = collectSourceFiles(srcRoot);
    const present = scanned.some((path) =>
      readFileSync(path, { encoding: "utf8" }).includes("SubmitHumanMessage"),
    );
    expect(present).toBe(true);
  });
});
