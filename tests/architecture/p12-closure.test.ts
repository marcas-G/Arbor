import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkEdges, type PackageManifest } from "./package-dag.js";

// P12-013 architecture closure: the cross-phase closure invariants CI-1..CI-7
// (`14` §3.3 / `00-contract-index.md`), the nine P12 completion blockers
// (`14` §3.2 / §4), the no-open-gap gate, and the TR-1 narrowing of the
// `advanceAnchor` residual exposure (`05` §5.1). Mechanical evidence only;
// mirrors the P11 `p11-closure` pattern.

const repoRoot = join(import.meta.dirname, "..", "..");

const sourceOf = (relative: string): string =>
  readFileSync(join(repoRoot, relative), "utf8");

const exists = (relative: string): boolean =>
  existsSync(join(repoRoot, relative));

const importSpecifiersOf = (source: string): ReadonlyArray<string> => {
  const out: Array<string> = [];
  for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
    out.push(match[1] ?? "");
  }
  return out;
};

/** CI-1: the observation-only sources may never carry anchor-advancement. */
const CI1_OBSERVATION_ONLY_SOURCES: ReadonlyArray<string> = [
  "adapters/environment-resolver-local/src/index.ts",
  "packages/application/src/environment-drift.ts",
  "packages/application/src/environment-drift-startup.ts",
  "adapters/sandbox-worktree/src/index.ts",
];

const CI1_ADVANCEMENT_TOKENS: ReadonlyArray<string> = [
  "advanceAnchor",
  "lazyInitAnchor",
  "EnvironmentRevisionStoreLive",
  "EnvironmentRevisionStore.",
  "store.record(",
];

/** The P12 `04` §2 observability module physical home. */
const OBSERVABILITY_FILES: ReadonlyArray<string> = [
  "packages/projection-runtime/src/observability/usage.ts",
  "packages/projection-runtime/src/observability/health.ts",
  "packages/projection-runtime/src/observability/index.ts",
];

/** P12 `14` §3.2 — each completion blocker maps to a mechanical test. */
interface BlockerEvidence {
  readonly id: string;
  readonly blocker: string;
  readonly file: string;
  readonly marker: string;
}

const P12_BLOCKERS: ReadonlyArray<BlockerEvidence> = [
  {
    id: "B1",
    blocker: "region-encoding correctness fix",
    file: "tests/p12-region-encoding.test.ts",
    marker: "resolver emits frozen object encoding",
  },
  {
    id: "B2",
    blocker: "ToolCatalogPort inherited contract correction",
    file: "tests/p12-toolcatalog.test.ts",
    marker: "projects the full model-facing ToolDefinition for a visible ref",
  },
  {
    id: "B3",
    blocker: "full §8.16A Runtime Safety closure",
    file: "tests/p12-runtime-safety.test.ts",
    marker:
      "a violation interrupts with RuntimeSafetyStop and Work remains Open",
  },
  {
    id: "B4",
    blocker: "Authority Resolver production plane",
    file: "tests/p12-authority-resolver.test.ts",
    marker:
      "resolver produces exact-bound facts; no CommandGateway/mutation/approval/tool path",
  },
  {
    id: "B5",
    blocker: "SecretStorePort / SecretRef + real adapter",
    file: "tests/p12-secret-store.test.ts",
    marker: "driver no longer hardcodes a raw secretRef",
  },
  {
    id: "B6",
    blocker: "observability / health / usage plane",
    file: "tests/p12-observability.test.ts",
    marker: "unknown cost never 0",
  },
  {
    id: "B7",
    blocker: "StorageScaleAssessment + DurabilityEnvelope",
    file: "tests/p12-storage.test.ts",
    marker:
      "checked-in artifact validates, covers every declared dimension, and reproduces its verdict",
  },
  {
    id: "B8",
    blocker: "Remote Worker transport / identity boundary",
    file: "tests/p12-remote-worker.test.ts",
    marker:
      "mediated mutation = fence-check + mutate + resolve + event in exactly one transaction",
  },
  {
    id: "B9",
    blocker: "Plugin SDK / compatibility / trust model",
    file: "tests/p12-plugin-sdk.test.ts",
    marker: "PluginSdkApiVersion MAJOR mismatch",
  },
];

/** P12 `14` §3.1 — each exit criterion (EC-2..EC-13) maps to a test file. */
const EC_TEST_FILES: ReadonlyArray<[string, string]> = [
  ["EC-2", "tests/p12-plugin-sdk.test.ts"],
  ["EC-3", "tests/p12-authority-resolver.test.ts"],
  ["EC-4", "tests/p12-secret-store.test.ts"],
  ["EC-5", "tests/p12-observability.test.ts"],
  ["EC-6", "tests/p12-storage.test.ts"],
  ["EC-7", "tests/p12-remote-worker.test.ts"],
  ["EC-8", "tests/p12-toolcatalog.test.ts"],
  ["EC-9", "tests/p12-runtime-safety.test.ts"],
  ["EC-10", "tests/p12-region-encoding.test.ts"],
  ["EC-11", "tests/p12-transport.test.ts"],
  ["EC-12", "tests/p12-providers-tools.test.ts"],
  ["EC-13", "tests/p12-security-performance.test.ts"],
];

const readManifests = (dirName: string): ReadonlyArray<PackageManifest> => {
  const dir = join(repoRoot, dirName);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => existsSync(join(dir, entry, "package.json")))
    .map((entry) => {
      const manifest = JSON.parse(
        readFileSync(join(dir, entry, "package.json"), "utf8"),
      ) as {
        name: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const allDeps = {
        ...manifest.dependencies,
        ...manifest.peerDependencies,
      };
      return {
        name: manifest.name.replace("@arbor/", ""),
        internalDependencies: Object.keys(allDeps)
          .filter((dep) => dep.startsWith("@arbor/"))
          .map((dep) => dep.replace("@arbor/", "")),
      };
    });
};

const readPackages = (): ReadonlyArray<PackageManifest> => [
  ...readManifests("packages"),
  ...readManifests("adapters"),
];

describe("p12-closure", () => {
  it("CI-1 — no resolver / observability / worker path mutates canonical domain state directly", () => {
    // The Authority Resolver is a pure fact producer.
    const resolver = sourceOf("packages/application/src/authority-resolver.ts");
    for (const forbidden of [
      "CommandGateway",
      ".transact",
      "consumeApproval",
      ".invoke(",
      ".put(",
      ".revoke(",
      ".register(",
    ]) {
      expect(resolver.includes(forbidden), forbidden).toBe(false);
    }

    // The operational observability module holds no command/repository surface.
    for (const relative of OBSERVABILITY_FILES) {
      const source = sourceOf(relative);
      for (const forbidden of [
        "CommandGateway",
        "TransactionPort",
        ".transact",
        "SqlClient",
        "Repository",
        ".insert",
        ".update",
      ]) {
        expect(source.includes(forbidden), `${relative}: ${forbidden}`).toBe(
          false,
        );
      }
    }

    // The worker mediation delegates to the gateway; it opens no transaction.
    const mediation = sourceOf(
      "packages/application/src/remote-worker-mediation.ts",
    );
    expect(mediation.includes("gateway.execute")).toBe(true);
    expect(mediation.includes("SqlClient")).toBe(false);

    // The worker transport has no persistence edge at all.
    const workerImports = importSpecifiersOf(
      sourceOf("adapters/worker-transport/src/index.ts"),
    );
    expect(workerImports).not.toContain("@arbor/persistence-sqlite");
    expect(workerImports).not.toContain("effect/unstable/sql/SqlClient");

    // Observation-only sources carry no anchor-advancement capability.
    for (const relative of CI1_OBSERVATION_ONLY_SOURCES) {
      const source = sourceOf(relative);
      for (const token of CI1_ADVANCEMENT_TOKENS) {
        expect(source.includes(token), `${relative}: ${token}`).toBe(false);
      }
    }
  });

  it("CI-2 — no secret material reaches prompt / session / event / log / artifact", () => {
    // SecretMaterial is opaque and redacted by default under serialization.
    const provider = sourceOf("packages/ports/src/provider.ts");
    expect(provider.includes("[REDACTED]")).toBe(true);
    expect(provider.includes("toJSON")).toBe(true);
    expect(provider.includes("toString")).toBe(true);
    expect(provider.includes("reveal")).toBe(true);

    // The sandbox env projection is the shared allow-list (secrets excluded).
    const sandboxEnv = sourceOf("packages/ports/src/sandbox-env.ts");
    expect(sandboxEnv.includes("SANDBOX_ENV_ALLOWLIST")).toBe(true);

    // Mechanical end-to-end evidence lives in the mapped suites.
    expect(sourceOf("tests/p12-secret-store.test.ts")).toContain(
      "never appears in any SQLite table row",
    );
    expect(sourceOf("tests/p12-acceptance.test.ts")).toContain(
      "never reaches any durable/observable surface",
    );
  });

  it("CI-3 — no operational (metrics/log/health/usage) value is treated as authoritative", () => {
    const usage = sourceOf(
      "packages/projection-runtime/src/observability/usage.ts",
    );
    expect(usage.includes('_tag: "Unknown"')).toBe(true);
    expect(usage.includes("PricingUnavailable")).toBe(true);
    // An unknown cost is never silently coerced to a zero amount.
    expect(usage.includes("amount: 0")).toBe(false);
    expect(usage.includes("CommandGateway")).toBe(false);

    // Decision R channels exclude telemetry (mechanical boundary suite).
    expect(
      exists("tests/architecture/p12-observability-boundaries.test.ts"),
    ).toBe(true);
  });

  it("CI-4 — every §8.16A safety dimension has mechanism + state + reset + rule + policy + violation + durability + tests", () => {
    const safety = sourceOf("packages/execution-runtime/src/runtime-safety.ts");
    // policy + rule + mechanism/state/reset (per dimension)
    for (const dimension of [
      "maxRetries",
      "maxRepeatedFingerprints",
      "maxRecursionDepth",
      "maxNoProgressTurns",
      "concurrencyCeiling",
      "rateLimit",
      "rateWindowMs",
    ]) {
      expect(safety.includes(dimension), dimension).toBe(true);
    }
    for (const facet of [
      '"Stop"',
      '"Continue"',
      "retryCount",
      "durableProgress",
      "chainDepth",
      "inFlight",
      "leaseGeneration",
      "observedAt",
    ]) {
      expect(safety.includes(facet), facet).toBe(true);
    }

    // tests: D1–D6 each drive Interrupted(RuntimeSafetyStop)
    const tests = sourceOf("tests/p12-runtime-safety.test.ts");
    for (const dim of ["D1", "D2", "D3", "D4", "D5", "D6"]) {
      expect(tests.includes(dim), dim).toBe(true);
    }
    expect(tests.includes("RuntimeSafetyStop")).toBe(true);
  });

  it("CI-5 / EC-14 — every P12 completion blocker is mechanically evidenced", () => {
    expect(P12_BLOCKERS).toHaveLength(9);
    for (const evidence of P12_BLOCKERS) {
      expect(exists(evidence.file), evidence.file).toBe(true);
      expect(
        sourceOf(evidence.file).includes(evidence.marker),
        `${evidence.id} ${evidence.blocker}: ${evidence.file} :: ${evidence.marker}`,
      ).toBe(true);
      // On the vitest include path (tests/**/*.test.ts).
      expect(/^tests\/.*\.test\.ts$/.test(evidence.file), evidence.file).toBe(
        true,
      );
    }
    // Every exit criterion (EC-2..EC-13) maps to an existing suite.
    for (const [ec, file] of EC_TEST_FILES) {
      expect(exists(file), `${ec} ${file}`).toBe(true);
    }
  });

  it("CI-6 — no tool placeholder in PortableModelRequest.toolDefinitions; the model-facing definition is resolved via ToolCatalogPort", () => {
    const compiler = sourceOf("packages/model-context/src/compiler.ts");
    expect(compiler.includes("description: tool.description")).toBe(true);
    expect(compiler.includes("schemaJson: tool.schemaJson")).toBe(true);
    expect(compiler.includes('schemaJson: "{}"')).toBe(false);
    expect(compiler.includes("description: tool.name")).toBe(false);

    const catalog = sourceOf("packages/tool-runtime/src/catalog.ts");
    expect(catalog.includes("resolveForModel")).toBe(true);
    expect(catalog.includes("visibleRefs")).toBe(true);
    expect(catalog.includes("ProjectToolRegistry")).toBe(true);
    expect(catalog.includes("listRegisteredToolDefinitions")).toBe(true);

    expect(sourceOf("tests/p12-toolcatalog.test.ts")).toContain("model-facing");
  });

  it("CI-7 — region encoding at every producer matches the frozen object encoding; narrow invalidation is tested end-to-end", () => {
    const resources = sourceOf("packages/domain/src/resources.ts");
    expect(resources.includes("canonicalRegionString")).toBe(true);
    expect(resources.includes("normalizedRegion")).toBe(true);

    const resolver = sourceOf(
      "adapters/environment-resolver-local/src/index.ts",
    );
    expect(resolver.includes("normalizedRegion")).toBe(true);

    expect(sourceOf("tests/p12-region-encoding.test.ts")).toContain(
      "frozen object encoding",
    );
  });

  it("no open P12 Design Gap — every planning/gaps/P12-*.md is absent or CLOSED", () => {
    const gapsDir = join(repoRoot, "planning", "gaps");
    const gapFiles = existsSync(gapsDir)
      ? readdirSync(gapsDir).filter((entry) => /^P12-.*\.md$/.test(entry))
      : [];
    for (const file of gapFiles) {
      const content = readFileSync(join(gapsDir, file), "utf8");
      expect(content.toUpperCase(), file).toContain("CLOSED");
      expect(/^\s*STATUS:\s*OPEN/im.test(content), file).toBe(false);
    }
  });

  it("TR-1 (`05` §5.1): advanceAnchor is ABSENT from the ports public surface; advancement is the internal capability", () => {
    expect(
      sourceOf("packages/ports/src/environment.ts").includes("advanceAnchor"),
    ).toBe(false);
    expect(
      sourceOf("packages/ports/src/index.ts").includes("advanceAnchor"),
    ).toBe(false);
    // The internal capability is not re-exported from the persistence barrel.
    expect(
      sourceOf("adapters/persistence-sqlite/src/index.ts").includes(
        "environment-advancement",
      ),
    ).toBe(false);
    expect(
      exists("adapters/persistence-sqlite/src/environment-advancement.ts"),
    ).toBe(true);
  });

  it("package DAG holds and the P12 architecture suites are present", () => {
    expect(checkEdges(readPackages())).toEqual([]);
    expect(exists("tests/architecture/package-dag.test.ts")).toBe(true);
    expect(
      exists("tests/architecture/p12-observability-boundaries.test.ts"),
    ).toBe(true);
  });
});
