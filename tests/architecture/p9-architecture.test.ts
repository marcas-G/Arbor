import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");

/** P9 production modules (P9 `03`–`05` frozen locations): the recovery
 * drive, the unsettled-ProviderTurn recovery, the generic consumer loop,
 * the verification wake face, and the real reconciliation source. */
const P9_RUNTIME_MODULES: ReadonlyArray<string> = [
  "packages/execution-runtime/src/recovery.ts",
  "packages/execution-runtime/src/recovery-drive.ts",
  "packages/application/src/provider-turn-recovery.ts",
  "packages/application/src/consumer-loop.ts",
  "packages/application/src/verification-wake.ts",
  "packages/tool-runtime/src/reconciliation.ts",
];

const P9_MODULE_EXPORTS: ReadonlyArray<{
  readonly file: string;
  readonly symbol: string;
}> = [
  { file: "packages/execution-runtime/src/recovery.ts", symbol: "runRecovery" },
  {
    file: "packages/execution-runtime/src/recovery-drive.ts",
    symbol: "startupRecovery",
  },
  {
    file: "packages/execution-runtime/src/recovery-drive.ts",
    symbol: "sweepRecovery",
  },
  {
    file: "packages/execution-runtime/src/recovery-drive.ts",
    symbol: "preDispatchCheck",
  },
  {
    file: "packages/execution-runtime/src/recovery-drive.ts",
    symbol: "fireDueTimers",
  },
  {
    file: "packages/application/src/provider-turn-recovery.ts",
    symbol: "recoverUnsettledProviderTurns",
  },
  { file: "packages/application/src/consumer-loop.ts", symbol: "pollOnce" },
  {
    file: "packages/application/src/consumer-loop.ts",
    symbol: "dependencyCoordinatorLoop",
  },
  {
    file: "packages/application/src/consumer-loop.ts",
    symbol: "verificationConsumerLoop",
  },
  {
    file: "packages/application/src/consumer-loop.ts",
    symbol: "completionConsumerLoop",
  },
  {
    file: "packages/application/src/verification-wake.ts",
    symbol: "deliverVerificationWake",
  },
  {
    file: "packages/tool-runtime/src/reconciliation.ts",
    symbol: "ReconciliationSourceLive",
  },
];

/** P9 recovery entry points: every Execution settle submission goes through
 * the CommandGateway (RecoveryController / SettleExecutionAuthority); a
 * direct repository settle CAS is a violation. The ProviderTurn failure
 * mark (`turns.failTurn`) is its frozen P9 `04` §2.2 disposition, not an
 * Execution settlement. */
const P9_RECOVERY_ENTRY_MODULES: ReadonlyArray<string> = [
  "packages/execution-runtime/src/recovery.ts",
  "packages/execution-runtime/src/recovery-drive.ts",
  "packages/application/src/provider-turn-recovery.ts",
];

const DIRECT_EXECUTION_SETTLE_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly label: string;
}> = [
  { pattern: /repository\s*\.\s*settle\s*\(/, label: "execution settle CAS" },
  {
    pattern: /\.settleExecution\s*\(/,
    label: "settleExecution call",
  },
];

/** Fault-injection vocabulary is tests/support-only (GQ5 discipline: no
 * fault hooks in production code, no fault-injecting SQLite adapter). */
const FAULT_MARKERS: ReadonlyArray<RegExp> = [
  /harness-kill/,
  /commitGate/,
  /gatedTransactionPort/,
  /faultingTransaction/,
  /fail-on-commit/,
  /fail-on-begin/,
  /rollback-after-body/,
  /injected:fail/,
];

const P9_TOUCHED_MANIFESTS: ReadonlyArray<string> = [
  "packages/domain/package.json",
  "packages/ports/package.json",
  "packages/application/package.json",
  "packages/execution-runtime/package.json",
  "packages/tool-runtime/package.json",
  "packages/provider-runtime/package.json",
  "adapters/persistence-sqlite/package.json",
  "apps/single-workspace/package.json",
];

interface RawManifest {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
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

const productionTrees: ReadonlyArray<string> = [
  join(repoRoot, "packages"),
  join(repoRoot, "adapters"),
  join(repoRoot, "apps"),
];

describe("p9-architecture", () => {
  it("P9 production modules exist at their frozen locations and export their contract faces", () => {
    for (const relativePath of P9_RUNTIME_MODULES) {
      const absolute = join(repoRoot, relativePath);
      expect(existsSync(absolute), relativePath).toBe(true);
      expect(sourceOf(relativePath).length, relativePath).toBeGreaterThan(0);
    }
    expect(P9_RUNTIME_MODULES).toHaveLength(6);
    for (const entry of P9_MODULE_EXPORTS) {
      expect(
        new RegExp(`export (const|function) ${entry.symbol}\\b`).test(
          sourceOf(entry.file),
        ),
        `${entry.file}: ${entry.symbol}`,
      ).toBe(true);
    }
    expect(P9_MODULE_EXPORTS).toHaveLength(12);
  });

  it("recovery entries never bypass the CommandGateway — Execution settles are gateway submissions only", () => {
    for (const relativePath of P9_RECOVERY_ENTRY_MODULES) {
      const source = sourceOf(relativePath);
      const violations = DIRECT_EXECUTION_SETTLE_PATTERNS.filter((entry) =>
        entry.pattern.test(source),
      ).map((entry) => entry.label);
      expect(violations, relativePath).toEqual([]);
    }
    // The nine-step pass really does settle through the gateway: both
    // deterministic paths (completion fact + clean stop) submit
    // SettleExecution via gateway.execute under RecoveryController.
    const recovery = sourceOf("packages/execution-runtime/src/recovery.ts");
    const gatewaySubmissions = [
      ...recovery.matchAll(/gateway\s*\.\s*execute\s*\(/g),
    ].length;
    expect(gatewaySubmissions).toBe(2);
    expect(recovery.includes('"RecoveryController"')).toBe(true);
    // The provider-turn recovery face owns only the Turn-level disposition:
    // it fails dangling turns via the frozen store face and never invents
    // an Execution settlement (P9 `04` §2.2; P2 `06` §4).
    const providerRecovery = sourceOf(
      "packages/application/src/provider-turn-recovery.ts",
    );
    expect(/turns\s*\.\s*failTurn\s*\(/.test(providerRecovery)).toBe(true);

    // The consumer loop is pure consumer infrastructure: no canonical
    // repository writes, no direct SQL (p8-architecture precedent).
    const consumerLoop = sourceOf("packages/application/src/consumer-loop.ts");
    expect(
      [
        /\.insert\s*\(/,
        /\.append\s*\(/,
        /\.upsert\s*\(/,
        /\.concludeIfOpen\s*\(/,
        /\.bindExecution\s*\(/,
        /\.refineIfRevision\s*\(/,
        /\.completeIfRevision\s*\(/,
        /\.clearCurrentWorkIfRevision\s*\(/,
      ].some((pattern) => pattern.test(consumerLoop)),
    ).toBe(false);
    expect(consumerLoop.includes('from "effect/unstable/sql/SqlClient"')).toBe(
      false,
    );
  });

  it("T4 (preDispatchCheck) contains no nine-step call — the module hosts runRecovery but the check body never invokes it", () => {
    const source = sourceOf("packages/execution-runtime/src/recovery-drive.ts");
    // The module itself wires the nine-step pass into T1/T2/T3...
    expect(source.includes("runRecovery")).toBe(true);
    // ...but the preDispatchCheck function body is a single-predicate read.
    const start = source.indexOf("export const preDispatchCheck");
    expect(start).toBeGreaterThan(-1);
    const nextExport = source.indexOf("export ", start + 1);
    const body = source.slice(
      start,
      nextExport === -1 ? undefined : nextExport,
    );
    for (const forbidden of [
      "runRecovery",
      "fireDueTimers",
      "startupRecovery",
      "sweepRecovery",
      "recoveryPass",
    ]) {
      expect(body.includes(forbidden), forbidden).toBe(false);
    }
    expect(body.includes("currentLease")).toBe(true);
  });

  it("fault-injection infrastructure lives only under tests/support — production trees are clean", () => {
    for (const tree of productionTrees) {
      for (const file of walkSourceFiles(tree)) {
        const source = readFileSync(file, "utf8");
        for (const marker of FAULT_MARKERS) {
          expect(
            marker.test(source),
            `${marker} must not appear in ${file}`,
          ).toBe(false);
        }
      }
    }
    // The harness envelope (tests/support only) exposes the three
    // envelope-internal transaction fault modes and nothing else (GQ5).
    const faultTransaction = sourceOf("tests/support/p9-fault-transaction.ts");
    for (const mode of [
      "fail-on-begin",
      "rollback-after-body",
      "fail-on-commit",
    ]) {
      expect(faultTransaction.includes(`"${mode}"`), mode).toBe(true);
    }
    for (const simulated of [
      "simulate-power-loss",
      "wal-corrupt",
      "page-tear",
    ]) {
      expect(faultTransaction.includes(simulated), simulated).toBe(false);
    }
  });

  it("the DA evidence protocol is exported by the durability support module (reopen + integrity + version + counts)", () => {
    const evidence = sourceOf("tests/support/p9-durability-evidence.ts");
    expect(evidence.includes("export const collectDurabilityEvidence")).toBe(
      true,
    );
    expect(evidence.includes("export interface DurabilityEvidence")).toBe(true);
    expect(evidence.includes("export interface DurabilityEvidenceCounts")).toBe(
      true,
    );
    expect(evidence.includes('"durability-asserted"')).toBe(true);
    expect(evidence.includes("integrity_check")).toBe(true);
    expect(evidence.includes("user_version")).toBe(true);
    expect(evidence.includes("synchronous")).toBe(true);
    // The guarantee-class convention itself stays two-valued (GQ5).
    const harnessApi = sourceOf("tests/support/p9-harness-api.ts");
    expect(
      harnessApi.includes('"crash-injected" | "durability-asserted"'),
    ).toBe(true);
    expect(harnessApi.includes("export const labeled")).toBe(true);
  });

  it("P9-touched manifests add no dependency keys vs git HEAD", () => {
    for (const relativePath of P9_TOUCHED_MANIFESTS) {
      const head = headDependencyKeys(relativePath);
      if (head === null) {
        continue;
      }
      const current = [...dependencyKeysOf(relativePath)].sort();
      const added = current.filter((key) => !head.includes(key));
      expect(added, relativePath).toEqual([]);
    }
  });
});
