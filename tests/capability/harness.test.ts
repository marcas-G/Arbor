import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CATALOG,
  CAPABILITY_STATUSES,
  EVIDENCE_LEVELS,
  metadataFor,
  PROVIDER_MODES,
  validateCapabilityMetadata,
} from "./harness.js";

describe("Core Capability test harness metadata", () => {
  it("registers exactly B01-B14 and one L3 representation for each", () => {
    expect(
      CAPABILITY_CATALOG.capabilities.map((entry) => entry.capabilityId),
    ).toEqual([
      "B01",
      "B02",
      "B03",
      "B04",
      "B05",
      "B06",
      "B07",
      "B08",
      "B09",
      "B10",
      "B11",
      "B12",
      "B13",
      "B14",
    ]);
    for (const capability of CAPABILITY_CATALOG.capabilities) {
      expect(capability.l3.caseId).toBe(`${capability.capabilityId}-L3-REAL`);
      expect(
        validateCapabilityMetadata(metadataFor(capability.capabilityId, "L3")),
      ).toEqual([]);
      expect(capability.l3.blockingReason.length).toBeGreaterThan(0);
    }
  });

  it("uses only the declared evidence, provider, and result vocabularies", () => {
    expect(EVIDENCE_LEVELS).toEqual(["L1", "L2", "L3"]);
    expect(PROVIDER_MODES).toEqual(["NONE", "FAKE", "RECORDING", "REAL"]);
    expect(CAPABILITY_STATUSES).toEqual([
      "PASS",
      "FAIL",
      "BLOCKED_BY_IMPLEMENTATION",
      "BLOCKED_BY_DESIGN_GAP",
      "NOT_RUN",
    ]);
  });

  it("maps each existing integration case to valid metadata", () => {
    for (const capability of CAPABILITY_CATALOG.capabilities) {
      expect(
        validateCapabilityMetadata(metadataFor(capability.capabilityId, "L1")),
      ).toEqual([]);
      expect(
        validateCapabilityMetadata(metadataFor(capability.capabilityId, "L2")),
      ).toEqual([]);
    }
  });

  it("retains a mechanical blocker for every non-runnable L3 case", () => {
    const blocked = CAPABILITY_CATALOG.capabilities.filter((capability) =>
      ["BLOCKED_BY_IMPLEMENTATION", "BLOCKED_BY_DESIGN_GAP"].includes(
        capability.l3.expectedStatus,
      ),
    );
    for (const capability of blocked) {
      expect(capability.l3.blockingReason.trim().length).toBeGreaterThan(10);
    }
    expect(
      CAPABILITY_CATALOG.capabilities.find(
        (capability) => capability.capabilityId === "B10",
      )?.l3.expectedStatus,
    ).toBe("NOT_RUN");
    const b03Route = metadataFor("B03", "L2");
    expect(b03Route.expectedStatus).toBe("PASS");
    expect(b03Route.providerMode).toBe("FAKE");
    expect(
      CAPABILITY_CATALOG.capabilities.find(
        (capability) => capability.capabilityId === "B03",
      )?.l2Suites,
    ).toContain("apps/single-workspace/test/i0-send-message-durable.test.ts");
  });
});
