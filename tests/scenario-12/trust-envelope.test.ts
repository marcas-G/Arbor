import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SANDBOX_ENV_ALLOWLIST,
  sandboxEnvironment,
} from "../../adapters/sandbox-local/dist/index.js";
import {
  ENVELOPE_DIMENSIONS,
  type Measurement,
  type OperatingEnvelope,
  validateStorageScaleAssessment,
} from "../../packages/application/src/storage-assessment.js";
import {
  canRaiseAuthority,
  contextFragment,
  planContext,
} from "../../packages/model-context/src/index.js";
import type { InformationTrustMetadata } from "../../packages/ports/src/index.js";
import { readRepoFile } from "./support.js";

// ---------------------------------------------------------------------------
// story 13 (`13`): Information Trust Plane + sandbox + operating envelope
// ---------------------------------------------------------------------------

const trust = (
  provenanceKind: InformationTrustMetadata["provenanceKind"],
): InformationTrustMetadata => ({
  provenanceKind,
  instructionCapability: "DataOnly",
  epistemicStatus: "Established",
});

describe("-acceptance story 13 — security hardening + performance", () => {
  it("story 13: DataOnly fragments cannot raise authority and the operating envelope is measured", () => {
    const dataKinds: ReadonlyArray<InformationTrustMetadata["provenanceKind"]> =
      [
        "ToolObservation",
        "ExternalRetrieved",
        "AuthenticatedAgent",
        "AuthenticatedHuman",
        "ImportedArtifact",
        "ModelDerived",
      ];
    for (const kind of dataKinds) {
      const fragment = contextFragment({
        ref: `f-${kind}`,
        layer: "C3",
        retention: "Evictable",
        cacheClass: "TurnDynamic",
        tokens: 10,
        provenance: trust(kind),
      });
      expect(fragment.provenance.instructionCapability).toBe("DataOnly");
      expect(canRaiseAuthority(fragment.provenance)).toBe(false);
    }
    const canonical = contextFragment({
      ref: "canonical",
      layer: "C0",
      retention: "Pinned",
      cacheClass: "Stable",
      tokens: 10,
      provenance: {
        provenanceKind: "CanonicalInternal",
        instructionCapability: "DataOnly",
        epistemicStatus: "Established",
      },
    });
    expect(canonical.provenance.instructionCapability).toBe(
      "CanonicalInstruction",
    );
    expect(canRaiseAuthority(canonical.provenance)).toBe(true);
    const planned = planContext([canonical], {
      modelWindow: 100,
      outputReserve: 20,
      protocolReserve: 10,
      toolReserve: 10,
    });
    expect(planned.selected[0]?.provenance).toEqual(canonical.provenance);

    const sentinel = `SENTINEL_SECRET_${randomUUID().replace(/-/g, "")}`;
    const projected = sandboxEnvironment({
      PATH: "/usr/bin:/bin",
      [sentinel]: "must-not-leak",
    });
    expect(sentinel in projected).toBe(false);
    expect(
      Object.keys(projected).every((key) =>
        SANDBOX_ENV_ALLOWLIST.includes(key),
      ),
    ).toBe(true);

    const assessment = JSON.parse(
      readRepoFile("planning/results/P12.storage-assessment.json"),
    ) as {
      operatingEnvelope: OperatingEnvelope;
      measurements: ReadonlyArray<Measurement>;
      verdict: string;
    };
    expect(validateStorageScaleAssessment(assessment)).toEqual([]);
    for (const dimension of ENVELOPE_DIMENSIONS) {
      expect(typeof assessment.operatingEnvelope[dimension].value).toBe(
        "number",
      );
    }
    for (const measurement of assessment.measurements) {
      expect(measurement.method.length).toBeGreaterThan(0);
    }
  });
});
