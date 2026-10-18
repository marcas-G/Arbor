import { describe, expect, it } from "vitest";
import {
  decodeSandboxProviderId,
  resolveSandboxProvider,
  type SandboxProviderCapability,
} from "../src/sandbox-policy.js";

const capabilities: ReadonlyArray<SandboxProviderCapability> = [
  {
    providerId: "bwrap",
    providerVersion: "0.8.0",
    status: "Experimental",
    boundary: "OsEnforced",
    profiles: ["WorkspaceWrite"],
    networkModes: ["Disabled"],
  },
  {
    providerId: "TrustedLocal",
    providerVersion: "builtin-v1",
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
          profile: "WorkspaceWrite",
          networkMode: "Disabled",
          boundary: "OsEnforced",
        },
        capabilities,
      ),
    ).toEqual({ _tag: "Unavailable", reason: "ProviderNotSupported" });
  });

  it("requires explicit TrustedLocal policy selection and reports its weaker boundary", () => {
    expect(
      resolveSandboxProvider(
        {
          providerId: "TrustedLocal",
          profile: "WorkspaceWrite",
          networkMode: "Disabled",
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
          profile: "WorkspaceWrite",
          networkMode: "Disabled",
          boundary: "OsEnforced",
        },
        capabilities,
      ),
    ).toEqual({ _tag: "Unavailable", reason: "ProviderNotFound" });
  });
});
