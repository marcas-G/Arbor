import { Principal } from "./actor.js";
import type { ExecutionEpisodeBinding } from "./execution.js";
import type { ExecutionId, ProjectId, WorkspaceId } from "./ids.js";
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
  readonly operators: ReadonlyArray<Principal>;
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
    !exactKeys(value, ["version", "revision", "operators"]) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !Array.isArray(value.operators)
  ) {
    return undefined;
  }
  const operators: Principal[] = [];
  for (const candidate of value.operators) {
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
      operators.push(parse(Principal)(candidate));
    } catch {
      return undefined;
    }
  }
  for (let index = 1; index < operators.length; index += 1) {
    if (
      compareUtf8Ordinal(operators[index - 1] ?? "", operators[index] ?? "") >=
      0
    ) {
      return undefined;
    }
  }
  return {
    version: 1,
    revision: value.revision as number,
    operators,
  };
};

/** Canonical RFC 8785 JSON bytes for the closed config shape. Object keys use
 * JCS ordinal order; the codec requires already-sorted operator principals. */
export const encodeSandboxPolicyGrantIssuerConfigV1 = (
  config: SandboxPolicyGrantIssuerConfigV1,
): string =>
  `{"operators":${JSON.stringify(config.operators)},"revision":${config.revision},"version":1}`;

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

export type NetworkDestinationV1 =
  | {
      readonly _tag: "Hostname";
      readonly hostname: string;
      readonly protocol: string;
      readonly port: number;
    }
  | {
      readonly _tag: "IpLiteral";
      readonly address: string;
      readonly protocol: string;
      readonly port: number;
    };

export interface NetworkPolicyV1 {
  readonly version: 1;
  readonly mode: SandboxNetworkMode;
  readonly destinations: ReadonlyArray<NetworkDestinationV1>;
}

export interface SandboxProviderCapability {
  readonly providerId: SandboxProviderId;
  readonly providerVersion: string;
  readonly capabilityRevision: string;
  readonly probeEvidenceRef: string | null;
  readonly status: SandboxProviderStatus;
  readonly boundary: SandboxBoundary;
  readonly profiles: ReadonlyArray<SandboxProfile>;
  readonly networkModes: ReadonlyArray<SandboxNetworkMode>;
}

export interface SandboxProviderSelection {
  readonly providerId: SandboxProviderId;
  readonly expectedProviderVersion: string;
  readonly expectedCapabilityRevision: string;
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

const normalizedUrlHostname = (url: string): string | undefined => {
  const Url = (
    globalThis as unknown as {
      readonly URL?: new (value: string) => { readonly hostname: string };
    }
  ).URL;
  if (Url === undefined) return undefined;
  try {
    return new Url(url).hostname;
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
  return normalizedUrlHostname(`http://${value}/`) === value;
};

const canonicalIpv4 = (value: string): boolean => {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every(
      (part) => /^(?:0|[1-9][0-9]{0,2})$/u.test(part) && Number(part) <= 255,
    ) &&
    normalizedUrlHostname(`http://${value}/`) === value
  );
};

const canonicalIpv6String = (value: string): string | undefined => {
  if (value.includes("%") || value !== value.toLowerCase()) return undefined;
  const split = value.split("::");
  if (split.length > 2) return undefined;
  const leftText = split[0] ?? "";
  const rightText = split.length === 2 ? (split[1] ?? "") : "";
  const left = leftText.length === 0 ? [] : leftText.split(":");
  const right = rightText.length === 0 ? [] : rightText.split(":");
  const groups = [...left, ...right];
  if (groups.some((group) => !/^(?:0|[1-9a-f][0-9a-f]{0,3})$/u.test(group))) {
    return undefined;
  }
  if (split.length === 1 && groups.length !== 8) return undefined;
  if (split.length === 2 && groups.length >= 8) return undefined;
  const expanded =
    split.length === 1
      ? groups
      : [
          ...left,
          ...Array.from({ length: 8 - groups.length }, () => "0"),
          ...right,
        ];
  let bestStart = -1;
  let bestLength = 1;
  for (let index = 0; index < expanded.length; ) {
    if (expanded[index] !== "0") {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (expanded[end] === "0") end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestStart < 0) return expanded.join(":");
  const leftCanonical = expanded.slice(0, bestStart).join(":");
  const rightCanonical = expanded.slice(bestStart + bestLength).join(":");
  if (leftCanonical.length === 0 && rightCanonical.length === 0) return "::";
  if (leftCanonical.length === 0) return `::${rightCanonical}`;
  if (rightCanonical.length === 0) return `${leftCanonical}::`;
  return `${leftCanonical}::${rightCanonical}`;
};

const canonicalIpv6 = (value: string): boolean => {
  return (
    value.includes(":") &&
    canonicalIpv6String(value) === value &&
    normalizedUrlHostname(`http://[${value}]/`) === `[${value}]`
  );
};

const destinationKey = (destination: NetworkDestinationV1): string =>
  destination._tag === "Hostname"
    ? `hostname\0${destination.hostname}\0${destination.protocol}\0${destination.port}`
    : `ip\0${destination.address}\0${destination.protocol}\0${destination.port}`;

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const encodeDestination = (destination: NetworkDestinationV1): string =>
  destination._tag === "Hostname"
    ? `{"_tag":"Hostname","hostname":${JSON.stringify(destination.hostname)},"protocol":${JSON.stringify(destination.protocol)},"port":${destination.port}}`
    : `{"_tag":"IpLiteral","address":${JSON.stringify(destination.address)},"protocol":${JSON.stringify(destination.protocol)},"port":${destination.port}}`;

/** Canonical, closed-field NetworkPolicy JSON v1 codec. */
export const encodeNetworkPolicyV1 = (policy: NetworkPolicyV1): string => {
  const destinations = [...policy.destinations].sort((left, right) =>
    compareCodeUnits(destinationKey(left), destinationKey(right)),
  );
  return `{"version":1,"mode":${JSON.stringify(policy.mode)},"destinations":[${destinations.map(encodeDestination).join(",")}]}`;
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

  const destinations: NetworkDestinationV1[] = [];
  for (const candidate of value.destinations) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return undefined;
    }
    const row = candidate as Record<string, unknown>;
    const hostname = row._tag === "Hostname";
    const ipLiteral = row._tag === "IpLiteral";
    const expectedKeys = hostname
      ? ["_tag", "hostname", "protocol", "port"]
      : ipLiteral
        ? ["_tag", "address", "protocol", "port"]
        : [];
    if (
      expectedKeys.length === 0 ||
      !exactKeys(row, expectedKeys) ||
      typeof row.protocol !== "string" ||
      !/^[a-z][a-z0-9+.-]{0,31}$/u.test(row.protocol) ||
      !Number.isInteger(row.port) ||
      (row.port as number) < 1 ||
      (row.port as number) > 65_535
    ) {
      return undefined;
    }
    if (hostname && canonicalHostname(row.hostname)) {
      destinations.push({
        _tag: "Hostname",
        hostname: row.hostname,
        protocol: row.protocol,
        port: row.port as number,
      });
      continue;
    }
    if (
      ipLiteral &&
      typeof row.address === "string" &&
      (canonicalIpv4(row.address) || canonicalIpv6(row.address))
    ) {
      destinations.push({
        _tag: "IpLiteral",
        address: row.address,
        protocol: row.protocol,
        port: row.port as number,
      });
      continue;
    }
    return undefined;
  }

  if (value.mode !== "Restricted" && destinations.length > 0) {
    return undefined;
  }
  const sorted = [...destinations].sort((left, right) =>
    compareCodeUnits(destinationKey(left), destinationKey(right)),
  );
  if (
    sorted.some(
      (destination, index) =>
        index > 0 &&
        destinationKey(sorted[index - 1] as NetworkDestinationV1) ===
          destinationKey(destination),
    )
  ) {
    return undefined;
  }
  return {
    version: 1,
    mode: value.mode as SandboxNetworkMode,
    destinations: sorted,
  };
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
  readonly profile: SandboxProfile;
  readonly providerId: SandboxProviderId;
  readonly networkPolicy: NetworkPolicyV1;
  readonly policyDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
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
