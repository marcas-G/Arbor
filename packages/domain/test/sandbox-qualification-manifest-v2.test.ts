import { describe, expect, it } from "vitest";
import {
  decodeCanonicalSandboxLinuxQualificationManifestV2,
  encodeSandboxLinuxQualificationManifestV2,
  type SandboxLinuxQualificationManifestV2,
} from "../src/index.js";

const caseIds = [
  "artifact-drift",
  "cancel-before-spawn",
  "cancel-running-tree",
  "dns-mixed-denied",
  "dns-rebinding",
  "env-secret-absent",
  "file-outside-denied",
  "file-ro",
  "file-rw",
  "host-loopback-denied",
  "namespace-escape-denied",
  "output-bound",
  "private-target-denied",
  "process-limit",
  "public-https",
  "readonly-sharing",
  "raw-network-denied",
  "resource-cpu",
  "resource-memory",
  "same-namespace-tcp",
  "socket-outside-denied",
  "timeout-tree",
].sort();

const manifest: SandboxLinuxQualificationManifestV2 = {
  version: 2,
  providerId: "linux-bwrap",
  providerVersion: "qualified-v2",
  capabilityRevision: 2,
  osFamily: "Linux",
  osBuild: "6.12.0",
  profile: "WorkspaceWrite",
  networkMode: "Enabled",
  networkPolicyCodecVersion: 1,
  enforcementRuleSetDigest: "a".repeat(64),
  validatedLimits: {
    wallTimeMs: 60_000,
    stdoutBytes: 1024,
    stderrBytes: 1024,
    processCount: 8,
    memoryBytes: 1024 * 1024,
    cpuTimeMs: 30_000,
  },
  artifactHashes: [
    "adapter-runtime",
    "adapter-source",
    "bwrap",
    "qualification-control",
    "relay-runtime",
    "relay-source",
    "systemctl",
    "systemd-run",
  ].map((role) => ({
    role,
    sha256: "b".repeat(64),
  })) as SandboxLinuxQualificationManifestV2["artifactHashes"],
  cases: caseIds.map((caseId) => ({
    caseId,
    verdict: "PASS" as const,
    evidenceRef: `blob:sha256:${"c".repeat(64)}` as const,
  })),
};

describe("Linux qualification manifest V2", () => {
  it("round-trips the exact enabled case and artifact sets", () => {
    const json = encodeSandboxLinuxQualificationManifestV2(manifest);
    expect(decodeCanonicalSandboxLinuxQualificationManifestV2(json)).toEqual(
      manifest,
    );
    expect(
      decodeCanonicalSandboxLinuxQualificationManifestV2(
        json.replace('"verdict":"PASS"', '"verdict":"Fail"'),
      ),
    ).toBeUndefined();
  });

  it("requires the disabled case replacement and rejects extra cases", () => {
    const disabled = {
      ...manifest,
      networkMode: "Disabled" as const,
      cases: [
        ...caseIds
          .filter((caseId) => caseId !== "public-https")
          .map((caseId) => ({
            caseId,
            verdict: "PASS" as const,
            evidenceRef: `blob:sha256:${"c".repeat(64)}` as const,
          })),
        {
          caseId: "disabled-egress-denied",
          verdict: "PASS" as const,
          evidenceRef: `blob:sha256:${"c".repeat(64)}` as const,
        },
      ].sort((left, right) => left.caseId.localeCompare(right.caseId)),
    } satisfies SandboxLinuxQualificationManifestV2;
    const json = encodeSandboxLinuxQualificationManifestV2(disabled);
    expect(decodeCanonicalSandboxLinuxQualificationManifestV2(json)).toEqual(
      disabled,
    );
    expect(
      decodeCanonicalSandboxLinuxQualificationManifestV2(
        json.replace('"caseId":"timeout-tree"', '"caseId":"extra"'),
      ),
    ).toBeUndefined();
  });
});
