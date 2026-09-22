import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");

const P8_APPLICATION_MODULES: ReadonlyArray<string> = [
  "packages/application/src/commands/start-verification.ts",
  "packages/application/src/commands/conclude-verification.ts",
  "packages/application/src/commands/accept-complete.ts",
  "packages/application/src/verification-consumer.ts",
  "packages/application/src/completion-consumer.ts",
  "packages/application/src/verifier-spawn.ts",
  "packages/application/src/verification-wake.ts",
];

const P8_ADAPTER_MODULES: ReadonlyArray<string> = [
  "adapters/persistence-sqlite/src/verification-store.ts",
];

const P8_COMMAND_MODULES: ReadonlyArray<{
  readonly file: string;
  readonly commandTypes: ReadonlyArray<string>;
}> = [
  {
    file: "packages/application/src/commands/start-verification.ts",
    commandTypes: ["StartVerification"],
  },
  {
    file: "packages/application/src/commands/conclude-verification.ts",
    commandTypes: ["RecordVerificationEvidence", "ConcludeVerification"],
  },
  {
    file: "packages/application/src/commands/accept-complete.ts",
    commandTypes: ["AcceptWorkOutcome", "CompleteWork"],
  },
];

const P8_CONSUMER_MODULES: ReadonlyArray<string> = [
  "packages/application/src/verification-consumer.ts",
  "packages/application/src/completion-consumer.ts",
];

const CANONICAL_WRITE_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly label: string;
}> = [
  { pattern: /\.insert\s*\(/, label: "repository insert" },
  { pattern: /\.append\s*\(/, label: "journal/evidence append" },
  { pattern: /\.upsert\s*\(/, label: "store upsert" },
  { pattern: /\.concludeIfOpen\s*\(/, label: "verification conclude CAS" },
  { pattern: /\.bindExecution\s*\(/, label: "execution bind" },
  { pattern: /\.refineIfRevision\s*\(/, label: "work refine CAS" },
  { pattern: /\.completeIfRevision\s*\(/, label: "work complete CAS" },
  {
    pattern: /\.clearCurrentWorkIfRevision\s*\(/,
    label: "current-work clear CAS",
  },
];

const P8_PROGRAM_FAMILIES: ReadonlyArray<string> = [
  "packages/agent-runtime/promptPrograms/formation/v1.md",
  "packages/agent-runtime/promptPrograms/communication/v1.md",
  "packages/agent-runtime/promptPrograms/bootstrap/v1.md",
  "packages/agent-runtime/promptPrograms/human-steer/v1.md",
  "packages/agent-runtime/promptPrograms/verification/v1.md",
  "packages/agent-runtime/promptPrograms/query-inspection/v1.md",
];

const P8_TOUCHED_MANIFESTS: ReadonlyArray<string> = [
  "packages/domain/package.json",
  "packages/ports/package.json",
  "packages/application/package.json",
  "packages/execution-runtime/package.json",
  "packages/agent-runtime/package.json",
  "adapters/persistence-sqlite/package.json",
];

interface RawManifest {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

const sourceOf = (relativePath: string): string =>
  readFileSync(join(repoRoot, relativePath), "utf8");

const dependencyKeysOf = (relativePath: string): ReadonlyArray<string> =>
  Object.keys(
    (JSON.parse(sourceOf(relativePath)) as RawManifest).dependencies ?? {},
  );

const headDependencyKeys = (
  relativePath: string,
): ReadonlyArray<string> | null => {
  try {
    const stdout = execSync(`git show HEAD:${relativePath}`, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const manifest = JSON.parse(stdout) as RawManifest;
    return Object.keys(manifest.dependencies ?? {}).sort();
  } catch {
    return null;
  }
};

const gatewaySubmissionCount = (source: string): number =>
  [...source.matchAll(/gateway\s*\.\s*execute\s*\(/g)].length;

const directCanonicalWrites = (source: string): ReadonlyArray<string> =>
  CANONICAL_WRITE_PATTERNS.filter((entry) => entry.pattern.test(source)).map(
    (entry) => entry.label,
  );

describe("p8-architecture", () => {
  it("P8 production modules exist at their frozen locations (7 application modules + adapter verification-store)", () => {
    for (const relativePath of [
      ...P8_APPLICATION_MODULES,
      ...P8_ADAPTER_MODULES,
    ]) {
      const absolute = join(repoRoot, relativePath);
      expect(existsSync(absolute), relativePath).toBe(true);
      expect(sourceOf(relativePath).length, relativePath).toBeGreaterThan(0);
    }
    expect(P8_APPLICATION_MODULES).toHaveLength(7);
  });

  it("the five P8 command faces live in their command modules", () => {
    const commandTypes = P8_COMMAND_MODULES.flatMap(
      (entry) => entry.commandTypes,
    );
    expect(commandTypes).toHaveLength(5);
    for (const entry of P8_COMMAND_MODULES) {
      const source = sourceOf(entry.file);
      for (const commandType of entry.commandTypes) {
        expect(
          source.includes(`commandType: "${commandType}"`),
          `${entry.file}: ${commandType}`,
        ).toBe(true);
      }
    }
  });

  it("consumers never bypass the CommandGateway (canonical mutations only via gateway.execute; direct repository write calls are violations)", () => {
    for (const relativePath of P8_CONSUMER_MODULES) {
      const source = sourceOf(relativePath);
      expect(gatewaySubmissionCount(source), relativePath).toBeGreaterThan(0);
      expect(directCanonicalWrites(source), relativePath).toEqual([]);
      expect(
        source.includes('from "effect/unstable/sql/SqlClient"'),
        relativePath,
      ).toBe(false);
      expect(
        /^import\s+(?!type)[^;\n]*from\s+"@arbor\/ports"/m.test(source),
        relativePath,
      ).toBe(false);
    }

    const offending =
      "const stored = yield* deps.verifications.insert(verification);";
    expect(directCanonicalWrites(offending)).toEqual(["repository insert"]);
    const legal =
      "const receipt = yield* deps.gateway.execute(envelope, context, authority);";
    expect(gatewaySubmissionCount(legal)).toBe(1);
    expect(directCanonicalWrites(legal)).toEqual([]);
  });

  it("M-3 migration note exists (ExecutionBound AdmitExecution admits a parentless verifier execution)", () => {
    const source = sourceOf(
      "packages/execution-runtime/src/commands/admit-execution.ts",
    );
    expect(source.includes("M-3 (P8 `02` §1")).toBe(true);
    expect(source.includes("parentExecutionId: ExecutionId | null")).toBe(true);
    const spawnSource = sourceOf("packages/application/src/verifier-spawn.ts");
    expect(spawnSource.includes("(M-3)")).toBe(true);
    expect(spawnSource.includes("parentExecutionId: null")).toBe(true);
  });

  it("P8-touched manifests add no dependency keys vs git HEAD", () => {
    for (const relativePath of P8_TOUCHED_MANIFESTS) {
      const head = headDependencyKeys(relativePath);
      if (head === null) {
        continue;
      }
      const current = [...dependencyKeysOf(relativePath)].sort();
      const added = current.filter((key) => !head.includes(key));
      expect(added, relativePath).toEqual([]);
    }
  });

  it("promptPrograms: six family files exist and the two P8 families carry P8 contract references in their headers", () => {
    for (const relativePath of P8_PROGRAM_FAMILIES) {
      const absolute = join(repoRoot, relativePath);
      expect(existsSync(absolute), relativePath).toBe(true);
      expect(sourceOf(relativePath).length, relativePath).toBeGreaterThan(0);
    }
    expect(P8_PROGRAM_FAMILIES).toHaveLength(6);

    const verification = sourceOf(
      "packages/agent-runtime/promptPrograms/verification/v1.md",
    );
    expect(verification).toMatch(/^familyId: p8-verification$/m);
    expect(verification).toMatch(/^contractRevision: P8-02@1$/m);
    const queryInspection = sourceOf(
      "packages/agent-runtime/promptPrograms/query-inspection/v1.md",
    );
    expect(queryInspection).toMatch(/^familyId: p8-query-inspection$/m);
    expect(queryInspection).toMatch(/^contractRevision: P8-05@1$/m);

    const registry = sourceOf("packages/agent-runtime/src/prompt-programs.ts");
    for (const familyId of [
      "p6-formation",
      "p6-communication",
      "p6-bootstrap",
      "p6-human-steer",
      "p8-verification",
      "p8-query-inspection",
    ]) {
      expect(registry.includes(`familyId: "${familyId}"`), familyId).toBe(true);
    }
    expect(registry.includes('"P8-02@1"')).toBe(true);
    expect(registry.includes('"P8-05@1"')).toBe(true);
  });
});
