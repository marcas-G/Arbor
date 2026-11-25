import { compareUtf8BytesV1 } from "./sandbox-policy-producers.js";
import type { SandboxPolicyLimitsV1 } from "./sandbox-policy-types.js";

export type SandboxLinuxQualificationProfileV2 = "ReadOnly" | "WorkspaceWrite";
export type SandboxLinuxQualificationNetworkModeV2 =
  | "Disabled"
  | "Restricted"
  | "Enabled";

export interface SandboxLinuxQualificationArtifactHashV2 {
  readonly role:
    | "adapter-runtime"
    | "adapter-source"
    | "bwrap"
    | "qualification-control"
    | "relay-runtime"
    | "relay-source"
    | "systemctl"
    | "systemd-run";
  readonly sha256: string;
}

export interface SandboxLinuxQualificationCaseV2 {
  readonly caseId: string;
  readonly verdict: "PASS";
  readonly evidenceRef: `blob:sha256:${string}`;
}

export interface SandboxLinuxQualificationManifestV2 {
  readonly version: 2;
  readonly providerId: "linux-bwrap";
  readonly providerVersion: string;
  readonly capabilityRevision: number;
  readonly osFamily: "Linux";
  readonly osBuild: string;
  readonly profile: SandboxLinuxQualificationProfileV2;
  readonly networkMode: SandboxLinuxQualificationNetworkModeV2;
  readonly networkPolicyCodecVersion: 1;
  readonly enforcementRuleSetDigest: string;
  readonly validatedLimits: SandboxPolicyLimitsV1;
  readonly artifactHashes: ReadonlyArray<SandboxLinuxQualificationArtifactHashV2>;
  readonly cases: ReadonlyArray<SandboxLinuxQualificationCaseV2>;
}

const digestPattern = /^[0-9a-f]{64}$/u;
const refPattern = /^blob:sha256:[0-9a-f]{64}$/u;
const textPattern = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;
const roles = [
  "adapter-runtime",
  "adapter-source",
  "bwrap",
  "qualification-control",
  "relay-runtime",
  "relay-source",
  "systemctl",
  "systemd-run",
] as const;
const baseCases = [
  "artifact-drift",
  "cancel-before-spawn",
  "cancel-running-tree",
  "dns-mixed-denied",
  "dns-rebinding",
  "env-secret-absent",
  "file-ro",
  "file-rw",
  "file-outside-denied",
  "host-loopback-denied",
  "namespace-escape-denied",
  "output-bound",
  "private-target-denied",
  "process-limit",
  "public-https",
  "raw-network-denied",
  "readonly-sharing",
  "resource-cpu",
  "resource-memory",
  "same-namespace-tcp",
  "socket-outside-denied",
  "timeout-tree",
] as const;

const exactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
): boolean =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const text = (value: unknown): value is string =>
  typeof value === "string" && textPattern.test(value);
const sorted = (values: ReadonlyArray<string>): boolean =>
  values.every((value, index) => {
    const prior = values[index - 1];
    return (
      index === 0 ||
      (prior !== undefined && compareUtf8BytesV1(prior, value) < 0)
    );
  });
const expectedCases = (
  mode: SandboxLinuxQualificationNetworkModeV2,
): ReadonlyArray<string> =>
  [
    ...baseCases,
    ...(mode === "Restricted" ? ["restricted-allow", "restricted-deny"] : []),
  ]
    .map((caseId) =>
      mode === "Disabled" && caseId === "public-https"
        ? "disabled-egress-denied"
        : caseId,
    )
    .sort(compareUtf8BytesV1);

const encodeLimits = (limits: SandboxPolicyLimitsV1): string =>
  `{"wallTimeMs":${limits.wallTimeMs},"stdoutBytes":${limits.stdoutBytes},"stderrBytes":${limits.stderrBytes},"processCount":${limits.processCount},"memoryBytes":${limits.memoryBytes},"cpuTimeMs":${limits.cpuTimeMs}}`;

export const encodeSandboxLinuxQualificationManifestV2 = (
  manifest: SandboxLinuxQualificationManifestV2,
): string =>
  `{"version":2,"providerId":"linux-bwrap","providerVersion":${JSON.stringify(manifest.providerVersion)},"capabilityRevision":${manifest.capabilityRevision},"osFamily":"Linux","osBuild":${JSON.stringify(manifest.osBuild)},"profile":${JSON.stringify(manifest.profile)},"networkMode":${JSON.stringify(manifest.networkMode)},"networkPolicyCodecVersion":1,"enforcementRuleSetDigest":${JSON.stringify(manifest.enforcementRuleSetDigest)},"validatedLimits":${encodeLimits(manifest.validatedLimits)},"artifactHashes":[${[
    ...manifest.artifactHashes,
  ]
    .sort((left, right) => compareUtf8BytesV1(left.role, right.role))
    .map(
      (artifact) =>
        `{"role":${JSON.stringify(artifact.role)},"sha256":${JSON.stringify(artifact.sha256)}}`,
    )
    .join(",")}],"cases":[${[...manifest.cases]
    .sort((left, right) => compareUtf8BytesV1(left.caseId, right.caseId))
    .map(
      (testCase) =>
        `{"caseId":${JSON.stringify(testCase.caseId)},"verdict":"PASS","evidenceRef":${JSON.stringify(testCase.evidenceRef)}}`,
    )
    .join(",")}]}`;

export const decodeSandboxLinuxQualificationManifestV2 = (
  input: unknown,
): SandboxLinuxQualificationManifestV2 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  const limits = value.validatedLimits as Record<string, unknown> | undefined;
  const artifacts = value.artifactHashes;
  const cases = value.cases;
  if (
    !exactKeys(value, [
      "version",
      "providerId",
      "providerVersion",
      "capabilityRevision",
      "osFamily",
      "osBuild",
      "profile",
      "networkMode",
      "networkPolicyCodecVersion",
      "enforcementRuleSetDigest",
      "validatedLimits",
      "artifactHashes",
      "cases",
    ]) ||
    value.version !== 2 ||
    value.providerId !== "linux-bwrap" ||
    !text(value.providerVersion) ||
    !positive(value.capabilityRevision) ||
    value.osFamily !== "Linux" ||
    !text(value.osBuild) ||
    (value.profile !== "ReadOnly" && value.profile !== "WorkspaceWrite") ||
    (value.networkMode !== "Disabled" &&
      value.networkMode !== "Restricted" &&
      value.networkMode !== "Enabled") ||
    value.networkPolicyCodecVersion !== 1 ||
    typeof value.enforcementRuleSetDigest !== "string" ||
    !digestPattern.test(value.enforcementRuleSetDigest) ||
    typeof limits !== "object" ||
    limits === null ||
    Array.isArray(limits) ||
    !exactKeys(limits, [
      "wallTimeMs",
      "stdoutBytes",
      "stderrBytes",
      "processCount",
      "memoryBytes",
      "cpuTimeMs",
    ]) ||
    !Object.values(limits).every(positive) ||
    !Array.isArray(artifacts) ||
    artifacts.length !== roles.length ||
    !Array.isArray(cases)
  )
    return undefined;
  const decodedArtifacts = artifacts.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    )
      return undefined;
    const artifact = candidate as Record<string, unknown>;
    return exactKeys(artifact, ["role", "sha256"]) &&
      roles.includes(artifact.role as (typeof roles)[number]) &&
      typeof artifact.sha256 === "string" &&
      digestPattern.test(artifact.sha256)
      ? {
          role: artifact.role as SandboxLinuxQualificationArtifactHashV2["role"],
          sha256: artifact.sha256,
        }
      : undefined;
  });
  const decodedCases = cases.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    )
      return undefined;
    const testCase = candidate as Record<string, unknown>;
    return exactKeys(testCase, ["caseId", "verdict", "evidenceRef"]) &&
      typeof testCase.caseId === "string" &&
      /^[a-z0-9-]{1,96}$/u.test(testCase.caseId) &&
      testCase.verdict === "PASS" &&
      typeof testCase.evidenceRef === "string" &&
      refPattern.test(testCase.evidenceRef)
      ? {
          caseId: testCase.caseId,
          verdict: "PASS",
          evidenceRef: testCase.evidenceRef as `blob:sha256:${string}`,
        }
      : undefined;
  });
  if (
    decodedArtifacts.some((artifact) => artifact === undefined) ||
    decodedCases.some((testCase) => testCase === undefined)
  )
    return undefined;
  const artifactValues =
    decodedArtifacts as SandboxLinuxQualificationArtifactHashV2[];
  const caseValues = decodedCases as SandboxLinuxQualificationCaseV2[];
  if (
    new Set(artifactValues.map((artifact) => artifact.role)).size !==
      roles.length ||
    !sorted(artifactValues.map((artifact) => artifact.role)) ||
    !sorted(caseValues.map((testCase) => testCase.caseId)) ||
    caseValues.map((testCase) => testCase.caseId).join("\0") !==
      expectedCases(value.networkMode).join("\0")
  )
    return undefined;
  const manifest: SandboxLinuxQualificationManifestV2 = {
    version: 2,
    providerId: "linux-bwrap",
    providerVersion: value.providerVersion,
    capabilityRevision: value.capabilityRevision,
    osFamily: "Linux",
    osBuild: value.osBuild,
    profile: value.profile,
    networkMode: value.networkMode,
    networkPolicyCodecVersion: 1,
    enforcementRuleSetDigest: value.enforcementRuleSetDigest,
    validatedLimits: {
      wallTimeMs: limits.wallTimeMs as number,
      stdoutBytes: limits.stdoutBytes as number,
      stderrBytes: limits.stderrBytes as number,
      processCount: limits.processCount as number,
      memoryBytes: limits.memoryBytes as number,
      cpuTimeMs: limits.cpuTimeMs as number,
    },
    artifactHashes: artifactValues,
    cases: caseValues,
  };
  return encodeSandboxLinuxQualificationManifestV2(manifest) ===
    JSON.stringify(input)
    ? manifest
    : undefined;
};

export const decodeCanonicalSandboxLinuxQualificationManifestV2 = (
  json: string,
): SandboxLinuxQualificationManifestV2 | undefined => {
  try {
    return decodeSandboxLinuxQualificationManifestV2(JSON.parse(json));
  } catch {
    return undefined;
  }
};
