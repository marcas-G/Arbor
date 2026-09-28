import { readFileSync } from "node:fs";
import { it, type TestFunction } from "vitest";

export const EVIDENCE_LEVELS = ["L1", "L2", "L3"] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const PROVIDER_MODES = ["NONE", "FAKE", "RECORDING", "REAL"] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

export const CAPABILITY_STATUSES = [
  "PASS",
  "FAIL",
  "BLOCKED_BY_IMPLEMENTATION",
  "BLOCKED_BY_DESIGN_GAP",
  "NOT_RUN",
] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export interface CapabilityCaseMetadata {
  readonly caseId: string;
  readonly capabilityId: string;
  readonly evidenceLevel: EvidenceLevel;
  readonly providerMode: ProviderMode;
  readonly requiresPersistence: boolean;
  readonly requiresRestart: boolean;
  readonly expectedStatus: CapabilityStatus;
}

export interface CapabilityDefinition {
  readonly capabilityId: string;
  readonly title: string;
  readonly l1Suites: ReadonlyArray<string>;
  readonly l2Suites: ReadonlyArray<string>;
  readonly l2ProviderMode?: ProviderMode;
  readonly l2ExpectedStatus?: CapabilityStatus;
  readonly l2BlockingReason?: string;
  readonly l3: CapabilityCaseMetadata & {
    readonly testFile: string | null;
    readonly blockingReason: string;
  };
}

interface CapabilityCatalog {
  readonly schemaVersion: "arbor-capability-cases-v1";
  readonly capabilities: ReadonlyArray<CapabilityDefinition>;
}

const catalogUrl = new URL("./case-catalog.json", import.meta.url);
export const CAPABILITY_CATALOG = JSON.parse(
  readFileSync(catalogUrl, "utf8"),
) as CapabilityCatalog;

const isOneOf = <T extends string>(
  values: ReadonlyArray<T>,
  value: string,
): value is T => values.some((candidate) => candidate === value);

export const validateCapabilityMetadata = (
  value: CapabilityCaseMetadata,
): ReadonlyArray<string> => {
  const errors: string[] = [];
  if (!/^[A-Z0-9]+-[A-Z0-9-]+$/.test(value.caseId)) {
    errors.push("caseId must be a stable uppercase identifier");
  }
  if (!/^B\d{2}$/.test(value.capabilityId)) {
    errors.push("capabilityId must identify a catalogued B01-B14 capability");
  }
  if (!isOneOf(EVIDENCE_LEVELS, value.evidenceLevel)) {
    errors.push("evidenceLevel must be L1, L2, or L3");
  }
  if (!isOneOf(PROVIDER_MODES, value.providerMode)) {
    errors.push("providerMode must be NONE, FAKE, RECORDING, or REAL");
  }
  if (typeof value.requiresPersistence !== "boolean") {
    errors.push("requiresPersistence must be boolean");
  }
  if (typeof value.requiresRestart !== "boolean") {
    errors.push("requiresRestart must be boolean");
  }
  if (!isOneOf(CAPABILITY_STATUSES, value.expectedStatus)) {
    errors.push("expectedStatus is not a legal capability status");
  }
  return errors;
};

export const metadataFor = (
  capabilityId: string,
  evidenceLevel: EvidenceLevel,
): CapabilityCaseMetadata => {
  const capability = CAPABILITY_CATALOG.capabilities.find(
    (entry) => entry.capabilityId === capabilityId,
  );
  if (capability === undefined) {
    throw new Error(`unknown Arbor capability: ${capabilityId}`);
  }
  if (evidenceLevel === "L3") {
    return {
      ...capability.l3,
      capabilityId,
    };
  }
  return {
    caseId: `${capabilityId}-${evidenceLevel}`,
    capabilityId,
    evidenceLevel,
    providerMode:
      evidenceLevel === "L2"
        ? (capability.l2ProviderMode ??
          (capabilityId === "B01" || capabilityId === "B04"
            ? "RECORDING"
            : "NONE"))
        : "NONE",
    requiresPersistence: evidenceLevel === "L2",
    requiresRestart:
      evidenceLevel === "L2" &&
      (capabilityId === "B12" || capabilityId === "B13"),
    expectedStatus: capability.l2ExpectedStatus ?? "PASS",
  };
};

export const defineCapabilityTest = (
  metadata: CapabilityCaseMetadata,
  name: string,
  testBody: TestFunction,
): void => {
  const errors = validateCapabilityMetadata(metadata);
  if (errors.length > 0) {
    throw new Error(
      `invalid capability test metadata ${metadata.caseId}: ${errors.join("; ")}`,
    );
  }
  it(`[${metadata.caseId}] ${name}`, testBody);
};
