import { Principal, type Principal as PrincipalType } from "./actor.js";
import type { ExecutionEpisodeBinding } from "./execution.js";
import type {
  CommandId,
  ExecutionId,
  PermissionGrantId,
  ProjectId,
  WorkspaceId,
} from "./ids.js";
import { DecisionId, MessageId, parse, WorkId } from "./ids.js";

export type SandboxProfile = "ReadOnly" | "WorkspaceWrite" | "FullAccess";
export type SandboxNetworkMode = "Disabled" | "Restricted" | "Enabled";
export type SandboxBoundary = "OsEnforced" | "TrustedLocal";
export type SandboxProviderStatus =
  | "Supported"
  | "Experimental"
  | "Unavailable";
export type SandboxProviderId = string;

/** Host-owned, startup-only issuer allowlist. The source that supplies this
 * value is responsible for OS protection and a durable monotone revision. */
export interface SandboxPolicyGrantIssuerConfigV1 {
  readonly version: 1;
  readonly revision: number;
  readonly issuers: ReadonlyArray<PrincipalType>;
}

export interface SandboxPolicyGrantIssuerConfigSnapshotV1 {
  readonly config: SandboxPolicyGrantIssuerConfigV1;
  readonly configDigest: string;
  readonly authorityBundleRevision: number;
  readonly authorityBundleDigest: string;
  readonly providerRegistryRevision: number;
  readonly providerRegistryDigest: string;
  readonly providerRegistry: SandboxProviderQualificationRegistryV1;
}

/** Validated V2 authority facts for both consumers. Issuer configuration
 * identity remains separate from operator configuration identity. */
export interface SandboxPolicyAuthoritySnapshotV2
  extends SandboxPolicyGrantIssuerConfigSnapshotV1 {
  readonly operatorConfigRevision: number;
  readonly operatorConfigDigest: string;
}

export type SandboxAuthorityLoadErrorV1 =
  | "SourceMissing"
  | "SourceUnreadable"
  | "SourceAclInvalid"
  | "SourceIdentityInvalid"
  | "SourceReparseDetected"
  | "BundleMalformed"
  | "IssuerConfigMalformed"
  | "ProviderRegistryMalformed"
  | "CanonicalEncodingInvalid"
  | "DigestMismatch"
  | "HighWaterMissing"
  | "HighWaterUnreadable"
  | "HighWaterCorrupt"
  | "RevisionRollback"
  | "RevisionReuseMismatch"
  | "SourceReenrollmentRequired"
  | "HighWaterCommitFailed"
  | "TrustSetMalformed"
  | "TrustSetDigestMismatch"
  | "TrustKeyUnavailable"
  | "TrustKeyRevoked"
  | "TrustKeyExpired"
  | "SignatureInvalid"
  | "TrustCurrentnessMismatch";

export type SandboxAuthorityAuditOutcomeV1 =
  | "Loaded"
  | "Rejected"
  | "HighWaterAdvanced"
  | "ReenrollmentRequired"
  | "QualificationAccepted"
  | "QualificationRejected";

export interface SandboxProviderQualificationTupleV1 {
  readonly profile: "ReadOnly" | "WorkspaceWrite";
  readonly networkMode: SandboxNetworkMode;
  readonly networkPolicyCodecVersion: 1;
  readonly enforcementRuleSetDigest: string;
}

export interface SandboxProviderQualificationEntryV1 {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly capabilityRevision: number;
  readonly osFamily: "Linux" | "macOS" | "Windows";
  readonly osBuild: string;
  readonly tuple: SandboxProviderQualificationTupleV1;
  readonly status: "Experimental" | "Unavailable" | "Supported";
  readonly qualificationEvidenceRef: string | null;
}

export interface SandboxProviderQualificationRegistryV1 {
  readonly version: 1;
  readonly revision: number;
  readonly entries: ReadonlyArray<SandboxProviderQualificationEntryV1>;
}

export interface SandboxAuthorityBundleV1 {
  readonly version: 1;
  readonly sourceIdentity: string;
  readonly bundleRevision: number;
  readonly issuerConfigRevision: number;
  readonly issuerConfigDigest: string;
  readonly issuerConfig: SandboxPolicyGrantIssuerConfigV1;
  readonly providerRegistryRevision: number;
  readonly providerRegistryDigest: string;
  readonly providerRegistry: SandboxProviderQualificationRegistryV1;
}

export interface SandboxAuthorityHighWaterV1 {
  readonly version: 1;
  readonly sourceIdentity: string;
  readonly bundleRevision: number;
  readonly bundleDigest: string;
  readonly issuerConfigRevision: number;
  readonly issuerConfigDigest: string;
  readonly providerRegistryRevision: number;
  readonly providerRegistryDigest: string;
}

export interface SandboxAuthorityAuditRecordV1 {
  readonly version: 1;
  readonly outcome: SandboxAuthorityAuditOutcomeV1;
  readonly detail: SandboxAuthorityLoadErrorV1 | null;
  readonly sourceIdentity: string | null;
  readonly bundleRevision: number | null;
  readonly bundleDigest: string | null;
  readonly issuerConfigRevision: number | null;
  readonly issuerConfigDigest: string | null;
  readonly providerRegistryRevision: number | null;
  readonly providerRegistryDigest: string | null;
  readonly occurredAt: string;
}

export interface SandboxAuthorityBundleSnapshotV1 {
  readonly bundle: SandboxAuthorityBundleV1;
  readonly bundleDigest: string;
  readonly canonicalJson: string;
  readonly issuerConfigSnapshot: SandboxPolicyGrantIssuerConfigSnapshotV1;
}

const compareUtf8Ordinal = (left: string, right: string): number => {
  const leftCodePoints = Array.from(
    left,
    (character) => character.codePointAt(0) ?? 0,
  );
  const rightCodePoints = Array.from(
    right,
    (character) => character.codePointAt(0) ?? 0,
  );
  const count = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < count; index += 1) {
    const difference =
      (leftCodePoints[index] ?? 0) - (rightCodePoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftCodePoints.length - rightCodePoints.length;
};

export const decodeSandboxPolicyGrantIssuerConfigV1 = (
  input: unknown,
): SandboxPolicyGrantIssuerConfigV1 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  if (
    !exactKeys(value, ["version", "revision", "issuers"]) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !Array.isArray(value.issuers) ||
    value.issuers.length === 0
  ) {
    return undefined;
  }
  const issuers: PrincipalType[] = [];
  for (const candidate of value.issuers) {
    if (
      typeof candidate !== "string" ||
      !candidate.startsWith("user:") ||
      candidate.length <= "user:".length ||
      candidate !== candidate.trim() ||
      /\p{Cc}/u.test(candidate)
    ) {
      return undefined;
    }
    try {
      issuers.push(parse(Principal)(candidate));
    } catch {
      return undefined;
    }
  }
  for (let index = 1; index < issuers.length; index += 1) {
    if (
      compareUtf8Ordinal(issuers[index - 1] ?? "", issuers[index] ?? "") >= 0
    ) {
      return undefined;
    }
  }
  return {
    version: 1,
    revision: value.revision as number,
    issuers,
  };
};

/** Canonical RFC 8785 JSON bytes for the closed config shape. Object keys use
 * order; the issuer array is strictly UTF-8 sorted and non-empty. */
export const encodeSandboxPolicyGrantIssuerConfigV1 = (
  config: SandboxPolicyGrantIssuerConfigV1,
): string =>
  `{"version":1,"revision":${config.revision},"issuers":${JSON.stringify(config.issuers)}}`;

export const decodeCanonicalSandboxPolicyGrantIssuerConfigV1 = (
  json: string,
): SandboxPolicyGrantIssuerConfigV1 | undefined => {
  try {
    const decoded = decodeSandboxPolicyGrantIssuerConfigV1(JSON.parse(json));
    return decoded !== undefined &&
      encodeSandboxPolicyGrantIssuerConfigV1(decoded) === json
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
};

export type NetworkDestinationV1 = string;

export interface NetworkPolicyV1 {
  readonly version: 1;
  readonly mode: SandboxNetworkMode;
  readonly destinations: ReadonlyArray<NetworkDestinationV1>;
}

export type SandboxNetworkPolicySelectionV1 =
  | {
      readonly kind: "OsEnforced";
      readonly policy: NetworkPolicyV1;
    }
  | { readonly kind: "TrustedLocalUnconfinedV1"; readonly version: 1 };

export interface SandboxProviderCapability {
  readonly providerId: SandboxProviderId;
  readonly providerVersion: string;
  readonly capabilityRevision: string;
  readonly probeEvidenceRef: string | null;
  readonly enforcementRuleSetDigest: string | null;
  readonly qualificationEvidenceRef: string | null;
  readonly status: SandboxProviderStatus;
  readonly boundary: SandboxBoundary;
  readonly profiles: ReadonlyArray<SandboxProfile>;
  readonly networkModes: ReadonlyArray<SandboxNetworkMode>;
}

export interface SandboxProviderSelection {
  readonly providerId: SandboxProviderId;
  readonly expectedProviderVersion: string;
  readonly expectedCapabilityRevision: string;
  readonly expectedEnforcementRuleSetDigest: string | null;
  readonly expectedQualificationEvidenceRef: string | null;
  readonly profile: SandboxProfile;
  readonly networkPolicy: NetworkPolicyV1;
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
        | "ProviderVersionMismatch"
        | "CapabilityRevisionMismatch"
        | "EnforcementRuleSetDigestMismatch"
        | "QualificationEvidenceMismatch"
        | "BoundaryMismatch"
        | "ProfileUnsupported"
        | "NetworkModeUnsupported";
      readonly capability?: SandboxProviderCapability;
    };

const networkModes: ReadonlyArray<string> = [
  "Disabled",
  "Restricted",
  "Enabled",
];

const exactKeys = (value: Record<string, unknown>, expected: string[]) => {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key)) &&
    actual.every((key) => expected.includes(key))
  );
};

const normalizedUrl = (
  url: string,
):
  | {
      readonly origin: string;
      readonly protocol: string;
      readonly hostname: string;
      readonly username: string;
      readonly password: string;
      readonly pathname: string;
      readonly search: string;
      readonly hash: string;
    }
  | undefined => {
  const Url = (
    globalThis as unknown as {
      readonly URL?: new (
        value: string,
      ) => {
        readonly origin: string;
        readonly protocol: string;
        readonly hostname: string;
        readonly username: string;
        readonly password: string;
        readonly pathname: string;
        readonly search: string;
        readonly hash: string;
      };
    }
  ).URL;
  if (Url === undefined) return undefined;
  try {
    return new Url(url);
  } catch {
    return undefined;
  }
};

const canonicalHostname = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 253 ||
    value !== value.toLowerCase() ||
    value.endsWith(".") ||
    !/^[a-z0-9.-]+$/u.test(value)
  ) {
    return false;
  }
  const labels = value.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
  ) {
    return false;
  }
  return normalizedUrl(`http://${value}/`)?.hostname === value;
};

const canonicalHttpsOrigin = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 320) return false;
  const url = normalizedUrl(value);
  return (
    url !== undefined &&
    url.protocol === "https:" &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.pathname === "/" &&
    url.search.length === 0 &&
    url.hash.length === 0 &&
    url.origin === value &&
    !/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/u.test(url.hostname) &&
    canonicalHostname(url.hostname)
  );
};

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Canonical, closed-field NetworkPolicy JSON v1 codec. */
export const encodeNetworkPolicyV1 = (policy: NetworkPolicyV1): string => {
  const destinations = [...policy.destinations].sort(compareCodeUnits);
  return `{"version":1,"mode":${JSON.stringify(policy.mode)},"destinations":[${destinations.map((origin) => JSON.stringify(origin)).join(",")}]}`;
};

export const decodeNetworkPolicyV1 = (
  input: unknown,
): NetworkPolicyV1 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  if (
    !exactKeys(value, ["version", "mode", "destinations"]) ||
    value.version !== 1 ||
    typeof value.mode !== "string" ||
    !networkModes.includes(value.mode) ||
    !Array.isArray(value.destinations)
  ) {
    return undefined;
  }

  const destinations: string[] = [];
  for (const candidate of value.destinations) {
    if (!canonicalHttpsOrigin(candidate)) return undefined;
    destinations.push(candidate);
  }

  if (
    (value.mode === "Restricted" && destinations.length === 0) ||
    (value.mode !== "Restricted" && destinations.length > 0)
  ) {
    return undefined;
  }
  const sorted = [...destinations].sort(compareCodeUnits);
  if (sorted.some((origin, index) => index > 0 && sorted[index - 1] === origin))
    return undefined;
  if (destinations.some((origin, index) => origin !== sorted[index]))
    return undefined;
  return {
    version: 1,
    mode: value.mode as SandboxNetworkMode,
    destinations: sorted,
  };
};

export const encodeSandboxNetworkPolicySelectionV1 = (
  selection: SandboxNetworkPolicySelectionV1,
): string =>
  selection.kind === "OsEnforced"
    ? `{"kind":"OsEnforced","policy":${encodeNetworkPolicyV1(selection.policy)}}`
    : `{"kind":"TrustedLocalUnconfinedV1","version":1}`;

export const decodeSandboxNetworkPolicySelectionV1 = (
  input: unknown,
): SandboxNetworkPolicySelectionV1 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  if (value.kind === "OsEnforced") {
    if (!exactKeys(value, ["kind", "policy"])) return undefined;
    const policy = decodeNetworkPolicyV1(value.policy);
    return policy === undefined ? undefined : { kind: "OsEnforced", policy };
  }
  return exactKeys(value, ["kind", "version"]) &&
    value.kind === "TrustedLocalUnconfinedV1" &&
    value.version === 1
    ? { kind: "TrustedLocalUnconfinedV1", version: 1 }
    : undefined;
};

export const decodeCanonicalSandboxNetworkPolicySelectionV1 = (
  json: string,
): SandboxNetworkPolicySelectionV1 | undefined => {
  try {
    const selection = decodeSandboxNetworkPolicySelectionV1(JSON.parse(json));
    return selection !== undefined &&
      encodeSandboxNetworkPolicySelectionV1(selection) === json
      ? selection
      : undefined;
  } catch {
    return undefined;
  }
};

export const decodeCanonicalNetworkPolicyV1 = (
  json: string,
): NetworkPolicyV1 | undefined => {
  try {
    const policy = decodeNetworkPolicyV1(JSON.parse(json));
    return policy !== undefined && encodeNetworkPolicyV1(policy) === json
      ? policy
      : undefined;
  } catch {
    return undefined;
  }
};

/** Decode an identifier without selecting or probing a provider. */
export const decodeSandboxProviderId = (
  input: unknown,
): SandboxProviderId | undefined => {
  if (typeof input !== "string" || input.trim() !== input) return undefined;
  if (input === "LocalTrusted") return "TrustedLocal";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input)) return undefined;
  return input;
};

/** Resolve only the provider and capability revision pinned by policy. */
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
    return { _tag: "Unavailable", reason: "ProviderUnavailable", capability };
  }
  if (capability.providerVersion !== selection.expectedProviderVersion) {
    return {
      _tag: "Unavailable",
      reason: "ProviderVersionMismatch",
      capability,
    };
  }
  if (capability.capabilityRevision !== selection.expectedCapabilityRevision) {
    return {
      _tag: "Unavailable",
      reason: "CapabilityRevisionMismatch",
      capability,
    };
  }
  if (selection.boundary === "OsEnforced") {
    if (
      selection.expectedEnforcementRuleSetDigest === null ||
      !/^[0-9a-f]{64}$/u.test(selection.expectedEnforcementRuleSetDigest) ||
      capability.enforcementRuleSetDigest !==
        selection.expectedEnforcementRuleSetDigest
    ) {
      return {
        _tag: "Unavailable",
        reason: "EnforcementRuleSetDigestMismatch",
        capability,
      };
    }
    if (
      selection.expectedQualificationEvidenceRef === null ||
      !/^blob:sha256:[0-9a-f]{64}$/u.test(
        selection.expectedQualificationEvidenceRef,
      ) ||
      capability.qualificationEvidenceRef !==
        selection.expectedQualificationEvidenceRef ||
      capability.probeEvidenceRef !== selection.expectedQualificationEvidenceRef
    ) {
      return {
        _tag: "Unavailable",
        reason: "QualificationEvidenceMismatch",
        capability,
      };
    }
  }
  if (capability.boundary !== selection.boundary) {
    return { _tag: "Unavailable", reason: "BoundaryMismatch", capability };
  }
  if (
    selection.boundary === "OsEnforced" &&
    capability.status !== "Supported"
  ) {
    return {
      _tag: "Unavailable",
      reason: "ProviderNotSupported",
      capability,
    };
  }
  if (!capability.profiles.includes(selection.profile)) {
    return { _tag: "Unavailable", reason: "ProfileUnsupported", capability };
  }
  if (!capability.networkModes.includes(selection.networkPolicy.mode)) {
    return {
      _tag: "Unavailable",
      reason: "NetworkModeUnsupported",
      capability,
    };
  }
  return { _tag: "Available", capability };
};

export interface SandboxPolicyDecision {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly episodeBinding: ExecutionEpisodeBinding;
  readonly policyRevision: number;
  readonly expectedExecutionRevision: number;
  readonly expectedPolicyRevision: number;
  readonly profile: SandboxProfile;
  readonly providerId: SandboxProviderId;
  readonly networkPolicy: SandboxNetworkPolicySelectionV1;
  readonly policyDigest: string;
  readonly permissionGrantId: PermissionGrantId;
  readonly grantPermissionCommandId: CommandId;
  readonly grantIssuerPrincipal: PrincipalType;
  readonly operatorConfigRevision: number;
  readonly operatorConfigDigest: string;
  readonly actorPrincipal: PrincipalType;
  readonly decisionCommandId: CommandId;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface SandboxPolicyGrantIssuerProvenanceV1 {
  readonly permissionGrantId: PermissionGrantId;
  readonly grantPermissionCommandId: CommandId;
  readonly issuerPrincipal: PrincipalType;
  readonly operatorConfigRevision: number;
  readonly operatorConfigDigest: string;
}

const isRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Strict closed-field decoder for a durable ExecutionEpisodeBinding. */
export const decodeExecutionEpisodeBinding = (
  input: unknown,
): ExecutionEpisodeBinding | undefined => {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    typeof (input as { readonly _tag?: unknown })._tag !== "string"
  ) {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  try {
    switch (value._tag) {
      case "WorkEpisode":
        if (
          !exactKeys(value, ["_tag", "workId", "targetWorkRevision"]) ||
          typeof value.workId !== "string" ||
          !isRevision(value.targetWorkRevision)
        ) {
          return undefined;
        }
        return {
          _tag: "WorkEpisode",
          workId: parse(WorkId)(value.workId),
          targetWorkRevision: value.targetWorkRevision as never,
        };
      case "ConversationResponseEpisode":
        if (
          !exactKeys(value, ["_tag", "messageId", "responseJobRevision"]) ||
          typeof value.messageId !== "string" ||
          !isRevision(value.responseJobRevision)
        ) {
          return undefined;
        }
        return {
          _tag: "ConversationResponseEpisode",
          messageId: parse(MessageId)(value.messageId),
          responseJobRevision: value.responseJobRevision,
        };
      case "InboxEpisode":
        if (
          !exactKeys(value, ["_tag", "entryKey", "inputKind"]) ||
          typeof value.entryKey !== "string" ||
          value.entryKey.trim().length === 0 ||
          typeof value.inputKind !== "string" ||
          value.inputKind.trim().length === 0
        ) {
          return undefined;
        }
        return {
          _tag: "InboxEpisode",
          entryKey: value.entryKey,
          inputKind: value.inputKind,
        };
      case "DecisionEpisode":
        if (
          !exactKeys(value, [
            "_tag",
            "decisionId",
            "decisionKind",
            "requestRevision",
          ]) ||
          typeof value.decisionId !== "string" ||
          value.decisionKind !== "SelectCurrentWork" ||
          !isRevision(value.requestRevision)
        ) {
          return undefined;
        }
        return {
          _tag: "DecisionEpisode",
          decisionId: parse(DecisionId)(value.decisionId),
          decisionKind: "SelectCurrentWork",
          requestRevision: value.requestRevision,
        };
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
};

export const encodeExecutionEpisodeBinding = (
  input: ExecutionEpisodeBinding,
): string => {
  switch (input._tag) {
    case "WorkEpisode":
      return JSON.stringify({
        _tag: input._tag,
        workId: input.workId,
        targetWorkRevision: input.targetWorkRevision,
      });
    case "ConversationResponseEpisode":
      return JSON.stringify({
        _tag: input._tag,
        messageId: input.messageId,
        responseJobRevision: input.responseJobRevision,
      });
    case "InboxEpisode":
      return JSON.stringify({
        _tag: input._tag,
        entryKey: input.entryKey,
        inputKind: input.inputKind,
      });
    case "DecisionEpisode":
      return JSON.stringify({
        _tag: input._tag,
        decisionId: input.decisionId,
        decisionKind: input.decisionKind,
        requestRevision: input.requestRevision,
      });
  }
};

export const decodeCanonicalExecutionEpisodeBinding = (
  json: string,
): ExecutionEpisodeBinding | undefined => {
  try {
    const binding = decodeExecutionEpisodeBinding(JSON.parse(json));
    return binding !== undefined &&
      encodeExecutionEpisodeBinding(binding) === json
      ? binding
      : undefined;
  } catch {
    return undefined;
  }
};
