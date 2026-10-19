import { describe, expect, it } from "vitest";
import {
  decodeCanonicalExecutionEpisodeBinding,
  decodeCanonicalNetworkPolicyV1,
  decodeCanonicalSandboxNetworkPolicySelectionV1,
  decodeCanonicalSandboxPolicyGrantIssuerConfigV1,
  decodeExecutionEpisodeBinding,
  decodeNetworkPolicyV1,
  decodeSandboxNetworkPolicySelectionV1,
  decodeSandboxPolicyGrantIssuerConfigV1,
  decodeSandboxProviderId,
  encodeExecutionEpisodeBinding,
  encodeNetworkPolicyV1,
  encodeSandboxNetworkPolicySelectionV1,
  encodeSandboxPolicyGrantIssuerConfigV1,
  type NetworkPolicyV1,
  resolveSandboxProvider,
  type SandboxProviderCapability,
} from "../src/sandbox-policy.js";

const ruleSetDigest = "b".repeat(64);
const qualificationEvidenceRef = `blob:sha256:${"a".repeat(64)}`;

const capabilities: ReadonlyArray<SandboxProviderCapability> = [
  {
    providerId: "bwrap",
    providerVersion: "0.8.0",
    capabilityRevision: "caps-v3",
    probeEvidenceRef: qualificationEvidenceRef,
    enforcementRuleSetDigest: ruleSetDigest,
    qualificationEvidenceRef,
    status: "Experimental",
    boundary: "OsEnforced",
    profiles: ["WorkspaceWrite"],
    networkModes: ["Disabled"],
  },
  {
    providerId: "TrustedLocal",
    providerVersion: "builtin-v1",
    capabilityRevision: "trusted-v1",
    probeEvidenceRef: "evidence:trusted-local-v1",
    enforcementRuleSetDigest: null,
    qualificationEvidenceRef: null,
    status: "Supported",
    boundary: "TrustedLocal",
    profiles: ["WorkspaceWrite", "FullAccess"],
    networkModes: ["Disabled", "Restricted", "Enabled"],
  },
];

describe("sandbox policy provider selection", () => {
  it("decodes the historical LocalTrusted identifier to canonical TrustedLocal", () => {
    expect(decodeSandboxProviderId("LocalTrusted")).toBe("TrustedLocal");
    expect(decodeSandboxProviderId("TrustedLocal")).toBe("TrustedLocal");
  });

  it("rejects malformed provider identifiers", () => {
    expect(decodeSandboxProviderId(null)).toBeUndefined();
    expect(decodeSandboxProviderId("  ")).toBeUndefined();
    expect(decodeSandboxProviderId("bwrap/")).toBeUndefined();
  });

  it("does not fall back to TrustedLocal when the requested OS provider is not Supported", () => {
    expect(
      resolveSandboxProvider(
        {
          providerId: "bwrap",
          expectedProviderVersion: "0.8.0",
          expectedCapabilityRevision: "caps-v3",
          expectedEnforcementRuleSetDigest: ruleSetDigest,
          expectedQualificationEvidenceRef: qualificationEvidenceRef,
          profile: "WorkspaceWrite",
          networkPolicy: { version: 1, mode: "Disabled", destinations: [] },
          boundary: "OsEnforced",
        },
        capabilities,
      ),
    ).toMatchObject({
      _tag: "Unavailable",
      reason: "ProviderNotSupported",
      capability: { providerId: "bwrap", providerVersion: "0.8.0" },
    });
  });

  it("requires explicit TrustedLocal policy selection and reports its weaker boundary", () => {
    expect(
      resolveSandboxProvider(
        {
          providerId: "TrustedLocal",
          expectedProviderVersion: "builtin-v1",
          expectedCapabilityRevision: "trusted-v1",
          expectedEnforcementRuleSetDigest: null,
          expectedQualificationEvidenceRef: null,
          profile: "WorkspaceWrite",
          networkPolicy: { version: 1, mode: "Disabled", destinations: [] },
          boundary: "TrustedLocal",
        },
        capabilities,
      ),
    ).toMatchObject({
      _tag: "Available",
      capability: { providerId: "TrustedLocal", boundary: "TrustedLocal" },
    });
    expect(
      resolveSandboxProvider(
        {
          providerId: "LocalTrusted",
          expectedProviderVersion: "builtin-v1",
          expectedCapabilityRevision: "trusted-v1",
          expectedEnforcementRuleSetDigest: null,
          expectedQualificationEvidenceRef: null,
          profile: "WorkspaceWrite",
          networkPolicy: { version: 1, mode: "Disabled", destinations: [] },
          boundary: "OsEnforced",
        },
        capabilities,
      ),
    ).toEqual({ _tag: "Unavailable", reason: "ProviderNotFound" });
  });

  it("pins provider version and capability revision exactly", () => {
    const selection = {
      providerId: "bwrap",
      expectedProviderVersion: "0.7.0",
      expectedCapabilityRevision: "caps-v3",
      expectedEnforcementRuleSetDigest: ruleSetDigest,
      expectedQualificationEvidenceRef: qualificationEvidenceRef,
      profile: "WorkspaceWrite" as const,
      networkPolicy: {
        version: 1 as const,
        mode: "Disabled" as const,
        destinations: [],
      },
      boundary: "OsEnforced" as const,
    };
    expect(resolveSandboxProvider(selection, capabilities)).toMatchObject({
      _tag: "Unavailable",
      reason: "ProviderVersionMismatch",
      capability: { providerId: "bwrap", providerVersion: "0.8.0" },
    });
    expect(
      resolveSandboxProvider(
        {
          ...selection,
          expectedProviderVersion: "0.8.0",
          expectedCapabilityRevision: "caps-v2",
        },
        capabilities,
      ),
    ).toMatchObject({
      _tag: "Unavailable",
      reason: "CapabilityRevisionMismatch",
      capability: { providerId: "bwrap", providerVersion: "0.8.0" },
    });
  });

  it("requires exact full enforcement digest and qualification evidence on OS selections", () => {
    const selection = {
      providerId: "bwrap",
      expectedProviderVersion: "0.8.0",
      expectedCapabilityRevision: "caps-v3",
      expectedEnforcementRuleSetDigest: ruleSetDigest,
      expectedQualificationEvidenceRef: qualificationEvidenceRef,
      profile: "WorkspaceWrite" as const,
      networkPolicy: {
        version: 1 as const,
        mode: "Disabled" as const,
        destinations: [],
      },
      boundary: "OsEnforced" as const,
    };
    const baseCapability = capabilities.find(
      (capability) => capability.providerId === "bwrap",
    );
    if (baseCapability === undefined)
      throw new Error("bwrap test capability is missing");
    const supportedCapability = {
      ...baseCapability,
      status: "Supported" as const,
      profiles: ["WorkspaceWrite" as const],
    };
    expect(
      resolveSandboxProvider(selection, [supportedCapability]),
    ).toMatchObject({
      _tag: "Available",
    });
    expect(
      resolveSandboxProvider(selection, [
        { ...supportedCapability, probeEvidenceRef: "sha256:old-probe" },
      ]),
    ).toMatchObject({
      _tag: "Unavailable",
      reason: "QualificationEvidenceMismatch",
    });
    expect(
      resolveSandboxProvider(selection, [
        { ...supportedCapability, qualificationEvidenceRef: null },
      ]),
    ).toMatchObject({
      _tag: "Unavailable",
      reason: "QualificationEvidenceMismatch",
    });
    expect(
      resolveSandboxProvider(selection, [
        { ...supportedCapability, enforcementRuleSetDigest: "c".repeat(64) },
      ]),
    ).toMatchObject({
      _tag: "Unavailable",
      reason: "EnforcementRuleSetDigestMismatch",
    });
    expect(
      resolveSandboxProvider(
        { ...selection, expectedQualificationEvidenceRef: null },
        [supportedCapability],
      ),
    ).toMatchObject({
      _tag: "Unavailable",
      reason: "QualificationEvidenceMismatch",
    });
  });

  it("decodes only canonical versioned network policy and exact destination fields", () => {
    const policy: NetworkPolicyV1 = {
      version: 1,
      mode: "Restricted",
      destinations: ["https://api.example.test", "https://cdn.example.test"],
    };
    const encoded = encodeNetworkPolicyV1(policy);
    expect(decodeCanonicalNetworkPolicyV1(encoded)).toEqual(policy);
    expect(
      decodeNetworkPolicyV1({ ...policy, untrusted: true }),
    ).toBeUndefined();
    expect(
      decodeNetworkPolicyV1({ version: 1, mode: "Disabled", destinations: [] }),
    ).toMatchObject({ mode: "Disabled", destinations: [] });
    expect(
      decodeCanonicalNetworkPolicyV1(
        encoded.replace('{"version":1', '{"version": 1'),
      ),
    ).toBeUndefined();
    expect(
      decodeCanonicalNetworkPolicyV1(
        '{"version":1,"mode":"Restricted","destinations":["https://example.test:443"]}',
      ),
    ).toBeUndefined();
    expect(
      decodeNetworkPolicyV1({
        version: 1,
        mode: "Restricted",
        destinations: ["https://192.0.2.10"],
      }),
    ).toBeUndefined();
    expect(
      decodeNetworkPolicyV1({
        version: 1,
        mode: "Restricted",
        destinations: ["https://example.test/path"],
      }),
    ).toBeUndefined();
    expect(
      decodeNetworkPolicyV1({
        version: 1,
        mode: "Restricted",
        destinations: [],
      }),
    ).toBeUndefined();
  });

  it("decodes the exact persisted OsEnforced and TrustedLocal policy union", () => {
    const osEnforced = {
      kind: "OsEnforced" as const,
      policy: {
        version: 1 as const,
        mode: "Restricted" as const,
        destinations: ["https://api.example.test"],
      },
    };
    const trustedLocal = {
      kind: "TrustedLocalUnconfinedV1" as const,
      version: 1 as const,
    };
    expect(
      decodeCanonicalSandboxNetworkPolicySelectionV1(
        encodeSandboxNetworkPolicySelectionV1(osEnforced),
      ),
    ).toEqual(osEnforced);
    expect(
      decodeCanonicalSandboxNetworkPolicySelectionV1(
        encodeSandboxNetworkPolicySelectionV1(trustedLocal),
      ),
    ).toEqual(trustedLocal);
    expect(
      decodeSandboxNetworkPolicySelectionV1({
        ...trustedLocal,
        providerId: "fallback",
      }),
    ).toBeUndefined();
  });

  it("strictly decodes non-empty exact ExecutionEpisodeBinding values", () => {
    const episode = {
      _tag: "InboxEpisode" as const,
      entryKey: "entry-1",
      inputKind: "HumanMessage",
    };
    const encoded = encodeExecutionEpisodeBinding(episode);
    expect(decodeCanonicalExecutionEpisodeBinding(encoded)).toEqual(episode);
    expect(
      decodeExecutionEpisodeBinding({ ...episode, unexpected: true }),
    ).toBeUndefined();
    expect(
      decodeExecutionEpisodeBinding({ ...episode, entryKey: "  " }),
    ).toBeUndefined();
    expect(
      decodeExecutionEpisodeBinding({
        _tag: "WorkEpisode",
        workId: "wrk_invalid",
        targetWorkRevision: 1,
      }),
    ).toBeUndefined();
    expect(
      decodeExecutionEpisodeBinding({
        _tag: "DecisionEpisode",
        decisionId: "dec_018f2b3c-4d5e-7abc-8def-0123456789a1",
        decisionKind: "SelectCurrentWork",
        requestRevision: -1,
      }),
    ).toBeUndefined();
    expect(
      decodeCanonicalExecutionEpisodeBinding(
        encoded.replace('"entryKey":"entry-1"', '"entryKey": "entry-1"'),
      ),
    ).toBeUndefined();
  });
});

describe("SandboxPolicyGrantIssuerConfigV1", () => {
  it("decodes a closed, sorted config and encodes its JCS bytes", () => {
    const config = decodeSandboxPolicyGrantIssuerConfigV1({
      version: 1,
      revision: 3,
      issuers: ["user:admin-a", "user:admin-b"],
    });
    expect(config).toEqual({
      version: 1,
      revision: 3,
      issuers: ["user:admin-a", "user:admin-b"],
    });
    const canonical =
      '{"version":1,"revision":3,"issuers":["user:admin-a","user:admin-b"]}';
    expect(config && encodeSandboxPolicyGrantIssuerConfigV1(config)).toBe(
      canonical,
    );
    expect(decodeCanonicalSandboxPolicyGrantIssuerConfigV1(canonical)).toEqual(
      config,
    );
  });

  it.each([
    { version: 1, revision: 0, issuers: ["user:a"] },
    { version: 1, revision: 1.5, issuers: ["user:a"] },
    { version: 1, revision: 1, issuers: ["user:b", "user:a"] },
    { version: 1, revision: 1, issuers: ["user:a", "user:a"] },
    { version: 1, revision: 1, issuers: ["runtime:system"] },
    { version: 1, revision: 1, issuers: ["user:a"], unexpected: true },
  ])("rejects invalid config %#", (input) => {
    expect(decodeSandboxPolicyGrantIssuerConfigV1(input)).toBeUndefined();
  });

  it("rejects non-canonical JSON bytes even when their values decode", () => {
    expect(
      decodeCanonicalSandboxPolicyGrantIssuerConfigV1(
        '{"issuers":["user:admin-a"],"version":1,"revision":3}',
      ),
    ).toBeUndefined();
  });
});
