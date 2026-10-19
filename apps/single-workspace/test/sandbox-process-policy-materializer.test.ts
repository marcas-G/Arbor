import { createHash } from "node:crypto";
import {
  encodeNetworkBrokerControlsV1,
  networkBrokerControlsV1ForMode,
  type OsEnforcedPolicySummaryV1,
  type SandboxProviderQualificationEntryV1,
} from "@arbor/domain";
import { describe, expect, it } from "vitest";
import { exactSupportedOsProviderEntry } from "../src/sandbox-process-policy-materializer.js";

const sha256Hex = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const controls = networkBrokerControlsV1ForMode("Disabled");
const summary: Pick<
  OsEnforcedPolicySummaryV1,
  | "providerId"
  | "providerVersion"
  | "capabilityRevision"
  | "osFamily"
  | "osBuild"
  | "qualificationEvidenceRef"
  | "profile"
  | "networkPolicy"
  | "networkBrokerControls"
> = {
  providerId: "native-test-provider",
  providerVersion: "1.2.3",
  capabilityRevision: 7,
  osFamily: "Linux",
  osBuild: "linux-test-build",
  qualificationEvidenceRef: "blob:sha256:abc",
  profile: "ReadOnly",
  networkPolicy: { version: 1, mode: "Disabled", destinations: [] },
  networkBrokerControls: controls,
};

const entry = (
  status: SandboxProviderQualificationEntryV1["status"],
): SandboxProviderQualificationEntryV1 => ({
  providerId: summary.providerId,
  providerVersion: summary.providerVersion,
  capabilityRevision: summary.capabilityRevision,
  osFamily: summary.osFamily,
  osBuild: summary.osBuild,
  tuple: {
    profile: summary.profile,
    networkMode: summary.networkPolicy.mode,
    networkPolicyCodecVersion: 1,
    enforcementRuleSetDigest: sha256Hex(
      encodeNetworkBrokerControlsV1(summary.networkBrokerControls),
    ),
  },
  status,
  qualificationEvidenceRef: summary.qualificationEvidenceRef,
});

describe("current OS sandbox provider materialization gate", () => {
  it.each(["Experimental", "Unavailable"] as const)(
    "fails closed for an exact but %s registry entry",
    (status) => {
      expect(exactSupportedOsProviderEntry([entry(status)], summary)).toBe(
        undefined,
      );
    },
  );

  it("returns only the exact Supported tuple", () => {
    const supported = entry("Supported");
    expect(exactSupportedOsProviderEntry([supported], summary)).toBe(supported);
    expect(
      exactSupportedOsProviderEntry(
        [{ ...supported, providerVersion: "different-version" }],
        summary,
      ),
    ).toBeUndefined();
  });
});
