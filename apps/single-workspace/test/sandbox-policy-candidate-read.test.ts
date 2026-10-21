import { createHash } from "node:crypto";
import type {
  Execution,
  SandboxAuthorityBundleSnapshotCurrent,
  SandboxPolicyCurrentHostV1,
  SandboxProviderQualificationEntryV1,
  Workspace,
} from "@arbor/domain";
import {
  encodeNetworkBrokerControlsV1,
  encodeSandboxEnforcementRuleSetV1,
  networkBrokerControlsV1ForMode,
  ProviderTurnId,
  parse,
  ResourceBoundaryRevision,
  Sha256,
  sandboxEnforcementRuleSetV1ForProvider,
  ToolInvocationId,
} from "@arbor/domain";
import type {
  SandboxPolicyCandidateBoundarySnapshotV1,
  SandboxPolicyPreIntentRequirementV1,
  SandboxPolicyRequirementV1,
} from "@arbor/ports";
import { describe, expect, it } from "vitest";
import { buildSandboxPolicyCandidateReadV2 } from "../src/sandbox-policy-candidate-read.js";

const projectId = "prj_v6_candidate" as never;
const workspaceId = "ws_v16_fixture" as never;
const executionId = "exe_v6_candidate" as never;
const workId = "wrk_v6_candidate" as never;
const resourceBoundaryRevision = parse(ResourceBoundaryRevision)(2);
const brokerOnlyDigest = createHash("sha256")
  .update(
    encodeNetworkBrokerControlsV1(networkBrokerControlsV1ForMode("Disabled")),
    "utf8",
  )
  .digest("hex");
const fullRuleSet = sandboxEnforcementRuleSetV1ForProvider("linux-bwrap");
if (fullRuleSet === undefined) throw new Error("linux-bwrap rule set missing");
const enforcementRuleSetDigest = createHash("sha256")
  .update(encodeSandboxEnforcementRuleSetV1(fullRuleSet), "utf8")
  .digest("hex");
const episodeBinding = {
  _tag: "WorkEpisode" as const,
  workId,
  targetWorkRevision: 0 as never,
};
const address = {
  _tag: "GitWorktree" as const,
  path: "C:\\v16-fixture\\workspace",
};
const primary = {
  resourceSpaceId: "filesystem",
  normalizedRegion: {
    kind: "GitWorktree",
    path: "C:\\v16-fixture\\workspace",
  },
};
const workspace = {
  projectId,
  workspaceId,
  lifecycle: "Active",
  responsibilityRevision: 2,
  resourceBoundary: {
    basisResponsibilityRevision: 2,
    addresses: [address],
  },
  resourceBoundaryRevision: 2,
  revision: 9,
} as unknown as Workspace;
const execution = {
  executionId,
  projectId,
  workspaceId,
  binding: { _tag: "WorkspaceExecution", workspaceId, episode: episodeBinding },
} as unknown as Execution;
const requirement = {
  _tag: "SandboxPolicyRequirementV1",
  projectId,
  workspaceId,
  executionId,
  episodeBinding,
  expectedEpisodeRevision: 0,
  invocationId: parse(ToolInvocationId)(
    "tin_018f2b3c-4d5e-7abc-8def-0123456789c1",
  ),
  providerTurnId: parse(ProviderTurnId)(
    "ptn_018f2b3c-4d5e-7abc-8def-0123456789c1",
  ),
  logicalStepNo: 1,
  repairAttempt: 0,
  logicalActionId: "act_v6_candidate",
  actionIndex: 0,
  callRef: "call_v6_candidate",
  recoveryBindingDigest: parse(Sha256)("a".repeat(64)),
} satisfies SandboxPolicyRequirementV1;
const providerEntry = {
  providerId: "linux-bwrap",
  providerVersion: "1.2.0",
  capabilityRevision: 1,
  osFamily: "Linux",
  osBuild: "qualified-build",
  tuple: {
    profile: "ReadOnly",
    networkMode: "Disabled",
    networkPolicyCodecVersion: 1,
    enforcementRuleSetDigest,
  },
  status: "Supported",
  qualificationEvidenceRef: `blob:sha256:${"c".repeat(64)}`,
} satisfies SandboxProviderQualificationEntryV1;
const providerEntryWorkspaceWrite = {
  ...providerEntry,
  tuple: { ...providerEntry.tuple, profile: "WorkspaceWrite" },
} satisfies SandboxProviderQualificationEntryV1;
const authority = {
  bundle: {
    version: 2,
    sourceIdentity: "v6-test",
    bundleRevision: 3,
    issuerConfigRevision: 1,
    issuerConfigDigest: "d".repeat(64),
    issuerConfig: { version: 1, revision: 1, issuers: [] },
    operatorConfigRevision: 1,
    operatorConfigDigest: "e".repeat(64),
    operatorConfig: {
      version: 1,
      revision: 1,
      environmentAllowlist: [],
      limitsByProfile: [],
      trustedLocalRuntimeVersion: "builtin-v1",
    },
    providerRegistryRevision: 2,
    providerRegistryDigest: "f".repeat(64),
    providerRegistry: {
      version: 1,
      revision: 2,
      entries: [providerEntry, providerEntryWorkspaceWrite],
    },
  },
  bundleDigest: "1".repeat(64),
  canonicalJson: "{}",
} as SandboxAuthorityBundleSnapshotCurrent;
const read = (
  claims: SandboxPolicyCandidateBoundarySnapshotV1["ownershipClaims"],
  currentHost: SandboxPolicyCurrentHostV1 = {
    osFamily: "Linux",
    osBuild: "qualified-build",
  },
  authoritySnapshot = authority,
  sourceRequirement:
    | SandboxPolicyRequirementV1
    | SandboxPolicyPreIntentRequirementV1 = requirement,
) =>
  buildSandboxPolicyCandidateReadV2({
    reason: "InitialDecision",
    execution,
    requirement: sourceRequirement,
    latestCommittedPolicyRevision: 0,
    expectedEpisodeRevision: 0,
    boundary: {
      workspace,
      ownershipClaims: claims,
      worktrees: [
        {
          worktreeId: "wt_v6",
          projectId,
          workspaceId,
          address,
          state: "Active",
          createdAt: "t",
        },
      ],
      resolvedRegions: [primary],
      primaryManagedGitWorktreeRegion: primary,
    },
    authority: authoritySnapshot,
    currentHost,
  });

describe("V6 per-candidate P4 binding digest projection", () => {
  it("builds the unchanged public candidate DTO from a pre-intent approval proof", () => {
    const preIntent = {
      _tag: "SandboxPolicyPreIntentRequirementV1",
      version: 1,
      projectId,
      workspaceId,
      executionId,
      episodeBinding,
      expectedEpisodeRevision: 0,
      providerTurnId: requirement.providerTurnId,
      logicalStepNo: 1,
      repairAttempt: 0,
      logicalActionId: requirement.logicalActionId,
      actionIndex: 0,
      callRef: requirement.callRef,
      actionRevision: 4,
      inputHash: parse(Sha256)("b".repeat(64)),
      toolName: "shell",
      toolVersion: "shell-v1",
      approvalId: "approval-v6",
      approvalState: "Pending",
      approvalRevision: 0,
      approvalConsumedBy: null,
      approvalExpiresAt: "2026-10-21T12:00:00.000Z",
    } satisfies SandboxPolicyPreIntentRequirementV1;
    const result = read([], undefined, authority, preIntent);
    expect(result._tag).toBe("Ready");
    if (result._tag !== "Ready") return;
    expect(result.value.reason).toBe("InitialDecision");
    expect(result.value.candidates).toHaveLength(3);
    expect(JSON.stringify(result.value)).not.toContain("approval-v6");
    expect(JSON.stringify(result.value)).not.toContain("action-v6");
  });

  it("emits distinct candidates for Supported rows differing only by capabilityRevision", () => {
    const secondCapability = {
      ...providerEntry,
      capabilityRevision: 2,
    } satisfies SandboxProviderQualificationEntryV1;
    const authorityWithCapabilityVariants = {
      ...authority,
      bundle: {
        ...authority.bundle,
        providerRegistry: {
          ...authority.bundle.providerRegistry,
          entries: [
            providerEntry,
            providerEntryWorkspaceWrite,
            secondCapability,
          ],
        },
      },
    } as SandboxAuthorityBundleSnapshotCurrent;
    const result = read([], undefined, authorityWithCapabilityVariants);
    expect(result._tag).toBe("Ready");
    if (result._tag !== "Ready") return;
    const readOnlyCandidates = result.value.candidates.filter(
      (
        candidate,
      ): candidate is Extract<
        (typeof result.value.candidates)[number],
        { readonly kind: "OsEnforced" }
      > => candidate.kind === "OsEnforced" && candidate.profile === "ReadOnly",
    );
    expect(
      readOnlyCandidates.map((candidate) => candidate.capabilityRevision),
    ).toEqual([1, 2]);
    expect(
      new Set(readOnlyCandidates.map((candidate) => candidate.candidateId))
        .size,
    ).toBe(2);
  });

  it("projects P10 common preconditions from complete current V3 bundle", () => {
    const v3 = {
      ...authority,
      bundle: {
        ...authority.bundle,
        version: 3 as const,
        bundleRevision: 4,
        windowsOperatorTrustSetRevision: 1,
        windowsOperatorTrustSetDigest: "a".repeat(64),
        windowsOperatorTrustSet: {
          version: 1 as const,
          revision: 1,
          sourceIdentity: "v6-test",
          providerId: "windows-restricted-appcontainer-job" as const,
          keys: [
            {
              keyId: "operator-2026-a",
              algorithm: "Ed25519" as const,
              publicKeySpkiDerBase64:
                "MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=",
              publicKeySpkiSha256:
                "06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9",
              validFrom: "2026-10-20T00:00:00.000Z",
              validUntil: "2027-10-20T00:00:00.000Z",
              status: "Active" as const,
            },
          ],
          revokedKeyIds: [],
        },
      },
      bundleDigest: "b".repeat(64),
    } as SandboxAuthorityBundleSnapshotCurrent;
    const result = read(
      [],
      { osFamily: "Linux", osBuild: "qualified-build" },
      v3,
    );
    expect(result._tag).toBe("Ready");
    if (result._tag !== "Ready") return;
    expect(result.value.commonPreconditions).toMatchObject({
      authorityBundleRevision: 4,
      authorityBundleDigest: "b".repeat(64),
    });
  });

  it("derives independent RO, owned RW and TrustedLocal digests from one pinned P11 snapshot", () => {
    const claims = [
      {
        claimId: "claim_v6",
        workspaceId,
        region: primary,
        sourceAddressSnapshot: address,
        resourceBoundaryRevision,
        resolvedAtEnvironmentRevision: "env-1",
        createdAt: "t1",
        releasedAt: null,
      },
    ];
    const result = read(claims);
    expect(result._tag).toBe("Ready");
    if (result._tag !== "Ready") return;
    const candidates = result.value.candidates;
    const readOnly = candidates.find(
      (candidate) =>
        candidate.kind === "OsEnforced" && candidate.profile === "ReadOnly",
    );
    const workspaceWrite = candidates.find(
      (candidate) =>
        candidate.kind === "OsEnforced" &&
        candidate.profile === "WorkspaceWrite",
    );
    const trusted = candidates.find(
      (candidate) => candidate.kind === "TrustedLocalUnconfinedV1",
    );
    expect(readOnly?.sandboxHandleBindingDigest).toBe(
      "2d31d16dc458eb32ba2d012693f7770b31ce8144068058dfe1cfe4bea153dea4",
    );
    expect(workspaceWrite?.sandboxHandleBindingDigest).toBe(
      "7245d9c71712791e04c2f9eb701c9ec40771626bb73b06b3d0a0185619fb736a",
    );
    expect(trusted?.sandboxHandleBindingDigest).toBe(
      workspaceWrite?.sandboxHandleBindingDigest,
    );
    expect(readOnly?.candidateId).not.toBe(workspaceWrite?.candidateId);
  });

  it("lets ReadOnly and WorkspaceWrite coincide without a claim while FullAccess stays distinct", () => {
    const result = read([]);
    expect(result._tag).toBe("Ready");
    if (result._tag !== "Ready") return;
    const candidates = result.value.candidates;
    const readOnly = candidates.find(
      (candidate) =>
        candidate.kind === "OsEnforced" && candidate.profile === "ReadOnly",
    );
    const workspaceWrite = candidates.find(
      (candidate) =>
        candidate.kind === "OsEnforced" &&
        candidate.profile === "WorkspaceWrite",
    );
    const trusted = candidates.find(
      (candidate) => candidate.kind === "TrustedLocalUnconfinedV1",
    );
    expect(readOnly?.sandboxHandleBindingDigest).toBe(
      workspaceWrite?.sandboxHandleBindingDigest,
    );
    expect(trusted?.sandboxHandleBindingDigest).not.toBe(
      readOnly?.sandboxHandleBindingDigest,
    );
    expect(trusted?.candidateId).toBe(
      "spc2_5ed13734a81314c653c0487eea6a454283c800b71f9c0a2bed72f4a6d49cc98d",
    );
  });

  it("keeps presentation identity stable while an ownership/access change changes only its digest", () => {
    const owned = read([
      {
        claimId: "claim_v6",
        workspaceId,
        region: primary,
        sourceAddressSnapshot: address,
        resourceBoundaryRevision,
        resolvedAtEnvironmentRevision: "env-1",
        createdAt: "t1",
        releasedAt: null,
      },
    ]);
    const unowned = read([]);
    expect(owned._tag).toBe("Ready");
    expect(unowned._tag).toBe("Ready");
    if (owned._tag !== "Ready" || unowned._tag !== "Ready") return;
    const ownedWrite = owned.value.candidates.find(
      (candidate) =>
        candidate.kind === "OsEnforced" &&
        candidate.profile === "WorkspaceWrite",
    );
    const unownedWrite = unowned.value.candidates.find(
      (candidate) =>
        candidate.kind === "OsEnforced" &&
        candidate.profile === "WorkspaceWrite",
    );
    expect(ownedWrite?.candidateId).toBe(unownedWrite?.candidateId);
    expect(ownedWrite?.sandboxHandleBindingDigest).not.toBe(
      unownedWrite?.sandboxHandleBindingDigest,
    );
  });

  it("fails the whole candidate read when any profile cannot be produced", () => {
    const result = read([
      {
        claimId: "claim-outside-boundary",
        workspaceId,
        region: {
          resourceSpaceId: "filesystem",
          normalizedRegion: { kind: "FileTree", path: "/outside" },
        },
        sourceAddressSnapshot: { _tag: "FileTree", path: "/outside" },
        resourceBoundaryRevision,
        resolvedAtEnvironmentRevision: "env-1",
        createdAt: "t1",
        releasedAt: null,
      },
    ]);
    expect(result).toEqual({ _tag: "SandboxBoundaryProductionRejected" });
  });

  it("filters wrong-host and Unsupported tuples using trusted P5 host facts without probing providers", () => {
    const wrongHost = read([], {
      osFamily: "Windows",
      osBuild: "qualified-build",
    });
    expect(wrongHost._tag).toBe("Ready");
    if (wrongHost._tag === "Ready")
      expect(
        wrongHost.value.candidates.map((candidate) => candidate.kind),
      ).toEqual(["TrustedLocalUnconfinedV1"]);

    const unsupportedAuthority = {
      ...authority,
      bundle: {
        ...authority.bundle,
        providerRegistry: {
          ...authority.bundle.providerRegistry,
          entries: [
            { ...providerEntry, status: "Experimental" as const },
            { ...providerEntryWorkspaceWrite, status: "Unavailable" as const },
          ],
        },
      },
    } as SandboxAuthorityBundleSnapshotCurrent;
    const unsupported = read([], undefined, unsupportedAuthority);
    expect(unsupported._tag).toBe("Ready");
    if (unsupported._tag === "Ready")
      expect(
        unsupported.value.candidates.map((candidate) => candidate.kind),
      ).toEqual(["TrustedLocalUnconfinedV1"]);

    const brokerOnlyAuthority = {
      ...authority,
      bundle: {
        ...authority.bundle,
        providerRegistry: {
          ...authority.bundle.providerRegistry,
          entries: [
            {
              ...providerEntry,
              tuple: {
                ...providerEntry.tuple,
                enforcementRuleSetDigest: brokerOnlyDigest,
              },
            },
          ],
        },
      },
    } as SandboxAuthorityBundleSnapshotCurrent;
    const brokerOnly = read([], undefined, brokerOnlyAuthority);
    expect(brokerOnly._tag).toBe("Ready");
    if (brokerOnly._tag === "Ready")
      expect(
        brokerOnly.value.candidates.map((candidate) => candidate.kind),
      ).toEqual(["TrustedLocalUnconfinedV1"]);
  });
});
