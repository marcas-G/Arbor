import type { WorkspaceDetailRes } from "@arbor/api-contracts";
import { describe, expect, it } from "vitest";
import { decideSandboxPolicyPayloadFromCandidate } from "../src/commands/sandbox-policy-selection.js";

const trustedId =
  "spc2_5ed13734a81314c653c0487eea6a454283c800b71f9c0a2bed72f4a6d49cc98d";
const osId = `spc2_${"1".repeat(64)}`;
type CandidateRead = NonNullable<
  WorkspaceDetailRes["sandboxPolicyCandidateRead"]
>;
const baseRead = {
  reason: "InitialDecision",
  commonPreconditions: {
    expectedEpisodeRevision: 4,
    latestCommittedPolicyRevision: 0,
    episodeBinding: {
      _tag: "WorkEpisode",
      workId: "wrk_v6_ui",
      targetWorkRevision: 3,
    },
    workspaceRevision: 9,
    resourceBoundaryRevision: 2,
    authorityBundleRevision: 6,
    authorityBundleDigest: "a".repeat(64),
    operatorConfigRevision: 3,
    operatorConfigDigest: "b".repeat(64),
  },
  candidates: [
    {
      kind: "OsEnforced",
      candidateId: osId,
      sandboxHandleBindingDigest: "c".repeat(64),
      providerId: "linux-bwrap",
      providerVersion: "bwrap-v2",
      capabilityRevision: 7,
      profile: "WorkspaceWrite",
      networkMode: "Restricted",
      providerRegistryRevision: 6,
      providerRegistryDigest: "d".repeat(64),
    },
    {
      kind: "TrustedLocalUnconfinedV1",
      candidateId: trustedId,
      sandboxHandleBindingDigest: "e".repeat(64),
    },
  ],
} as unknown as CandidateRead;

const commandContext = {
  projectId: "prj_v6_ui",
  workspaceId: "ws_v6_ui",
  executionId: "exe_v6_ui",
  decisionExpiresAt: "2099-01-01T00:00:00.000Z",
  networkDestinations: ["https://b.example", "https://a.example"],
};

describe("V6 selected sandbox candidate → existing P1 command mapping", () => {
  it("copies only the selected OS candidate digest and registry tuple", () => {
    const mapped = decideSandboxPolicyPayloadFromCandidate({
      ...commandContext,
      read: baseRead,
      candidateId: osId,
      trustedLocalConfirmed: false,
    });
    expect(mapped._tag).toBe("Ready");
    if (mapped._tag !== "Ready") return;
    expect(mapped.payload).toMatchObject({
      expectedEpisodeRevision: 4,
      expectedPolicyRevision: 0,
      expectedWorkspaceRevision: 9,
      expectedResourceBoundaryRevision: 2,
      expectedSandboxHandleBindingDigest: "c".repeat(64),
      expectedAuthorityBundleRevision: 6,
      expectedAuthorityBundleDigest: "a".repeat(64),
      expectedOperatorConfigRevision: 3,
      expectedOperatorConfigDigest: "b".repeat(64),
      expectedProviderRegistryRevision: 6,
      expectedProviderRegistryDigest: "d".repeat(64),
      profile: "WorkspaceWrite",
      providerId: "linux-bwrap",
      providerVersion: "bwrap-v2",
      capabilityRevision: 7,
      networkPolicy: {
        kind: "OsEnforced",
        policy: {
          version: 1,
          mode: "Restricted",
          destinations: ["https://a.example", "https://b.example"],
        },
      },
    });
    expect(Object.hasOwn(mapped.payload, "candidateId")).toBe(false);
  });

  it("requires explicit TrustedLocal confirmation and omits OS registry fields", () => {
    const notConfirmed = decideSandboxPolicyPayloadFromCandidate({
      ...commandContext,
      read: baseRead,
      candidateId: trustedId,
      networkDestinations: [],
      trustedLocalConfirmed: false,
    });
    expect(notConfirmed).toEqual({
      _tag: "Invalid",
      reason: "TrustedLocalNeedsExplicitConfirmation",
    });
    const mapped = decideSandboxPolicyPayloadFromCandidate({
      ...commandContext,
      read: baseRead,
      candidateId: trustedId,
      networkDestinations: [],
      trustedLocalConfirmed: true,
    });
    expect(mapped._tag).toBe("Ready");
    if (mapped._tag !== "Ready") return;
    expect(mapped.payload).toMatchObject({
      expectedSandboxHandleBindingDigest: "e".repeat(64),
      profile: "FullAccess",
      providerId: "TrustedLocal",
      networkPolicy: { kind: "TrustedLocalUnconfinedV1", version: 1 },
    });
    expect(
      Object.hasOwn(mapped.payload, "expectedProviderRegistryRevision"),
    ).toBe(false);
    expect(
      Object.hasOwn(mapped.payload, "expectedProviderRegistryDigest"),
    ).toBe(false);
    expect(Object.hasOwn(mapped.payload, "candidateId")).toBe(false);
  });

  it("requires a deliberate choice from the refreshed read even when the ID is stable", () => {
    const refreshedRead = {
      ...baseRead,
      reason: "RefreshStaleCommittedPolicy",
      candidates: baseRead.candidates.map((candidate) =>
        candidate.candidateId === osId
          ? { ...candidate, sandboxHandleBindingDigest: "f".repeat(64) }
          : candidate,
      ),
    } as CandidateRead;
    const mapped = decideSandboxPolicyPayloadFromCandidate({
      ...commandContext,
      read: refreshedRead,
      candidateId: osId,
      trustedLocalConfirmed: false,
      networkDestinations: ["https://a.example"],
    });
    expect(mapped._tag).toBe("Ready");
    if (mapped._tag !== "Ready") return;
    expect(mapped.payload.expectedSandboxHandleBindingDigest).toBe(
      "f".repeat(64),
    );
    expect(Object.hasOwn(mapped.payload, "candidateId")).toBe(false);
  });

  it("maps the explicitly selected capability revision when otherwise-identical candidates coexist", () => {
    const secondId = `spc2_${"2".repeat(64)}`;
    const competingRead = {
      ...baseRead,
      candidates: baseRead.candidates.map((candidate) =>
        candidate.kind === "OsEnforced"
          ? { ...candidate, capabilityRevision: 8, candidateId: secondId }
          : candidate,
      ),
    } as CandidateRead;
    const mapped = decideSandboxPolicyPayloadFromCandidate({
      ...commandContext,
      read: competingRead,
      candidateId: secondId,
      trustedLocalConfirmed: false,
    });
    expect(mapped._tag).toBe("Ready");
    if (mapped._tag !== "Ready") return;
    expect(mapped.payload).toMatchObject({
      providerId: "linux-bwrap",
      providerVersion: "bwrap-v2",
      capabilityRevision: 8,
    });
    expect(mapped.payload).not.toHaveProperty("candidateId");
  });
});
