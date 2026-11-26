import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runRestoreDrill } from "../../apps/single-workspace/src/restore-drill.js";
import {
  assertRestoreIsolation,
  DEFAULT_DURABILITY_ENVELOPE,
  parseDuration,
  type RestoreDrillArtifact,
  reconcileRestoredLeases,
  withinDurabilityEnvelope,
} from "../../packages/application/src/durability.js";
import {
  assessStorage,
  ENVELOPE_DIMENSIONS,
  type Measurement,
  type OperatingEnvelope,
  validateStorageScaleAssessment,
} from "../../packages/application/src/storage-assessment.js";
import { readRepoFile } from "./support.js";

// ---------------------------------------------------------------------------
// story 6 (`05`): StorageScaleAssessment + DurabilityEnvelope + restore drill
// ---------------------------------------------------------------------------

describe("p12-acceptance story 6 — storage scale + durability envelope", () => {
  it("story 6: the checked-in assessment yields a verdict and the declared envelope holds", () => {
    const assessment = JSON.parse(
      readRepoFile("planning/results/P12.storage-assessment.json"),
    ) as {
      operatingEnvelope: OperatingEnvelope;
      measurements: ReadonlyArray<Measurement>;
      verdict: string;
    };
    expect(validateStorageScaleAssessment(assessment)).toEqual([]);
    expect(["SQLiteSufficient", "PostgreSQLRequired"]).toContain(
      assessment.verdict,
    );
    const covered = new Set(
      assessment.measurements.map((entry) => entry.dimension),
    );
    for (const dimension of ENVELOPE_DIMENSIONS) {
      expect(covered.has(dimension), dimension).toBe(true);
    }
    expect(
      assessStorage(assessment.operatingEnvelope, assessment.measurements)
        .verdict,
    ).toBe(assessment.verdict);
    expect(assessStorage(assessment.operatingEnvelope, []).verdict).toBe(
      "InsufficientEvidence",
    );

    const artifact = JSON.parse(
      readRepoFile("planning/results/P12.restore-drill.json"),
    ) as RestoreDrillArtifact;
    expect(artifact.migrationUserVersion).toBe(13);
    expect(
      withinDurabilityEnvelope(artifact, DEFAULT_DURABILITY_ENVELOPE),
    ).toBe(true);
    expect(
      parseDuration(artifact.measuredRto) <=
        parseDuration(DEFAULT_DURABILITY_ENVELOPE.declaredRto),
    ).toBe(true);
    expect(artifact.restoredDbHash.startsWith("sha256:")).toBe(true);

    expect(() =>
      assertRestoreIsolation("/db/canonical.db", "/db/canonical.db"),
    ).toThrow();
    const reconciliation = reconcileRestoredLeases([
      {
        executionId: "exe_1",
        workerId: "wkr_A",
        workerIncarnationId: "wic_A1",
        generation: 3,
      },
    ]);
    expect(reconciliation.invalidatedCount).toBe(1);
    expect(reconciliation.advancedGeneration).toBe(4);
  });

  it("story 6: the restore drill actually executes end-to-end and emits its artifact", async () => {
    const artifactDir = mkdtempSync(
      join(tmpdir(), "arbor-p12-restore-artifact-"),
    );
    const artifactPath = join(artifactDir, "restore-drill.json");
    try {
      const artifact = await runRestoreDrill({
        artifactOutputPath: artifactPath,
      });
      expect(artifact.migrationUserVersion).toBe(13);
      expect(
        withinDurabilityEnvelope(artifact, DEFAULT_DURABILITY_ENVELOPE),
      ).toBe(true);
      expect(JSON.parse(readFileSync(artifactPath, "utf8"))).toEqual(artifact);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });
});
