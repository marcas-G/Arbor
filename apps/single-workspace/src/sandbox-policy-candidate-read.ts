import { createHash } from "node:crypto";
import {
  compareUtf8BytesV1,
  type Execution,
  encodeExecutionEpisodeBinding,
  encodeNetworkBrokerControlsV1,
  executionEpisode,
  networkBrokerControlsV1ForMode,
  produceSandboxBoundaryV1,
  type SandboxAuthorityBundleSnapshotV2,
  type SandboxPolicyCandidateReadV1,
  type SandboxPolicyCurrentHostV1,
  sandboxPolicyCandidateIdV2,
} from "@arbor/domain";
import {
  type SandboxPolicyCandidateBoundarySnapshotV1,
  type SandboxPolicyRequirementV1,
  sha256Hex,
} from "@arbor/ports";

export type SandboxPolicyCandidateReadBuildFailureV1 =
  | { readonly _tag: "InvalidRequirementOrExecution" }
  | { readonly _tag: "InvalidBoundarySnapshot" }
  | { readonly _tag: "InvalidHostTupleProof" }
  | { readonly _tag: "SandboxBoundaryProductionRejected" };

const idHash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const produceBoundary = (
  input: Parameters<typeof produceSandboxBoundaryV1>[0],
) => {
  try {
    return produceSandboxBoundaryV1(input, sha256Hex);
  } catch {
    return undefined;
  }
};

/** Build candidates from one verified P5 host snapshot and one pinned P11
 * snapshot. This is pure and never invokes a provider capability probe. */
export const buildSandboxPolicyCandidateReadV1 = (input: {
  readonly reason: SandboxPolicyCandidateReadV1["reason"];
  readonly execution: Execution;
  readonly requirement: SandboxPolicyRequirementV1;
  readonly latestCommittedPolicyRevision: number;
  readonly expectedEpisodeRevision: number;
  readonly boundary: SandboxPolicyCandidateBoundarySnapshotV1;
  readonly authority: SandboxAuthorityBundleSnapshotV2;
  readonly currentHost: SandboxPolicyCurrentHostV1;
}):
  | { readonly _tag: "Ready"; readonly value: SandboxPolicyCandidateReadV1 }
  | SandboxPolicyCandidateReadBuildFailureV1 => {
  const { execution, requirement, boundary, authority, currentHost } = input;
  const episode = executionEpisode(execution);
  if (
    episode === undefined ||
    !Number.isSafeInteger(input.expectedEpisodeRevision) ||
    input.expectedEpisodeRevision < 0 ||
    !Number.isSafeInteger(input.latestCommittedPolicyRevision) ||
    input.latestCommittedPolicyRevision < 0 ||
    requirement.projectId !== execution.projectId ||
    requirement.workspaceId !== execution.workspaceId ||
    requirement.executionId !== execution.executionId ||
    requirement.expectedEpisodeRevision !== input.expectedEpisodeRevision ||
    encodeExecutionEpisodeBinding(requirement.episodeBinding) !==
      encodeExecutionEpisodeBinding(episode)
  )
    return { _tag: "InvalidRequirementOrExecution" };

  const workspace = boundary.workspace;
  if (
    workspace.projectId !== execution.projectId ||
    workspace.workspaceId !== execution.workspaceId ||
    workspace.lifecycle !== "Active" ||
    workspace.responsibilityRevision !==
      workspace.resourceBoundary.basisResponsibilityRevision ||
    !Number.isSafeInteger(workspace.revision) ||
    !Number.isSafeInteger(workspace.resourceBoundaryRevision)
  )
    return { _tag: "InvalidBoundarySnapshot" };

  const producerBase = {
    workspaceId: workspace.workspaceId,
    resourceBoundaryRevision: workspace.resourceBoundaryRevision,
    responsibilityRevision: workspace.responsibilityRevision,
    boundary: workspace.resourceBoundary,
    resolvedRegions: boundary.resolvedRegions,
    primaryManagedGitWorktreeRegion: boundary.primaryManagedGitWorktreeRegion,
    ownershipClaims: boundary.ownershipClaims.map((claim) => ({
      workspaceId: claim.workspaceId,
      region: claim.region,
      resourceBoundaryRevision: claim.resourceBoundaryRevision,
      releasedAt: claim.releasedAt,
    })),
  };
  const bundle = authority.bundle;
  const candidatesById = new Map<
    string,
    SandboxPolicyCandidateReadV1["candidates"][number]
  >();
  for (const entry of bundle.providerRegistry.entries) {
    if (
      entry.status !== "Supported" ||
      entry.osFamily !== currentHost.osFamily ||
      entry.osBuild !== currentHost.osBuild ||
      entry.tuple.networkPolicyCodecVersion !== 1 ||
      sha256Hex(
        encodeNetworkBrokerControlsV1(
          networkBrokerControlsV1ForMode(entry.tuple.networkMode),
        ),
      ) !== entry.tuple.enforcementRuleSetDigest
    )
      continue;
    const production = produceBoundary({
      ...producerBase,
      policyKind: "OsEnforced",
      profile: entry.tuple.profile,
    });
    if (production === undefined)
      return { _tag: "SandboxBoundaryProductionRejected" };
    const tuple = {
      kind: "OsEnforced" as const,
      providerId: entry.providerId,
      providerVersion: entry.providerVersion,
      profile: entry.tuple.profile,
      networkMode: entry.tuple.networkMode as
        | "Disabled"
        | "Restricted"
        | "Enabled",
      providerRegistryRevision: bundle.providerRegistryRevision,
      providerRegistryDigest: bundle.providerRegistryDigest as never,
    };
    const candidate = {
      ...tuple,
      candidateId: sandboxPolicyCandidateIdV2(tuple, idHash),
      sandboxHandleBindingDigest:
        production.sandboxHandleBindingDigest as never,
    } satisfies SandboxPolicyCandidateReadV1["candidates"][number];
    const previous = candidatesById.get(candidate.candidateId);
    if (
      previous !== undefined &&
      JSON.stringify(previous) !== JSON.stringify(candidate)
    )
      return { _tag: "InvalidHostTupleProof" };
    candidatesById.set(candidate.candidateId, candidate);
  }
  const trustedProduction = produceBoundary({
    ...producerBase,
    policyKind: "TrustedLocalUnconfinedV1",
    profile: "FullAccess",
  });
  if (trustedProduction === undefined)
    return { _tag: "SandboxBoundaryProductionRejected" };
  const trustedTuple = { kind: "TrustedLocalUnconfinedV1" as const };
  const trustedCandidate = {
    ...trustedTuple,
    candidateId: sandboxPolicyCandidateIdV2(trustedTuple, idHash),
    sandboxHandleBindingDigest:
      trustedProduction.sandboxHandleBindingDigest as never,
  } satisfies SandboxPolicyCandidateReadV1["candidates"][number];
  const previousTrusted = candidatesById.get(trustedCandidate.candidateId);
  if (
    previousTrusted !== undefined &&
    JSON.stringify(previousTrusted) !== JSON.stringify(trustedCandidate)
  )
    return { _tag: "InvalidHostTupleProof" };
  const osCandidates = [...candidatesById.values()]
    .filter(
      (
        candidate,
      ): candidate is Extract<
        SandboxPolicyCandidateReadV1["candidates"][number],
        { readonly kind: "OsEnforced" }
      > => candidate.kind === "OsEnforced",
    )
    .sort((left, right) => {
      const leftTuple = [
        left.providerId,
        left.providerVersion,
        left.profile,
        left.networkMode,
        String(left.providerRegistryRevision),
        left.providerRegistryDigest,
      ];
      const rightTuple = [
        right.providerId,
        right.providerVersion,
        right.profile,
        right.networkMode,
        String(right.providerRegistryRevision),
        right.providerRegistryDigest,
      ];
      for (let index = 0; index < leftTuple.length; index += 1) {
        const order = compareUtf8BytesV1(
          leftTuple[index] ?? "",
          rightTuple[index] ?? "",
        );
        if (order !== 0) return order;
      }
      return 0;
    });
  return {
    _tag: "Ready",
    value: {
      reason: input.reason,
      commonPreconditions: {
        expectedEpisodeRevision: input.expectedEpisodeRevision,
        latestCommittedPolicyRevision: input.latestCommittedPolicyRevision,
        episodeBinding: episode,
        workspaceRevision: workspace.revision,
        resourceBoundaryRevision: workspace.resourceBoundaryRevision,
        authorityBundleRevision: bundle.bundleRevision,
        authorityBundleDigest: authority.bundleDigest as never,
        operatorConfigRevision: bundle.operatorConfigRevision,
        operatorConfigDigest: bundle.operatorConfigDigest as never,
      },
      candidates: [...osCandidates, trustedCandidate],
    },
  };
};
