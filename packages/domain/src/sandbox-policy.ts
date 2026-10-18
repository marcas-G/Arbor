import type { ExecutionEpisodeBinding } from "./execution.js";
import type { ExecutionId, ProjectId, WorkspaceId } from "./ids.js";

export type SandboxProfile = "ReadOnly" | "WorkspaceWrite" | "FullAccess";
export type SandboxNetworkMode = "Disabled" | "Restricted" | "Enabled";
export type SandboxBoundary = "OsEnforced" | "TrustedLocal";
export type SandboxProviderStatus =
  | "Supported"
  | "Experimental"
  | "Unavailable";
export type SandboxProviderId = string;

export interface SandboxProviderCapability {
  readonly providerId: SandboxProviderId;
  readonly providerVersion: string;
  readonly status: SandboxProviderStatus;
  readonly boundary: SandboxBoundary;
  readonly profiles: ReadonlyArray<SandboxProfile>;
  readonly networkModes: ReadonlyArray<SandboxNetworkMode>;
}

export interface SandboxProviderSelection {
  readonly providerId: SandboxProviderId;
  readonly profile: SandboxProfile;
  readonly networkMode: SandboxNetworkMode;
  readonly boundary: SandboxBoundary;
}

export type SandboxProviderResolution =
  | {
      readonly _tag: "Available";
      readonly capability: SandboxProviderCapability;
    }
  | {
      readonly _tag: "Unavailable";
      readonly reason:
        | "ProviderNotFound"
        | "ProviderUnavailable"
        | "ProviderNotSupported"
        | "BoundaryMismatch"
        | "ProfileUnsupported"
        | "NetworkModeUnsupported";
    };

/**
 * Decode a provider identifier without selecting or probing a provider.
 * LocalTrusted is accepted only as a historical spelling and always becomes
 * the explicit TrustedLocal identity; callers must still select it in policy.
 */
export const decodeSandboxProviderId = (
  input: unknown,
): SandboxProviderId | undefined => {
  if (typeof input !== "string" || input.trim() !== input) return undefined;
  if (input === "LocalTrusted") return "TrustedLocal";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input)) return undefined;
  return input;
};

/** Resolve only the exact provider requested by the immutable policy. */
export const resolveSandboxProvider = (
  selection: SandboxProviderSelection,
  capabilities: ReadonlyArray<SandboxProviderCapability>,
): SandboxProviderResolution => {
  const exact = capabilities.filter(
    (capability) => capability.providerId === selection.providerId,
  );
  if (exact.length !== 1) {
    return { _tag: "Unavailable", reason: "ProviderNotFound" };
  }
  const capability = exact[0];
  if (capability === undefined) {
    return { _tag: "Unavailable", reason: "ProviderNotFound" };
  }
  if (capability.status === "Unavailable") {
    return { _tag: "Unavailable", reason: "ProviderUnavailable" };
  }
  if (capability.boundary !== selection.boundary) {
    return { _tag: "Unavailable", reason: "BoundaryMismatch" };
  }
  if (
    selection.boundary === "OsEnforced" &&
    capability.status !== "Supported"
  ) {
    return { _tag: "Unavailable", reason: "ProviderNotSupported" };
  }
  if (!capability.profiles.includes(selection.profile)) {
    return { _tag: "Unavailable", reason: "ProfileUnsupported" };
  }
  if (!capability.networkModes.includes(selection.networkMode)) {
    return { _tag: "Unavailable", reason: "NetworkModeUnsupported" };
  }
  return { _tag: "Available", capability };
};

export interface SandboxPolicyDecision {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly episodeBinding: ExecutionEpisodeBinding;
  readonly policyRevision: number;
  readonly profile: SandboxProfile;
  readonly providerId: SandboxProviderId;
  readonly networkMode: SandboxNetworkMode;
  readonly policyDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
