import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");

const importSpecifiersOf = (source: string): ReadonlyArray<string> => {
  const out: Array<string> = [];
  const importRe = /from\s+"([^"]+)"/g;
  for (const match of source.matchAll(importRe)) {
    out.push(match[1] ?? "");
  }
  return out;
};

/** The P12 `04` §2 observability module physical home (E-16). */
const OBSERVABILITY_IMPORT =
  /^(\.\/observability|\.\.\/observability|\.\.\/\.\.\/projection-runtime|@arbor\/projection-runtime)/;

/** Telemetry / observability services that must never enter a decision R channel. */
const TELEMETRY_SERVICES = [
  "UsageService",
  "HealthPort",
  "PersistenceHealthProbe",
  "TelemetryService",
  "ObservabilityService",
] as const;

const DECISION_FILES = [
  ["packages/execution-runtime/src/scheduler.ts", "scheduler"],
  ["packages/tool-runtime/src/admission.ts", "tool admission"],
] as const;

describe("p12-observability-boundaries (G4 / CI-3)", () => {
  it("scheduler and tool admission do not import the observability module or projection-runtime", () => {
    for (const [relative, label] of DECISION_FILES) {
      const file = join(repoRoot, relative);
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiersOf(source)) {
        expect(
          OBSERVABILITY_IMPORT.test(specifier),
          `${label} (${relative}): forbidden observability import "${specifier}"`,
        ).toBe(false);
      }
    }
  });

  it("scheduler decide() / tool admission R channels contain no telemetry service", () => {
    for (const [relative, label] of DECISION_FILES) {
      const source = readFileSync(join(repoRoot, relative), "utf8");
      for (const service of TELEMETRY_SERVICES) {
        expect(
          source.includes(service),
          `${label} (${relative}): telemetry service "${service}" must not be reachable from its R channel`,
        ).toBe(false);
      }
    }
  });

  it("no source file under execution-runtime / tool-runtime imports the observability module", () => {
    const files = [
      "packages/execution-runtime/src/scheduler.ts",
      "packages/tool-runtime/src/admission.ts",
    ];
    for (const relative of files) {
      const source = readFileSync(join(repoRoot, relative), "utf8");
      expect(source.includes("@arbor/projection-runtime")).toBe(false);
      expect(source.includes("observability")).toBe(false);
    }
  });
});
