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
const linuxRuleSetJson =
  '{"version":1,"networkPolicyCodecVersion":1,"filesystemRuleVersion":1,"environmentRuleVersion":1,"processTreeRuleVersion":1,"resourceLimitRuleVersion":1,"brokerProtocolVersion":1,"addressClassificationSnapshotId":"iana-special-purpose-2025-10-09+sha256:86583d4bbc916863208c3fbb5a75ee3e6500dd12aa4f9bd3a72caaacb4a3da6a","pref64PolicyVersion":1,"redirectPolicyVersion":1,"platformPrimitiveSetId":"linux-bwrap-user-mount-pid-netns-cgroupv2-seccomp-v1"}';
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
  providerId: "linux-bwrap",
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
    enforcementRuleSetDigest: sha256Hex(linuxRuleSetJson),
  },
  status,
  qualificationEvidenceRef: summary.qualificationEvidenceRef,
});

describe("current OS sandbox provider materialization gate", () => {
  it("keeps the Windows D2 identity-only tuple unavailable for P4 materialization", () => {
    const windowsSummary = {
      ...summary,
      providerId: "windows-restricted-appcontainer-job",
      osFamily: "Windows" as const,
      osBuild: "10.0.19045",
      qualificationEvidenceRef: `blob:sha256:${"c".repeat(64)}`,
    };
    const windowsRow: SandboxProviderQualificationEntryV1 = {
      ...entry("Experimental"),
      providerId: windowsSummary.providerId,
      osFamily: "Windows",
      osBuild: windowsSummary.osBuild,
      qualificationEvidenceRef: windowsSummary.qualificationEvidenceRef,
    };
    expect(
      exactSupportedOsProviderEntry([windowsRow], windowsSummary),
    ).toBeUndefined();
    expect(
      exactSupportedOsProviderEntry(
        [{ ...windowsRow, status: "Unavailable" }],
        windowsSummary,
      ),
    ).toBeUndefined();
  });

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
    const fullRuleSetEntry = {
      ...supported,
      tuple: {
        ...supported.tuple,
        enforcementRuleSetDigest: sha256Hex(linuxRuleSetJson),
      },
    };
    expect(exactSupportedOsProviderEntry([fullRuleSetEntry], summary)).toEqual(
      fullRuleSetEntry,
    );
    const wrongControlsOnlyDigest = {
      ...supported,
      tuple: {
        ...supported.tuple,
        enforcementRuleSetDigest: sha256Hex(
          encodeNetworkBrokerControlsV1(summary.networkBrokerControls),
        ),
      },
    };
    expect(
      exactSupportedOsProviderEntry([wrongControlsOnlyDigest], summary),
    ).toBeUndefined();
    const brokerControlsOnly = {
      ...wrongControlsOnlyDigest,
    };
    expect(
      exactSupportedOsProviderEntry([brokerControlsOnly], summary),
    ).toBeUndefined();
    expect(
      exactSupportedOsProviderEntry(
        [fullRuleSetEntry, fullRuleSetEntry],
        summary,
      ),
    ).toBeUndefined();
    expect(
      exactSupportedOsProviderEntry(
        [{ ...fullRuleSetEntry, providerVersion: "different-version" }],
        summary,
      ),
    ).toBeUndefined();
  });
});
