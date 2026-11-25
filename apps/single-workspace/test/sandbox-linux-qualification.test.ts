import { createHash } from "node:crypto";
import { release } from "node:os";
import {
  encodeSandboxAuthorityBundleV2,
  encodeSandboxAuthorityHighWaterV2,
  encodeSandboxEnforcementRuleSetV1,
  encodeSandboxOperatorPolicyConfigV1,
  encodeSandboxPolicyGrantIssuerConfigV1,
  encodeSandboxProviderQualificationRegistryV1,
  Principal,
  parse,
  sandboxEnforcementRuleSetV1ForProvider,
} from "@arbor/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  hasLinuxSupportedQualificationSync,
  readLinuxSupportedQualificationRows,
} from "../src/sandbox-linux-qualification.js";

const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const sourceFor = (supported: boolean, drifted = false) => {
  const issuerConfig = {
    version: 1 as const,
    revision: 1,
    issuers: [parse(Principal)("user:local")],
  };
  const operatorConfig = {
    version: 1 as const,
    revision: 1,
    environmentAllowlist: ["PATH"],
    limitsByProfile: (
      ["ReadOnly", "WorkspaceWrite", "FullAccess"] as const
    ).map((profile) => ({
      profile,
      limits: {
        wallTimeMs: 60_000,
        stdoutBytes: 8192,
        stderrBytes: 8192,
        processCount: 8,
        memoryBytes: 134_217_728,
        cpuTimeMs: 30_000,
      },
    })),
    trustedLocalRuntimeVersion: "builtin-v1" as const,
  };
  const ruleSet = sandboxEnforcementRuleSetV1ForProvider("linux-bwrap");
  if (ruleSet === undefined) throw new Error("Linux rule set missing");
  const ruleDigest = hash(encodeSandboxEnforcementRuleSetV1(ruleSet));
  const registry = {
    version: 1 as const,
    revision: 1,
    entries: supported
      ? [
          {
            providerId: "linux-bwrap",
            providerVersion: "linux-bwrap-qualified-v1",
            capabilityRevision: 1,
            osFamily: "Linux" as const,
            osBuild: release(),
            tuple: {
              profile: "WorkspaceWrite" as const,
              networkMode: "Enabled" as const,
              networkPolicyCodecVersion: 1 as const,
              enforcementRuleSetDigest: ruleDigest,
            },
            status: "Supported" as const,
            qualificationEvidenceRef: `blob:sha256:${"a".repeat(64)}`,
          },
        ]
      : [],
  };
  const bundle = {
    version: 2 as const,
    sourceIdentity: "host:test-linux-qualification",
    bundleRevision: 1,
    issuerConfigRevision: 1,
    issuerConfigDigest: hash(
      encodeSandboxPolicyGrantIssuerConfigV1(issuerConfig),
    ),
    issuerConfig,
    operatorConfigRevision: 1,
    operatorConfigDigest: hash(
      encodeSandboxOperatorPolicyConfigV1(operatorConfig),
    ),
    operatorConfig,
    providerRegistryRevision: 1,
    providerRegistryDigest: hash(
      encodeSandboxProviderQualificationRegistryV1(registry),
    ),
    providerRegistry: registry,
  };
  const canonicalJson = encodeSandboxAuthorityBundleV2(bundle);
  const highWaterJson = encodeSandboxAuthorityHighWaterV2({
    version: 2,
    sourceIdentity: bundle.sourceIdentity,
    bundleRevision: drifted ? bundle.bundleRevision + 1 : bundle.bundleRevision,
    bundleDigest: hash(canonicalJson),
    issuerConfigRevision: bundle.issuerConfigRevision,
    issuerConfigDigest: bundle.issuerConfigDigest,
    operatorConfigRevision: bundle.operatorConfigRevision,
    operatorConfigDigest: bundle.operatorConfigDigest,
    providerRegistryRevision: bundle.providerRegistryRevision,
    providerRegistryDigest: bundle.providerRegistryDigest,
  });
  return {
    readVerifiedSandboxAuthorityBundle: () =>
      Effect.succeed({
        sourceIdentity: bundle.sourceIdentity,
        canonicalJson,
      }),
    readSandboxAuthorityHighWater: () => Effect.succeed(highWaterJson),
    commitSandboxAuthorityHighWater: () => Effect.succeed(false),
    appendSandboxAuthorityAudit: () => Effect.succeed(true),
  };
};

describe("Linux qualification source projection", () => {
  it("projects exact current-host Supported rows", async () => {
    const source = sourceFor(true);
    await expect(readLinuxSupportedQualificationRows(source)).resolves.toEqual([
      expect.objectContaining({
        providerId: "linux-bwrap",
        providerVersion: "linux-bwrap-qualified-v1",
        capabilityRevision: "1",
        profile: "WorkspaceWrite",
        networkMode: "Enabled",
      }),
    ]);
    expect(hasLinuxSupportedQualificationSync(source)).toBe(true);
  });

  it("keeps the catalog closed when no Supported row exists", async () => {
    const source = sourceFor(false);
    await expect(readLinuxSupportedQualificationRows(source)).resolves.toEqual(
      [],
    );
    expect(hasLinuxSupportedQualificationSync(source)).toBe(false);
  });

  it("keeps the catalog closed when the source and high-water pair drift", async () => {
    const source = sourceFor(true, true);
    await expect(readLinuxSupportedQualificationRows(source)).resolves.toEqual(
      [],
    );
    expect(hasLinuxSupportedQualificationSync(source)).toBe(false);
  });
});
