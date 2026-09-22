import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { P12_MIGRATIONS } from "../adapters/persistence-sqlite/src/index.js";
import {
  assertRestoreIsolation,
  DEFAULT_DURABILITY_ENVELOPE,
  isPreRestoreIncarnationMatch,
  parseDuration,
  type RestoreDrillArtifact,
  RestoreIsolationViolation,
  reconcileRestoredLeases,
  withinDurabilityEnvelope,
} from "../packages/application/src/durability.js";
import {
  planSnapshotRetention,
  pruneSnapshotRef,
  pruneSnapshots,
  type SnapshotCatalogEntry,
} from "../packages/application/src/snapshot-retention.js";
import {
  assessStorage,
  ENVELOPE_DIMENSIONS,
  type EnvelopeDimension,
  type Measurement,
  type OperatingEnvelope,
  type PostgresTrigger,
  validateStorageScaleAssessment,
} from "../packages/application/src/storage-assessment.js";
import {
  parseSnapshotBlob,
  type SnapshotProbe,
  type SnapshotRegionEntry,
  snapshotBlobContent,
} from "../packages/domain/src/index.js";

// P12-005 — contract `05` §2–§5 (EC-6 / blocker B7).

const repoRoot = join(import.meta.dirname, "..");
const readRepoFile = (relative: string): string =>
  readFileSync(join(repoRoot, relative), "utf8");

// ---------------------------------------------------------------------------
// §2 StorageScaleAssessment
// ---------------------------------------------------------------------------

const ENVELOPE: OperatingEnvelope = {
  maxConcurrentRuntimes: { value: 1, unit: "count" },
  maxWriteThroughput: { value: 500, unit: "writes/s" },
  maxDbSize: { value: 8, unit: "GiB" },
  availabilityTarget: { value: 0.999, unit: "fraction" },
};

const okMeasurements: ReadonlyArray<Measurement> = [
  {
    dimension: "maxConcurrentRuntimes",
    observed: { value: 1, unit: "count" },
    method: "single-writer control plane",
    workload: "slice",
  },
  {
    dimension: "maxWriteThroughput",
    observed: { value: 120, unit: "writes/s" },
    method: "WAL write benchmark",
    workload: "slice",
  },
  {
    dimension: "maxDbSize",
    observed: { value: 0.4, unit: "GiB" },
    method: "file size",
    workload: "slice",
  },
  {
    dimension: "availabilityTarget",
    observed: { value: 0.999, unit: "fraction" },
    method: "single-writer availability",
    workload: "slice",
  },
];

const measurement = (
  dimension: EnvelopeDimension,
  value: number,
  unit = ENVELOPE[dimension].unit,
): Measurement => ({
  dimension,
  observed: { value, unit },
  method: "test",
  workload: "test",
});

describe("P12-005 §2 StorageScaleAssessment", () => {
  it("checked-in artifact validates, covers every declared dimension, and reproduces its verdict", () => {
    const artifact = JSON.parse(
      readRepoFile("planning/results/P12.storage-assessment.json"),
    ) as {
      operatingEnvelope: OperatingEnvelope;
      measurements: ReadonlyArray<Measurement>;
      verdict: string;
      postgresTrigger: ReadonlyArray<string>;
      governanceGatedTriggers: ReadonlyArray<string>;
    };

    expect(validateStorageScaleAssessment(artifact)).toEqual([]);
    expect(["SQLiteSufficient", "PostgreSQLRequired"]).toContain(
      artifact.verdict,
    );

    const covered = new Set(artifact.measurements.map((m) => m.dimension));
    for (const dimension of ENVELOPE_DIMENSIONS) {
      expect(covered.has(dimension), dimension).toBe(true);
    }

    const assessed = assessStorage(
      artifact.operatingEnvelope,
      artifact.measurements,
    );
    expect(assessed.verdict).toBe(artifact.verdict);
    expect(assessed.postgresTrigger).toEqual(artifact.postgresTrigger);
    expect(assessed.governanceGatedTriggers).toEqual(
      artifact.governanceGatedTriggers,
    );
  });

  it("no vacuous pass: empty measurements -> InsufficientEvidence (never SQLiteSufficient)", () => {
    const result = assessStorage(ENVELOPE, []);
    expect(result.verdict).toBe("InsufficientEvidence");
    expect(result.verdict).not.toBe("SQLiteSufficient");
    expect(result.postgresTrigger).toEqual([]);
    expect(result.governanceGatedTriggers).toEqual([]);
  });

  it("partial coverage -> InsufficientEvidence", () => {
    const result = assessStorage(ENVELOPE, okMeasurements.slice(0, 3));
    expect(result.verdict).toBe("InsufficientEvidence");
  });

  it("unit mismatch is incomparable evidence -> InsufficientEvidence (never a pass)", () => {
    const result = assessStorage(ENVELOPE, [
      ...okMeasurements.slice(0, 3),
      measurement("availabilityTarget", 0.999, "percent"),
    ]);
    expect(result.verdict).toBe("InsufficientEvidence");
  });

  it("positive evidence for every dimension -> SQLiteSufficient", () => {
    expect(assessStorage(ENVELOPE, okMeasurements).verdict).toBe(
      "SQLiteSufficient",
    );
  });

  it("R-04: a measured v1-actionable violation -> PostgreSQLRequired with the NAMED trigger", () => {
    const throughput = assessStorage(ENVELOPE, [
      ...okMeasurements.slice(0, 1),
      measurement("maxWriteThroughput", 900),
      ...okMeasurements.slice(2),
    ]);
    expect(throughput.verdict).toBe("PostgreSQLRequired");
    expect(throughput.postgresTrigger).toEqual(["SqliteWriteContention"]);

    const dbSize = assessStorage(ENVELOPE, [
      ...okMeasurements.slice(0, 2),
      measurement("maxDbSize", 64),
      ...okMeasurements.slice(3),
    ]);
    expect(dbSize.verdict).toBe("PostgreSQLRequired");
    expect(dbSize.postgresTrigger).toEqual(["DbHa"]);

    // availabilityTarget is a FLOOR: observed < declared violates.
    const availability = assessStorage(ENVELOPE, [
      ...okMeasurements.slice(0, 3),
      measurement("availabilityTarget", 0.9),
    ]);
    expect(availability.verdict).toBe("PostgreSQLRequired");
    expect(availability.postgresTrigger).toEqual(["DbHa"]);
  });

  it("governance-gated only violation -> InsufficientEvidence + MultiWriterControlPlane, never PostgreSQLRequired", () => {
    const result = assessStorage(ENVELOPE, [
      measurement("maxConcurrentRuntimes", 2),
      ...okMeasurements.slice(1),
    ]);
    expect(result.verdict).toBe("InsufficientEvidence");
    expect(result.postgresTrigger).toEqual([]);
    expect(result.governanceGatedTriggers).toEqual(["MultiWriterControlPlane"]);
  });

  it("postgresTrigger union is DbHa | SqliteWriteContention only (multiRuntimeConcurrentWrite is non-v1)", () => {
    const union: ReadonlyArray<PostgresTrigger> = [
      "DbHa",
      "SqliteWriteContention",
    ];
    expect(union).toHaveLength(2);
    for (const result of [
      assessStorage(ENVELOPE, [
        ...okMeasurements.slice(0, 1),
        measurement("maxWriteThroughput", 900),
        ...okMeasurements.slice(2),
      ]),
      assessStorage(ENVELOPE, [
        ...okMeasurements.slice(0, 2),
        measurement("maxDbSize", 64),
        ...okMeasurements.slice(3),
      ]),
    ]) {
      for (const trigger of result.postgresTrigger) {
        expect(union).toContain(trigger);
      }
      expect(result.postgresTrigger).not.toContain(
        "multiRuntimeConcurrentWrite" as never,
      );
    }
  });

  it("is pure/deterministic: identical inputs -> identical assessments", () => {
    expect(assessStorage(ENVELOPE, okMeasurements)).toEqual(
      assessStorage(ENVELOPE, okMeasurements),
    );
  });
});

// ---------------------------------------------------------------------------
// §4 DurabilityEnvelope + restore drill
// ---------------------------------------------------------------------------

describe("P12-005 §4 DurabilityEnvelope + restore drill", () => {
  it("parseDuration handles the declared ISO-8601 durations and rejects garbage", () => {
    expect(parseDuration("PT0S")).toBe(0);
    expect(parseDuration("PT30S")).toBe(30_000);
    expect(parseDuration("PT5M")).toBe(300_000);
    expect(parseDuration("PT30M")).toBe(1_800_000);
    expect(parseDuration("PT1H")).toBe(3_600_000);
    expect(() => parseDuration("30 minutes")).toThrow();
    expect(() => parseDuration("P")).toThrow();
  });

  it("drill artifact exists; migrationUserVersion === max(P12_MIGRATIONS) === 13; measured RPO/RTO within declared", () => {
    const artifact = JSON.parse(
      readRepoFile("planning/results/P12.restore-drill.json"),
    ) as RestoreDrillArtifact;

    for (const field of [
      "timestamp",
      "backupRef",
      "restoredDbHash",
      "migrationUserVersion",
      "measuredRpo",
      "measuredRto",
    ] as const) {
      expect(artifact[field], field).toBeDefined();
    }

    const baseline = Math.max(...P12_MIGRATIONS.map((m) => m.id));
    expect(baseline).toBe(13);
    expect(artifact.migrationUserVersion).toBe(baseline);

    expect(
      parseDuration(artifact.measuredRto),
      "measuredRto <= declaredRto",
    ).toBeLessThanOrEqual(
      parseDuration(DEFAULT_DURABILITY_ENVELOPE.declaredRto),
    );
    expect(
      parseDuration(artifact.measuredRpo),
      "measuredRpo <= declaredRpo",
    ).toBeLessThanOrEqual(
      parseDuration(DEFAULT_DURABILITY_ENVELOPE.declaredRpo),
    );
    expect(
      withinDurabilityEnvelope(artifact, DEFAULT_DURABILITY_ENVELOPE),
    ).toBe(true);
    expect(artifact.restoredDbHash.startsWith("sha256:")).toBe(true);
  });

  it("restore-drill isolation: restored state can never be the live canonical writer", () => {
    expect(() =>
      assertRestoreIsolation("/db/canonical.db", "/db/canonical.db"),
    ).toThrow(RestoreIsolationViolation);
    expect(() =>
      assertRestoreIsolation("/db/canonical.db", "/drill/restored.db"),
    ).not.toThrow();

    // The drill imports no runtime / worker package, so no Runtime or worker
    // can connect to the restored DB as the canonical control plane.
    const drillSource = readRepoFile(
      "apps/single-workspace/src/restore-drill.ts",
    );
    for (const forbidden of [
      "@arbor/execution-runtime",
      "@arbor/agent-runtime",
      "@arbor/worker-local",
      "@arbor/provider-runtime",
    ]) {
      expect(drillSource.includes(forbidden), forbidden).toBe(false);
    }
    expect(drillSource.includes("assertRestoreIsolation")).toBe(true);
  });

  it("post-restore reconciliation advances the generation so no pre-restore incarnation can commit", () => {
    const leases = [
      {
        executionId: "exe_1",
        workerId: "wrk_A",
        workerIncarnationId: "wic_A1",
        generation: 3,
      },
    ];
    const reconciliation = reconcileRestoredLeases(leases);
    expect(reconciliation.invalidatedCount).toBe(1);
    expect(reconciliation.advancedGeneration).toBe(4);

    for (const reconciled of reconciliation.reconciled) {
      expect(
        isPreRestoreIncarnationMatch(reconciled, "wrk_A", "wic_A1", 3),
        "pre-restore incarnation must not match",
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// §5.1 TR-1 advanceAnchor absence (independent of p12-closure)
// ---------------------------------------------------------------------------

describe("P12-005 §5.1 TR-1 advanceAnchor public-surface absence", () => {
  const observationOnlySources = [
    "packages/application/src/environment-drift.ts",
    "packages/application/src/environment-drift-startup.ts",
    "packages/application/src/environment-staleness.ts",
    "packages/application/src/environment-impact.ts",
    "packages/application/src/environment-impact-wake.ts",
    "adapters/environment-resolver-local/src/index.ts",
    "adapters/sandbox-worktree/src/index.ts",
  ];

  it("the public ports surface exposes no advancement capability", () => {
    const environmentPort = readRepoFile("packages/ports/src/environment.ts");
    expect(environmentPort.includes("advanceAnchor")).toBe(false);
    const portsIndex = readRepoFile("packages/ports/src/index.ts");
    expect(portsIndex.includes("advanceAnchor")).toBe(false);
  });

  it("advancement lives in the internal, non-exported capability module", () => {
    const capability = readRepoFile(
      "adapters/persistence-sqlite/src/environment-advancement.ts",
    );
    expect(capability.includes("EnvironmentRevisionAdvancement")).toBe(true);
    const adapterIndex = readRepoFile(
      "adapters/persistence-sqlite/src/index.ts",
    );
    expect(adapterIndex.includes("environment-advancement")).toBe(false);
  });

  it("every observation-side module carries no advancement import", () => {
    for (const relative of observationOnlySources) {
      const source = readRepoFile(relative);
      for (const token of [
        "advanceAnchor",
        "EnvironmentRevisionAdvancement",
        "EnvironmentRevisionStore.",
        "lazyInitAnchor",
        "store.record(",
      ]) {
        expect(source.includes(token), `${relative}: ${token}`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §5.2 TR-2 parseSnapshotBlob structured encoding
// ---------------------------------------------------------------------------

const REGION = {
  resourceSpaceId: "filesystem",
  normalizedRegion: { kind: "FileTree", path: "/repo/a" },
} as never;

const entryWithMtime = (mtime: string): SnapshotRegionEntry => ({
  address: { _tag: "FileTree", path: "/repo/a" } as never,
  resolved: REGION,
  probe: { kind: "FileTree", exists: true, mtime } as SnapshotProbe,
});

describe("P12-005 §5.2 parseSnapshotBlob collision-free encoding", () => {
  it("round-trips ISO-8601 mtimes containing ':' exactly", () => {
    const regions = [
      entryWithMtime("2026-09-22T14:04:00.238Z"),
      entryWithMtime("2026-01-01T00:00:00+08:00"),
    ];
    const blob = snapshotBlobContent("prj-A", regions);
    const parsed = parseSnapshotBlob(blob);
    expect(parsed.projectId).toBe("prj-A");
    expect(parsed.regions).toHaveLength(2);
    const mtimes = parsed.regions.map((r) =>
      r.probe.kind === "FileTree" ? r.probe.mtime : undefined,
    );
    expect(mtimes).toEqual([
      "2026-01-01T00:00:00+08:00",
      "2026-09-22T14:04:00.238Z",
    ]);
    // byte-identical re-serialization (canonical encoding)
    expect(snapshotBlobContent(parsed.projectId, parsed.regions)).toBe(blob);
  });

  it("still rejects malformed blobs with a typed failure", () => {
    expect(() => parseSnapshotBlob("not-a-blob")).toThrow();
    expect(() => parseSnapshotBlob("")).toThrow();
    expect(() => parseSnapshotBlob("p11-snapshot-v1\nnotjson\nrest")).toThrow();
    expect(() =>
      parseSnapshotBlob('p11-snapshot-v1\n"prj"\nbroken-line'),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// §5.3 snapshot pruning / retention
// ---------------------------------------------------------------------------

describe("P12-005 §5.3 snapshot pruning / retention", () => {
  const NOW = "2026-09-22T00:00:00Z";
  const entries: ReadonlyArray<SnapshotCatalogEntry> = [
    { ref: "snap-old", capturedAt: "2026-09-01T00:00:00Z" },
    { ref: "snap-recent", capturedAt: "2026-09-21T23:00:00Z" },
    { ref: "snap-referenced-old", capturedAt: "2026-08-01T00:00:00Z" },
  ];
  const referenced = new Set(["snap-referenced-old"]);

  it("plan: referenced snapshots are kept; unreferenced old snapshots are pruned", () => {
    const plan = planSnapshotRetention(
      entries,
      { keepLastN: 1, maxAge: "PT24H" },
      NOW,
      referenced,
    );
    expect(plan.prune).toContain("snap-old");
    expect(plan.prune).not.toContain("snap-referenced-old");
    expect(plan.keep).toContain("snap-referenced-old");
    expect(plan.keep).toContain("snap-recent");
  });

  it("ops action: unreferenced pruned, referenced retained, canonical records untouched", async () => {
    const deleted: string[] = [];
    const deps = {
      listSnapshots: () => entries,
      listReferencedRefs: () => referenced,
      deleteSnapshot: (ref: string) => {
        deleted.push(ref);
      },
    };
    const result = await Effect.runPromise(
      pruneSnapshots(deps, { keepLastN: 1, maxAge: "PT24H" }, NOW),
    );
    expect(result.pruned).toContain("snap-old");
    expect(result.retained).toContain("snap-referenced-old");
    expect(deleted).toContain("snap-old");
    // A referenced snapshot is never deleted (canonical reference intact).
    expect(deleted).not.toContain("snap-referenced-old");
    expect(referenced.has("snap-referenced-old")).toBe(true);
  });

  it("pruned-but-referenced snapshot is refused (typed), never silently dropped", async () => {
    let deleted = 0;
    const deps = {
      listSnapshots: () => entries,
      listReferencedRefs: () => referenced,
      deleteSnapshot: () => {
        deleted += 1;
      },
    };
    const failure = await Effect.runPromise(
      Effect.flip(pruneSnapshotRef(deps, "snap-referenced-old")),
    );
    expect(failure._tag).toBe("SnapshotPrunedButReferenced");
    expect(deleted).toBe(0);

    // An unreferenced ref is pruned.
    await Effect.runPromise(pruneSnapshotRef(deps, "snap-old"));
    expect(deleted).toBe(1);
  });
});
