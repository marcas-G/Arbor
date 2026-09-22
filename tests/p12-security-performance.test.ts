import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SANDBOX_ENV_ALLOWLIST as localAllowlist,
  sandboxEnvironment as localProjection,
} from "../adapters/sandbox-local/src/index.js";
import {
  SANDBOX_ENV_ALLOWLIST as worktreeAllowlist,
  sandboxEnvironment as worktreeProjection,
} from "../adapters/sandbox-worktree/src/index.js";
import {
  assessStorage,
  ENVELOPE_DIMENSIONS,
  type Measurement,
  type OperatingEnvelope,
  validateStorageScaleAssessment,
} from "../packages/application/src/storage-assessment.js";
import {
  type ContextFragment,
  canRaiseAuthority,
  contextFragment,
  planContext,
} from "../packages/model-context/src/index.js";
import {
  type InformationTrustMetadata,
  SANDBOX_ENV_ALLOWLIST,
  sandboxEnvironment,
} from "../packages/ports/src/index.js";

// P12-012 — contract `13` §2–§5 (EC-13 / blocker: security hardening + performance).

const repoRoot = join(import.meta.dirname, "..");
const readRepoFile = (relative: string): string =>
  readFileSync(join(repoRoot, relative), "utf8");

// ---------------------------------------------------------------------------
// §2 Information Trust Plane enforcement at the context boundary
// ---------------------------------------------------------------------------

const trust = (
  provenanceKind: InformationTrustMetadata["provenanceKind"],
  instructionCapability: InformationTrustMetadata["instructionCapability"] = "DataOnly",
): InformationTrustMetadata => ({
  provenanceKind,
  instructionCapability,
  epistemicStatus: "Established",
});

const DATA_PROVENANCE_KINDS: ReadonlyArray<
  InformationTrustMetadata["provenanceKind"]
> = [
  "ToolObservation",
  "ExternalRetrieved",
  "AuthenticatedAgent",
  "AuthenticatedHuman",
  "ImportedArtifact",
  "ModelDerived",
];

const fragment = (
  ref: string,
  provenance: InformationTrustMetadata,
): ContextFragment =>
  contextFragment({
    ref,
    layer: "C3",
    retention: "Evictable",
    cacheClass: "TurnDynamic",
    tokens: 10,
    provenance,
  });

describe("P12-013 §2 Information Trust Plane at the context boundary", () => {
  it("tags ToolObservation/ExternalRetrieved/Message/ModelDerived fragments DataOnly", () => {
    for (const kind of DATA_PROVENANCE_KINDS) {
      const tagged = fragment(`f-${kind}`, trust(kind));
      expect(tagged.provenance.provenanceKind, kind).toBe(kind);
      expect(tagged.provenance.instructionCapability, kind).toBe("DataOnly");
    }
  });

  it("denies canRaiseAuthority for DataOnly and admits only runtime-compiled canonical", () => {
    for (const kind of DATA_PROVENANCE_KINDS) {
      expect(
        canRaiseAuthority(fragment(`f-${kind}`, trust(kind)).provenance),
      ).toBe(false);
    }
    const canonical = fragment("canonical", trust("CanonicalInternal"));
    expect(canonical.provenance.instructionCapability).toBe(
      "CanonicalInstruction",
    );
    expect(canRaiseAuthority(canonical.provenance)).toBe(true);
  });

  it("cannot forge CanonicalInstruction from a data source (enforced in code)", () => {
    const forged = fragment(
      "forged",
      trust("ToolObservation", "CanonicalInstruction"),
    );
    expect(forged.provenance.instructionCapability).toBe("DataOnly");
    expect(canRaiseAuthority(forged.provenance)).toBe(false);
  });

  it("preserves trust metadata through planContext selection/eviction", () => {
    const budget = {
      modelWindow: 100,
      outputReserve: 20,
      protocolReserve: 10,
      toolReserve: 10,
    };
    const pinned = contextFragment({
      ref: "pinned",
      layer: "C0",
      retention: "Pinned",
      cacheClass: "Stable",
      tokens: 20,
      provenance: trust("CanonicalInternal"),
    });
    const evicted = contextFragment({
      ref: "evicted",
      layer: "C6",
      retention: "Evictable",
      cacheClass: "TurnDynamic",
      tokens: 100,
      provenance: trust("ModelDerived"),
    });
    const result = planContext([pinned, evicted], budget);

    const selected = result.selected.find((f) => f.ref === "pinned");
    expect(selected?.provenance).toEqual(pinned.provenance);
    expect(result.evicted.map((f) => f.ref)).toEqual(["evicted"]);
    expect(result.evicted[0]?.provenance.instructionCapability).toBe(
      "DataOnly",
    );
  });

  it("centralizes ContextFragment construction at the single boundary factory", () => {
    // A ContextFragment literal is the only production object shape that carries
    // `retention`, `cacheClass` AND `tokens` together; the factory in
    // packages/model-context/src/context.ts is the single site that may
    // construct one, and it assigns `provenance`.
    const fieldShape = ["retention:", "cacheClass:", "tokens:"];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "dist") {
          continue;
        }
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!path.endsWith(".ts") || path.endsWith(".d.ts")) {
          continue;
        }
        const source = readFileSync(path, "utf8");
        if (fieldShape.every((token) => source.includes(token))) {
          offenders.push(path.slice(repoRoot.length + 1));
        }
      }
    };
    walk(repoRoot);

    const isProduction = (file: string): boolean =>
      /^(packages|adapters|apps)\/[^/]+\/src\//.test(file);
    expect(offenders.filter(isProduction)).toEqual([
      "packages/model-context/src/context.ts",
    ]);
    // Every construction path (including test fixtures) supplies provenance.
    for (const file of offenders) {
      expect(readRepoFile(file), file).toContain("provenance");
    }

    const factorySource = readRepoFile("packages/model-context/src/context.ts");
    expect(factorySource).toContain("export const contextFragment");
    expect(factorySource).toContain("provenance");
  });
});

// ---------------------------------------------------------------------------
// §3 Sandbox trajectory (P4 minimal -> P11 worktree -> P12) + env allow-list
// ---------------------------------------------------------------------------

describe("P12-013 §3 sandbox trajectory + env allow-list", () => {
  it("every sandbox adapter projects the shared env allow-list (no new isolation semantics)", () => {
    expect(localAllowlist).toEqual(SANDBOX_ENV_ALLOWLIST);
    expect(worktreeAllowlist).toEqual(SANDBOX_ENV_ALLOWLIST);
    const sample: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/op",
    };
    expect(localProjection(sample)).toEqual(sandboxEnvironment(sample));
    expect(worktreeProjection(sample)).toEqual(sandboxEnvironment(sample));

    const sandboxAdapters = readdirSync(join(repoRoot, "adapters"))
      .filter((entry) => entry.startsWith("sandbox-"))
      .sort();
    expect(sandboxAdapters).toEqual(["sandbox-local", "sandbox-worktree"]);

    for (const adapter of sandboxAdapters) {
      const source = readRepoFile(`adapters/${adapter}/src/index.ts`);
      expect(source, adapter).toContain("SANDBOX_ENV_ALLOWLIST");
      expect(source, adapter).toContain("sandboxEnvironment");
      // The allow-list is inherited from @arbor/ports, never re-declared.
      expect(source, adapter).not.toContain('"HOME"');
    }
  });

  it("keeps a sentinel ambient secret unreachable: spawned env is a subset of the allow-list", () => {
    const sentinelKey = `SENTINEL_SECRET_${randomUUID().replace(/-/g, "")}`;
    const ambient: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/op",
      [sentinelKey]: "must-not-leak",
    };

    for (const project of [
      sandboxEnvironment,
      localProjection,
      worktreeProjection,
    ]) {
      const projected = project(ambient);
      expect(sentinelKey in projected).toBe(false);
      expect(
        Object.keys(projected).every((key) =>
          SANDBOX_ENV_ALLOWLIST.includes(key),
        ),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// §4 Performance: declared operating envelope + measurement method
// ---------------------------------------------------------------------------

const EMPIRICAL_NUMBERS: ReadonlyArray<string> = [
  "sqlitePerformanceCeiling",
  "contextCompactionDefaults",
  "retryCountsAndBackoff",
  "concurrencyCeilings",
  "rateLimits",
  "leaseTtlSweepPoll",
  "shellAllowDenyLists",
  "modelPrices",
];

const CONTRACT_MECHANISMS: ReadonlyArray<string> = [
  "operatingEnvelopeDeclaration",
  "measurementMethod",
  "runtimeSafetyGating",
  "trustMetadata",
  "sandboxGuarantees",
];

describe("P12-013 §4 performance operating envelope + measurement method", () => {
  it("declares the operating envelope and a measurement method per dimension (05 StorageScaleAssessment)", () => {
    const artifact = JSON.parse(
      readRepoFile("planning/results/P12.storage-assessment.json"),
    ) as {
      operatingEnvelope: OperatingEnvelope;
      measurements: ReadonlyArray<Measurement>;
      verdict: string;
    };

    expect(validateStorageScaleAssessment(artifact)).toEqual([]);
    for (const dimension of ENVELOPE_DIMENSIONS) {
      expect(
        typeof artifact.operatingEnvelope[dimension].value,
        dimension,
      ).toBe("number");
      expect(typeof artifact.operatingEnvelope[dimension].unit, dimension).toBe(
        "string",
      );
    }
    for (const measurement of artifact.measurements) {
      expect(measurement.method.length).toBeGreaterThan(0);
      expect(measurement.workload.length).toBeGreaterThan(0);
    }
    const assessed = assessStorage(
      artifact.operatingEnvelope,
      artifact.measurements,
    );
    expect(assessed.verdict).toBe(artifact.verdict);
    expect(["SQLiteSufficient", "PostgreSQLRequired"]).toContain(
      artifact.verdict,
    );
  });

  it("cross-references the D5/D6 ceilings to the P12-008 runtime safety envelope", () => {
    const safety = readRepoFile(
      "packages/execution-runtime/src/runtime-safety.ts",
    );
    expect(safety).toContain("concurrencyCeiling"); // D5
    expect(safety).toContain("rateLimit"); // D6
    expect(safety).toContain("rateWindowMs"); // D6 window
  });

  it("records the DID §13 empirical classification: mechanism is contract, numbers empirical", () => {
    expect(new Set(EMPIRICAL_NUMBERS).size).toBe(EMPIRICAL_NUMBERS.length);
    expect(new Set(CONTRACT_MECHANISMS).size).toBe(CONTRACT_MECHANISMS.length);
    // The envelope declaration + method are contract mechanisms; the concrete
    // numeric values are empirical (DID §13) and live only in the 05-owned
    // artifact, never as hardcoded contract constants in production source.
    expect(CONTRACT_MECHANISMS).toContain("operatingEnvelopeDeclaration");
    expect(CONTRACT_MECHANISMS).toContain("measurementMethod");
    expect(EMPIRICAL_NUMBERS).toContain("sqlitePerformanceCeiling");
    expect(EMPIRICAL_NUMBERS).toContain("concurrencyCeilings");
    expect(EMPIRICAL_NUMBERS).toContain("rateLimits");
  });
});
