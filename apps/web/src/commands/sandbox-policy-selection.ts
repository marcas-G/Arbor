import type { WorkspaceDetailRes } from "@arbor/api-contracts";

type CandidateRead = NonNullable<
  WorkspaceDetailRes["sandboxPolicyCandidateRead"]
>;
type ExecutionEpisodeBinding =
  CandidateRead["commonPreconditions"]["episodeBinding"];
type SandboxProfile = "ReadOnly" | "WorkspaceWrite" | "FullAccess";

export interface DecideSandboxPolicyPayloadV1 {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly executionId: string;
  readonly episodeBinding: ExecutionEpisodeBinding;
  readonly expectedEpisodeRevision: number;
  readonly expectedPolicyRevision: number;
  readonly expectedWorkspaceRevision: number;
  readonly expectedResourceBoundaryRevision: number;
  readonly expectedSandboxHandleBindingDigest: string;
  readonly expectedAuthorityBundleRevision: number;
  readonly expectedAuthorityBundleDigest: string;
  readonly expectedOperatorConfigRevision: number;
  readonly expectedOperatorConfigDigest: string;
  readonly expectedProviderRegistryRevision?: number;
  readonly expectedProviderRegistryDigest?: string;
  readonly profile: SandboxProfile;
  readonly providerId: string;
  readonly networkPolicy:
    | {
        readonly kind: "OsEnforced";
        readonly policy: {
          readonly version: 1;
          readonly mode: "Disabled" | "Restricted" | "Enabled";
          readonly destinations: ReadonlyArray<string>;
        };
      }
    | { readonly kind: "TrustedLocalUnconfinedV1"; readonly version: 1 };
  readonly decisionExpiresAt: string;
}

export type SandboxPolicySelectionFailure =
  | "CandidateNotInCurrentRead"
  | "TrustedLocalNeedsExplicitConfirmation"
  | "NetworkDestinationsInvalid";

export type SandboxPolicySelectionResult =
  | { readonly _tag: "Ready"; readonly payload: DecideSandboxPolicyPayloadV1 }
  | {
      readonly _tag: "Invalid";
      readonly reason: SandboxPolicySelectionFailure;
    };

/** Maps only the deliberately selected candidate into the existing P1
 * command. Candidate IDs and unselected candidate digests never cross this
 * boundary. */
export const decideSandboxPolicyPayloadFromCandidate = (input: {
  readonly read: CandidateRead;
  readonly candidateId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly executionId: string;
  readonly decisionExpiresAt: string;
  readonly networkDestinations: ReadonlyArray<string>;
  readonly trustedLocalConfirmed: boolean;
}): SandboxPolicySelectionResult => {
  const candidate = input.read.candidates.find(
    (item) => item.candidateId === input.candidateId,
  );
  if (candidate === undefined)
    return { _tag: "Invalid", reason: "CandidateNotInCurrentRead" };
  const common = input.read.commonPreconditions;
  if (candidate.kind === "TrustedLocalUnconfinedV1") {
    if (!input.trustedLocalConfirmed)
      return {
        _tag: "Invalid",
        reason: "TrustedLocalNeedsExplicitConfirmation",
      };
    if (input.networkDestinations.length !== 0)
      return { _tag: "Invalid", reason: "NetworkDestinationsInvalid" };
    return {
      _tag: "Ready",
      payload: {
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        executionId: input.executionId,
        episodeBinding: common.episodeBinding,
        expectedEpisodeRevision: common.expectedEpisodeRevision,
        expectedPolicyRevision: common.latestCommittedPolicyRevision,
        expectedWorkspaceRevision: common.workspaceRevision,
        expectedResourceBoundaryRevision: common.resourceBoundaryRevision,
        expectedSandboxHandleBindingDigest:
          candidate.sandboxHandleBindingDigest,
        expectedAuthorityBundleRevision: common.authorityBundleRevision,
        expectedAuthorityBundleDigest: common.authorityBundleDigest,
        expectedOperatorConfigRevision: common.operatorConfigRevision,
        expectedOperatorConfigDigest: common.operatorConfigDigest,
        profile: "FullAccess",
        providerId: "TrustedLocal",
        networkPolicy: { kind: "TrustedLocalUnconfinedV1", version: 1 },
        decisionExpiresAt: input.decisionExpiresAt,
      },
    };
  }

  if (
    candidate.networkMode === "Restricted" &&
    input.networkDestinations.length === 0
  )
    return { _tag: "Invalid", reason: "NetworkDestinationsInvalid" };
  if (
    candidate.networkMode !== "Restricted" &&
    input.networkDestinations.length !== 0
  )
    return { _tag: "Invalid", reason: "NetworkDestinationsInvalid" };
  const destinations = [...input.networkDestinations].sort();
  if (
    new Set(destinations).size !== destinations.length ||
    destinations.some((destination) => destination.trim() !== destination)
  )
    return { _tag: "Invalid", reason: "NetworkDestinationsInvalid" };
  return {
    _tag: "Ready",
    payload: {
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      executionId: input.executionId,
      episodeBinding: common.episodeBinding,
      expectedEpisodeRevision: common.expectedEpisodeRevision,
      expectedPolicyRevision: common.latestCommittedPolicyRevision,
      expectedWorkspaceRevision: common.workspaceRevision,
      expectedResourceBoundaryRevision: common.resourceBoundaryRevision,
      expectedSandboxHandleBindingDigest: candidate.sandboxHandleBindingDigest,
      expectedAuthorityBundleRevision: common.authorityBundleRevision,
      expectedAuthorityBundleDigest: common.authorityBundleDigest,
      expectedOperatorConfigRevision: common.operatorConfigRevision,
      expectedOperatorConfigDigest: common.operatorConfigDigest,
      expectedProviderRegistryRevision: candidate.providerRegistryRevision,
      expectedProviderRegistryDigest: candidate.providerRegistryDigest,
      profile: candidate.profile,
      providerId: candidate.providerId,
      networkPolicy: {
        kind: "OsEnforced",
        policy: {
          version: 1,
          mode: candidate.networkMode,
          destinations,
        },
      },
      decisionExpiresAt: input.decisionExpiresAt,
    },
  };
};
