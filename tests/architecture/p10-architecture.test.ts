import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const projectionRuntimeSrc = join(
  repoRoot,
  "packages",
  "projection-runtime",
  "src",
);

const walkSourceFiles = (
  dir: string,
  sink: Array<string> = [],
): ReadonlyArray<string> => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(path, sink);
    } else if (entry.name.endsWith(".ts")) {
      sink.push(path);
    }
  }
  return sink;
};

const sourceOf = (relativePath: string): string =>
  readFileSync(join(repoRoot, relativePath), "utf8");

const dependencyKeysOf = (relativePath: string): ReadonlyArray<string> =>
  Object.keys(
    (
      JSON.parse(sourceOf(relativePath)) as {
        dependencies?: Record<string, string>;
      }
    ).dependencies ?? {},
  );

const projectionRuntimeFiles = (): ReadonlyArray<{
  readonly path: string;
  readonly source: string;
}> =>
  walkSourceFiles(projectionRuntimeSrc).map((absolute) => ({
    path: `packages/projection-runtime/src/${absolute.slice(projectionRuntimeSrc.length + 1)}`,
    source: readFileSync(absolute, "utf8"),
  }));

/** projection-runtime imports domain + ports only (DID §10.4.1) — plus
 * effect / node builtins / relative files. No adapters, no SQL clients. */
const ALLOWED_PROJECTION_RUNTIME_SPECIFIERS =
  /^(\.\/|\.\.\/|effect|@arbor\/domain$|@arbor\/ports$|node:)/;

/** Canonical write faces — must never be called inside projection-runtime
 * (P10 `01` §3 / `02` §3: no view writes anything; GQ3/G8 zero mutation).
 * Read faces (findById, listX, classify, readAfter, lastSequence) are
 * absent from this list on purpose. */
const WRITE_FACE_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly label: string;
}> = [
  { pattern: /\.insert\s*\(/, label: "repository insert" },
  { pattern: /\.create\s*\(/, label: "repository create" },
  { pattern: /\.upsert\s*\(/, label: "store upsert" },
  { pattern: /\.append\s*\(/, label: "append" },
  { pattern: /\.update\s*[A-Z]/, label: "repository update CAS" },
  { pattern: /\.settle\s*\(/, label: "execution settle" },
  { pattern: /\.requestStop\s*\(/, label: "execution stop request" },
  {
    pattern: /\.admit(?:MainExecution|Execution)?\s*\(/,
    label: "execution admission",
  },
  { pattern: /\.concludeIfOpen\s*\(/, label: "verification conclude" },
  { pattern: /\.bindExecution\s*\(/, label: "verification execution binding" },
  { pattern: /\.clear\s*\(/, label: "wait clear" },
  { pattern: /\.schedule\s*\(/, label: "timer schedule" },
  { pattern: /\.cancel\s*\(/, label: "timer cancel" },
  { pattern: /\.transact\s*\(/, label: "transaction scope" },
  { pattern: /\.appendEntry\s*\(/, label: "session entry append" },
  { pattern: /\.releaseClaim\s*\(/, label: "ownership claim release" },
  { pattern: /\.insertClaim\s*\(/, label: "ownership claim insert" },
  { pattern: /sql\.unsafe\s*\(/, label: "direct SQL" },
];

describe("p10-architecture (projection-runtime)", () => {
  it("projection-runtime exists with its contract modules", () => {
    for (const relativePath of [
      "packages/projection-runtime/src/status.ts",
      "packages/projection-runtime/src/attention.ts",
      "packages/projection-runtime/src/attention-loader.ts",
      "packages/projection-runtime/src/tree.ts",
      "packages/projection-runtime/src/index.ts",
    ]) {
      expect(existsSync(join(repoRoot, relativePath)), relativePath).toBe(true);
      expect(sourceOf(relativePath).length, relativePath).toBeGreaterThan(0);
    }
  });

  it("projection-runtime declares exactly the domain+ports edge (DID §10.4.1; package-dag ALLOWED_EDGES)", () => {
    expect(
      [...dependencyKeysOf("packages/projection-runtime/package.json")].sort(),
    ).toEqual(["@arbor/domain", "@arbor/ports"]);
    const dag = sourceOf("tests/architecture/package-dag.ts");
    expect(dag.includes('"projection-runtime": ["domain", "ports"]')).toBe(
      true,
    );
  });

  it("projection-runtime imports only relative/effect/domain/ports specifiers — no adapters, no SQL clients", () => {
    const importRe = /from\s+"([^"]+)"/g;
    for (const file of projectionRuntimeFiles()) {
      for (const match of file.source.matchAll(importRe)) {
        const specifier = match[1] ?? "";
        expect(
          ALLOWED_PROJECTION_RUNTIME_SPECIFIERS.test(specifier),
          `${file.path}: forbidden import "${specifier}"`,
        ).toBe(true);
      }
      expect(file.source.includes("persistence-sqlite"), file.path).toBe(false);
    }
  });

  it("zero canonical mutation — no write-face call sites in projection-runtime (GQ3/G8; P10 `02` §3)", () => {
    for (const file of projectionRuntimeFiles()) {
      const violations = WRITE_FACE_PATTERNS.filter((entry) =>
        entry.pattern.test(file.source),
      ).map((entry) => entry.label);
      expect(violations, file.path).toEqual([]);
    }
  });

  it("the frozen six-source map and dedup identities are present verbatim (P10 `02` §1/§2; GAP-01 non-descopement)", () => {
    const attention = sourceOf("packages/projection-runtime/src/attention.ts");
    for (const sourceLabel of [
      '"DependencyUnfulfillable"',
      '"Deadlock"',
      '"RuntimeSafetyEnvelope"',
      '"ReconciliationEscalated"',
      '"VerifierOrphan"',
      '"WaitingOnVacantProducer"',
    ]) {
      expect(attention.includes(sourceLabel), sourceLabel).toBe(true);
    }
    // GAP-01 predicate: the retired producer is excluded (mandatory
    // negative fixture), the label is WaitingOnVacantProducer.
    expect(attention.includes('lifecycle !== "Retired"')).toBe(true);
    // Deadlock renders Action Required with no conditional branch.
    const deadlockBlock = attention.slice(
      attention.indexOf("for (const fact of facts.deadlockEvents)"),
      attention.indexOf("for (const fact of facts.safetyStopSettlements)"),
    );
    expect(deadlockBlock.includes('"ActionRequired"')).toBe(true);
    expect(deadlockBlock.includes('"Attention"')).toBe(false);
    // Frozen dedup identities (P10 `02` §2). The source spells these as
    // template literals; assert the literal text without interpolating.
    const dollar = "$";
    expect(
      attention.includes(
        `reconciliation-escalated:${dollar}{fact.executionId}:${dollar}{fact.invocationRefsFingerprint}`,
      ),
    ).toBe(true);
    expect(attention.includes("deadlockCycleFingerprint")).toBe(true);
    expect(attention.includes(`vacant-producer:${dollar}{dependencyId}`)).toBe(
      true,
    );
  });

  it("the frozen label map is an exhaustive switch incl. the retired terminal (P10 `01` §2; P10-003)", () => {
    const status = sourceOf("packages/projection-runtime/src/status.ts");
    for (const label of [
      '"executing"',
      '"waiting-runnable"',
      '"waiting-blocked"',
      '"idle"',
      '"retired"',
      '"attention-flagged"',
    ]) {
      expect(status.includes(label), label).toBe(true);
    }
    expect(status.includes('case "Retired":')).toBe(true);
    expect(status.includes('case "Active":')).toBe(true);
    // Overlay composes with every base label except the terminal retired.
    expect(status.includes('base !== "retired" ? "attention-flagged"')).toBe(
      true,
    );
  });
});
