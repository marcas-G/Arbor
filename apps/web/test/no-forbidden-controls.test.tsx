/**
 * P13 `02` §8 / `06` EC-7 + EC-8 (source-scan half; the interactive-control
 * path scan belongs to P13-008) and P14 `05` seams S3/S8/S9: no source under
 * src/ may mention the forbidden commandTypes or provider-streaming
 * transport — not even in comments. Mechanical, whole-src, no path whitelist.
 * P14 TR-B adds the positive half: `SubmitHumanMessage` (the 8th
 * human-actionable command) MUST be present, while SendMessage stays banned.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN_COMMAND_TYPES = [
  "SelectCurrentWork",
  "SendMessage",
  "AdmitExecution",
];

/** P14 seam S9: no push/streaming transport may exist in the browser client. */
const FORBIDDEN_STREAMING_CHANNELS = [
  "EventSource",
  "ReadableStream",
  "TextDecoder",
  "TransformStream",
  "getReader",
];

const DEFERRED_D7_REVISION_LITERALS = [
  "pages/work/WorkPage.tsx: targetWorkRevision={0}",
  "pages/work/WorkPage.tsx: expectedWorkRevision={0}",
  "pages/workspace/WorkspacePage.tsx: expectedWorkRevision={0}",
];

const REVISION_LITERAL =
  /\b(expectedWorkRevision|targetWorkRevision)\s*=\s*\{\s*(-?\d+)\s*\}/g;
const REVISION_OBJECT_LITERAL =
  /\b(expectedWorkRevision|targetWorkRevision)\s*:\s*-?\d+\b/;
const REVISION_ZERO_FALLBACK =
  /\b(expectedWorkRevision|targetWorkRevision)\b[^\n;]*(?:\?\?|\|\|)\s*0\b/;

const FORBIDDEN_TRANSCRIPT_MUTATIONS: ReadonlyArray<{
  readonly label: string;
  readonly pattern: RegExp;
}> = [
  { label: "setTranscript", pattern: /\bsetTranscript(?:Entries)?\b/ },
  { label: "setEntries", pattern: /\bsetEntries\b/ },
  {
    label: "transcript cache write",
    pattern: /\bsetQuer(?:y|ies)Data\s*\(/,
  },
  {
    label: "transcript entries mutation",
    pattern:
      /\b(?:transcript(?:\.data)?\.entries|entries)\.(?:push|splice|unshift)\s*\(/,
  },
  {
    label: "local Transcript state",
    pattern: /\buseState\s*<\s*(?:TranscriptRes|TranscriptEntry)/,
  },
];

const FORBIDDEN_SERVER_STATE_CACHE_WRITES: ReadonlyArray<{
  readonly label: string;
  readonly pattern: RegExp;
}> = [{ label: "Query cache write", pattern: /\bsetQuer(?:y|ies)Data\s*\(/ }];

const INDEXED_ROOT_SELECTION = /\.nodes(?:\s*\[\s*0\s*\]|\s*\.at\(\s*0\s*\))/;

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

  it("adds no revision literal or fallback beyond the explicit D7 debt", () => {
    const deferred: string[] = [];
    const violations: string[] = [];
    for (const path of collectSourceFiles(srcRoot)) {
      const source = readFileSync(path, { encoding: "utf8" });
      const sourcePath = relative(srcRoot, path);
      for (const match of source.matchAll(REVISION_LITERAL)) {
        deferred.push(`${sourcePath}: ${match[0]}`);
      }
      if (REVISION_OBJECT_LITERAL.test(source)) {
        violations.push(`${sourcePath}: numeric revision object literal`);
      }
      if (REVISION_ZERO_FALLBACK.test(source)) {
        violations.push(`${sourcePath}: zero revision fallback`);
      }
    }
    expect(deferred).toEqual(DEFERRED_D7_REVISION_LITERALS);
    expect(violations).toEqual([]);
  });

  it("root selection uses the server parent carrier, never nodes[0]", () => {
    const violations = collectSourceFiles(srcRoot).filter((path) =>
      INDEXED_ROOT_SELECTION.test(readFileSync(path, { encoding: "utf8" })),
    );
    expect(violations).toEqual([]);
  });

  it("WebSocket handling never imports or interprets transcript payloads", () => {
    const violations = collectSourceFiles(srcRoot).filter((path) => {
      const source = readFileSync(path, { encoding: "utf8" });
      return (
        /\bWebSocket\b/.test(source) &&
        /\b(?:TranscriptRes|TranscriptEntry|transcript)\b/i.test(source)
      );
    });
    expect(violations).toEqual([]);
  });

  it("transcript sources never mutate local entries or the query cache", () => {
    const violations: string[] = [];
    for (const path of collectSourceFiles(srcRoot)) {
      const source = readFileSync(path, { encoding: "utf8" });
      if (!/\btranscript\b/i.test(source)) {
        continue;
      }
      for (const forbidden of FORBIDDEN_TRANSCRIPT_MUTATIONS) {
        if (forbidden.pattern.test(source)) {
          violations.push(`${path}: ${forbidden.label}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps server view state on the fetch/refetch path, without local Query cache writes", () => {
    const violations: string[] = [];
    for (const path of collectSourceFiles(srcRoot)) {
      const source = readFileSync(path, { encoding: "utf8" });
      for (const forbidden of FORBIDDEN_SERVER_STATE_CACHE_WRITES) {
        if (forbidden.pattern.test(source)) {
          violations.push(`${path}: ${forbidden.label}`);
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
