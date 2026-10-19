import { describe, expect, it } from "vitest";
import {
  decodeCanonicalExecutionEpisodeBinding,
  decodeCanonicalNetworkPolicyV1,
  decodeCanonicalSandboxPolicyGrantIssuerConfigV1,
  decodeExecutionEpisodeBinding,
  decodeNetworkPolicyV1,
  decodeSandboxPolicyGrantIssuerConfigV1,
  decodeSandboxProviderId,
  encodeExecutionEpisodeBinding,
  encodeNetworkPolicyV1,
  encodeSandboxPolicyGrantIssuerConfigV1,
  type NetworkPolicyV1,
  resolveSandboxProvider,
  type SandboxProviderCapability,
} from "../src/sandbox-policy.js";

const capabilities: ReadonlyArray<SandboxProviderCapability> = [
  {
    providerId: "bwrap",
    providerVersion: "0.8.0",
    capabilityRevision: "caps-v3",
    probeEvidenceRef: "evidence:bwrap-0.8.0",
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

  it("decodes only canonical versioned network policy and exact destination fields", () => {
    const policy: NetworkPolicyV1 = {
      version: 1,
      mode: "Restricted",
      destinations: [
        {
          _tag: "Hostname",
          hostname: "api.example.test",
          protocol: "https",
          port: 443,
        },
        {
          _tag: "IpLiteral",
          address: "192.0.2.10",
          protocol: "tcp",
          port: 8443,
        },
      ],
    };
    const encoded = encodeNetworkPolicyV1(policy);
    expect(decodeCanonicalNetworkPolicyV1(encoded)).toEqual(policy);
    expect(
      decodeNetworkPolicyV1({ ...policy, untrusted: true }),
    ).toBeUndefined();
    expect(
      decodeNetworkPolicyV1({
        version: 1,
        mode: "Disabled",
        destinations: policy.destinations,
      }),
    ).toBeUndefined();
    expect(
      decodeCanonicalNetworkPolicyV1(
        encoded.replace('{"version":1', '{"version": 1'),
      ),
    ).toBeUndefined();
    expect(
      decodeCanonicalNetworkPolicyV1(
        encoded.replace('"port":443', '"port":443,"extra":true'),
      ),
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
      operators: ["user:admin-a", "user:admin-b"],
    });
    expect(config).toEqual({
      version: 1,
      revision: 3,
      operators: ["user:admin-a", "user:admin-b"],
    });
    const canonical =
      '{"operators":["user:admin-a","user:admin-b"],"revision":3,"version":1}';
    expect(config && encodeSandboxPolicyGrantIssuerConfigV1(config)).toBe(
      canonical,
    );
    expect(decodeCanonicalSandboxPolicyGrantIssuerConfigV1(canonical)).toEqual(
      config,
    );
  });

  it.each([
    { version: 1, revision: 0, operators: [] },
    { version: 1, revision: 1.5, operators: [] },
    { version: 1, revision: 1, operators: ["user:b", "user:a"] },
    { version: 1, revision: 1, operators: ["user:a", "user:a"] },
    { version: 1, revision: 1, operators: ["runtime:system"] },
    { version: 1, revision: 1, operators: [], unexpected: true },
  ])("rejects invalid config %#", (input) => {
    expect(decodeSandboxPolicyGrantIssuerConfigV1(input)).toBeUndefined();
  });

  it("rejects non-canonical JSON bytes even when their values decode", () => {
    expect(
      decodeCanonicalSandboxPolicyGrantIssuerConfigV1(
        '{"version":1,"revision":3,"operators":["user:admin-a"]}',
      ),
    ).toBeUndefined();
  });
});
