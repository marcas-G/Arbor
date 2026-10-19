import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeCanonicalResourceBoundaryDigestInputV1,
  decodeCanonicalSandboxAuthorityAuditRecordV2,
  decodeCanonicalSandboxAuthorityBundleV2,
  decodeCanonicalSandboxAuthorityHighWaterV2,
  decodeCanonicalSandboxOperatorPolicyConfigV1,
  decodeCanonicalSandboxTargetRefV1,
  decodeNetworkBrokerControlsV1,
  decodeSandboxOperatorPolicyConfigV1,
  encodeResourceBoundaryDigestInputV1,
  encodeSandboxAuthorityAuditRecordV2,
  encodeSandboxAuthorityBundleV2,
  encodeSandboxAuthorityHighWaterV2,
  encodeSandboxOperatorPolicyConfigV1,
  encodeSandboxTargetRefV1,
  networkBrokerControlsV1ForMode,
  resourceBoundaryDigestOfV1,
  sandboxTargetRefOfRegionV1,
  targetRefDigestV1,
} from "../src/index.js";
import type {
  SandboxAuthorityBundleV2,
  SandboxAuthorityHighWaterV2,
  SandboxOperatorPolicyConfigV1,
} from "../src/sandbox-policy-authority-v2.js";

const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const operatorConfig: SandboxOperatorPolicyConfigV1 = {
  version: 1,
  revision: 2,
  environmentAllowlist: ["PATH"],
  limitsByProfile: [
    {
      profile: "ReadOnly",
      limits: {
        wallTimeMs: 60_000,
        stdoutBytes: 8192,
        stderrBytes: 8192,
        processCount: 8,
        memoryBytes: 134_217_728,
        cpuTimeMs: 30_000,
      },
    },
    {
      profile: "WorkspaceWrite",
      limits: {
        wallTimeMs: 60_000,
        stdoutBytes: 8192,
        stderrBytes: 8192,
        processCount: 8,
        memoryBytes: 134_217_728,
        cpuTimeMs: 30_000,
      },
    },
    {
      profile: "FullAccess",
      limits: {
        wallTimeMs: 60_000,
        stdoutBytes: 8192,
        stderrBytes: 8192,
        processCount: 8,
        memoryBytes: 134_217_728,
        cpuTimeMs: 30_000,
      },
    },
  ],
  trustedLocalRuntimeVersion: "builtin-v1",
};

describe("sandbox policy producer codecs", () => {
  it("uses the frozen ResourceBoundaryDigest revision-zero KAT", () => {
    const preimage = encodeResourceBoundaryDigestInputV1({
      version: 1,
      basisResponsibilityRevision: 0,
      regions: [
        '{"resourceSpaceId":"filesystem","kind":"FileTree","path":"/fixture/a"}',
      ],
    });
    expect(preimage).toBe(
      '{"version":1,"basisResponsibilityRevision":0,"regions":["{\\"resourceSpaceId\\":\\"filesystem\\",\\"kind\\":\\"FileTree\\",\\"path\\":\\"/fixture/a\\"}"]}',
    );
    expect(
      resourceBoundaryDigestOfV1(
        0,
        [
          '{"resourceSpaceId":"filesystem","kind":"FileTree","path":"/fixture/a"}',
        ],
        hash,
      ),
    ).toBe("429afbb35ca0bd989c5d0bfeebd60887c240f9ddeb1acdf29ab52f5564e10f6c");
    expect(decodeCanonicalResourceBoundaryDigestInputV1(preimage)).toEqual({
      version: 1,
      basisResponsibilityRevision: 0,
      regions: [
        '{"resourceSpaceId":"filesystem","kind":"FileTree","path":"/fixture/a"}',
      ],
    });
    expect(resourceBoundaryDigestOfV1(-1, [], hash)).toBeUndefined();
  });

  it("keeps TargetRef object-shaped and broker controls closed by mode", () => {
    const targetRef = {
      version: 1 as const,
      kind: "RegionDigest" as const,
      resourceSpace: "filesystem" as const,
      regionIdentityDigest: "a".repeat(64),
    };
    const targetBytes = encodeSandboxTargetRefV1(targetRef);
    expect(decodeCanonicalSandboxTargetRefV1(targetBytes)).toEqual(targetRef);
    expect(
      decodeCanonicalSandboxTargetRefV1('"target_workspace"'),
    ).toBeUndefined();
    const knownRegion = {
      resourceSpaceId: "filesystem",
      normalizedRegion: {
        kind: "FileTree",
        path: "C:\\v17-fixture\\workspace",
      },
    } as const;
    const knownRef = sandboxTargetRefOfRegionV1(knownRegion, hash);
    expect(knownRef).toEqual({
      version: 1,
      kind: "RegionDigest",
      resourceSpace: "filesystem",
      regionIdentityDigest:
        "3156810bbb81123146cfaa091838168edefd1e7ffe1306e2e414368d4afa86db",
    });
    expect(knownRef && targetRefDigestV1(knownRef, hash)).toBe(
      "a5e1c895446495056e9bca489b14b3b0f3553bb8c851628e39b66d0aa8b1156e",
    );
    for (const mode of ["Disabled", "Restricted", "Enabled"] as const) {
      const controls = networkBrokerControlsV1ForMode(mode);
      expect(decodeNetworkBrokerControlsV1(controls)).toEqual(controls);
    }
    expect(
      decodeNetworkBrokerControlsV1({
        ...networkBrokerControlsV1ForMode("Restricted"),
        pref64: "Cached",
      }),
    ).toBeUndefined();
  });

  it("strictly decodes operator policy and V2 bundle/high-water canonical bytes", () => {
    const operatorBytes = encodeSandboxOperatorPolicyConfigV1(operatorConfig);
    expect(
      decodeCanonicalSandboxOperatorPolicyConfigV1(operatorBytes, ["PATH"]),
    ).toEqual(operatorConfig);
    expect(
      decodeSandboxOperatorPolicyConfigV1(
        { ...operatorConfig, environmentAllowlist: ["HOME"] },
        ["PATH"],
      ),
    ).toBeUndefined();

    const issuerConfig = {
      version: 1 as const,
      revision: 1,
      issuers: ["user:operator"],
    };
    const providerRegistry = { version: 1 as const, revision: 1, entries: [] };
    const bundleBase = {
      version: 2 as const,
      sourceIdentity: "machine:arbor",
      bundleRevision: 3,
      issuerConfigRevision: 1,
      issuerConfig,
      operatorConfigRevision: 2,
      operatorConfig,
      providerRegistryRevision: 1,
      providerRegistry,
    };
    const issuerDigest = hash(
      '{"version":1,"revision":1,"issuers":["user:operator"]}',
    );
    const operatorDigest = hash(operatorBytes);
    const registryDigest = hash('{"version":1,"revision":1,"entries":[]}');
    const bundle: SandboxAuthorityBundleV2 = {
      ...bundleBase,
      issuerConfigDigest: issuerDigest,
      operatorConfigDigest: operatorDigest,
      providerRegistryDigest: registryDigest,
    };
    const bundleBytes = encodeSandboxAuthorityBundleV2(bundle);
    expect(
      decodeCanonicalSandboxAuthorityBundleV2(bundleBytes, ["PATH"], hash)
        ?.bundle,
    ).toEqual(bundle);

    const highWater: SandboxAuthorityHighWaterV2 = {
      version: 2,
      sourceIdentity: bundle.sourceIdentity,
      bundleRevision: bundle.bundleRevision,
      bundleDigest: hash(bundleBytes),
      issuerConfigRevision: bundle.issuerConfigRevision,
      issuerConfigDigest: bundle.issuerConfigDigest,
      operatorConfigRevision: bundle.operatorConfigRevision,
      operatorConfigDigest: bundle.operatorConfigDigest,
      providerRegistryRevision: bundle.providerRegistryRevision,
      providerRegistryDigest: bundle.providerRegistryDigest,
    };
    expect(
      decodeCanonicalSandboxAuthorityHighWaterV2(
        encodeSandboxAuthorityHighWaterV2(highWater),
      ),
    ).toEqual(highWater);

    const audit = {
      version: 2 as const,
      outcome: "Rejected" as const,
      detail: "HighWaterCorrupt" as const,
      sourceIdentity: null,
      bundleRevision: null,
      bundleDigest: null,
      issuerConfigRevision: null,
      issuerConfigDigest: null,
      operatorConfigRevision: null,
      operatorConfigDigest: null,
      providerRegistryRevision: null,
      providerRegistryDigest: null,
      occurredAt: "2026-10-19T00:00:00.000Z",
    };
    const auditBytes = encodeSandboxAuthorityAuditRecordV2(audit);
    expect(decodeCanonicalSandboxAuthorityAuditRecordV2(auditBytes)).toEqual(
      audit,
    );
    expect(
      decodeCanonicalSandboxAuthorityAuditRecordV2(
        auditBytes.replace('"version":2', '"version":1'),
      ),
    ).toBeUndefined();
  });
});
