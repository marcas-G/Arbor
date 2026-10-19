import type {
  SandboxAuthorityAuditOutcomeV1,
  SandboxAuthorityLoadErrorV1,
  SandboxPolicyGrantIssuerConfigV1,
  SandboxProviderQualificationEntryV1,
  SandboxProviderQualificationRegistryV1,
} from "./sandbox-policy.js";
import {
  decodeCanonicalSandboxPolicyGrantIssuerConfigV1,
  encodeSandboxPolicyGrantIssuerConfigV1,
} from "./sandbox-policy.js";
import {
  compareUtf8BytesV1,
  type SandboxNetworkModeV1,
  type Sha256Hex,
} from "./sandbox-policy-producers.js";

export interface SandboxOperatorLimitsV1 {
  readonly wallTimeMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly processCount: number;
  readonly memoryBytes: number;
  readonly cpuTimeMs: number;
}

export interface SandboxOperatorProfileLimitsV1 {
  readonly profile: "ReadOnly" | "WorkspaceWrite" | "FullAccess";
  readonly limits: SandboxOperatorLimitsV1;
}

export interface SandboxOperatorPolicyConfigV1 {
  readonly version: 1;
  readonly revision: number;
  readonly environmentAllowlist: ReadonlyArray<string>;
  readonly limitsByProfile: ReadonlyArray<SandboxOperatorProfileLimitsV1>;
  readonly trustedLocalRuntimeVersion: "builtin-v1";
}

export interface SandboxAuthorityBundleV2 {
  readonly version: 2;
  readonly sourceIdentity: string;
  readonly bundleRevision: number;
  readonly issuerConfigRevision: number;
  readonly issuerConfigDigest: string;
  readonly issuerConfig: SandboxPolicyGrantIssuerConfigV1;
  readonly operatorConfigRevision: number;
  readonly operatorConfigDigest: string;
  readonly operatorConfig: SandboxOperatorPolicyConfigV1;
  readonly providerRegistryRevision: number;
  readonly providerRegistryDigest: string;
  readonly providerRegistry: SandboxProviderQualificationRegistryV1;
}

export interface SandboxAuthorityBundleSnapshotV2 {
  readonly bundle: SandboxAuthorityBundleV2;
  readonly bundleDigest: string;
  readonly canonicalJson: string;
}

export interface SandboxAuthorityHighWaterV2 {
  readonly version: 2;
  readonly sourceIdentity: string;
  readonly bundleRevision: number;
  readonly bundleDigest: string;
  readonly issuerConfigRevision: number;
  readonly issuerConfigDigest: string;
  readonly operatorConfigRevision: number;
  readonly operatorConfigDigest: string;
  readonly providerRegistryRevision: number;
  readonly providerRegistryDigest: string;
}

export interface SandboxAuthorityAuditRecordV2 {
  readonly version: 2;
  readonly outcome: SandboxAuthorityAuditOutcomeV1;
  readonly detail: SandboxAuthorityLoadErrorV1 | null;
  readonly sourceIdentity: string | null;
  readonly bundleRevision: number | null;
  readonly bundleDigest: string | null;
  readonly issuerConfigRevision: number | null;
  readonly issuerConfigDigest: string | null;
  readonly operatorConfigRevision: number | null;
  readonly operatorConfigDigest: string | null;
  readonly providerRegistryRevision: number | null;
  readonly providerRegistryDigest: string | null;
  readonly occurredAt: string;
}

const digestPattern = /^[0-9a-f]{64}$/u;
const canonicalIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const profiles = ["ReadOnly", "WorkspaceWrite", "FullAccess"] as const;
const osFamilies = ["Linux", "macOS", "Windows"] as const;
const statuses = ["Experimental", "Unavailable", "Supported"] as const;
const networkModes = ["Disabled", "Restricted", "Enabled"] as const;
const outcomes: ReadonlyArray<SandboxAuthorityAuditOutcomeV1> = [
  "Loaded",
  "Rejected",
  "HighWaterAdvanced",
  "ReenrollmentRequired",
  "QualificationAccepted",
  "QualificationRejected",
];
const loadErrors: ReadonlyArray<SandboxAuthorityLoadErrorV1> = [
  "SourceMissing",
  "SourceUnreadable",
  "SourceAclInvalid",
  "SourceIdentityInvalid",
  "SourceReparseDetected",
  "BundleMalformed",
  "IssuerConfigMalformed",
  "ProviderRegistryMalformed",
  "CanonicalEncodingInvalid",
  "DigestMismatch",
  "HighWaterMissing",
  "HighWaterUnreadable",
  "HighWaterCorrupt",
  "RevisionRollback",
  "RevisionReuseMismatch",
  "SourceReenrollmentRequired",
  "HighWaterCommitFailed",
];

const exactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
): boolean =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
const safePositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const digest = (value: unknown): value is string =>
  typeof value === "string" && digestPattern.test(value);
const canonicalId = (value: unknown): value is string =>
  typeof value === "string" &&
  value === value.trim() &&
  canonicalIdPattern.test(value);
const sortedUnique = (values: ReadonlyArray<string>): boolean =>
  values.every(
    (value, index) =>
      index === 0 || compareUtf8BytesV1(values[index - 1] ?? "", value) < 0,
  );
const canonicalInstant = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;

const encodeLimitsV1 = (limits: SandboxOperatorLimitsV1): string =>
  `{"wallTimeMs":${limits.wallTimeMs},"stdoutBytes":${limits.stdoutBytes},"stderrBytes":${limits.stderrBytes},"processCount":${limits.processCount},"memoryBytes":${limits.memoryBytes},"cpuTimeMs":${limits.cpuTimeMs}}`;

const decodeLimitsV1 = (
  input: unknown,
): SandboxOperatorLimitsV1 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const limits = input as Record<string, unknown>;
  const keys = [
    "wallTimeMs",
    "stdoutBytes",
    "stderrBytes",
    "processCount",
    "memoryBytes",
    "cpuTimeMs",
  ];
  if (
    !exactKeys(limits, keys) ||
    !keys.every((key) => safePositive(limits[key]))
  )
    return undefined;
  return limits as unknown as SandboxOperatorLimitsV1;
};

export const decodeSandboxOperatorPolicyConfigV1 = (
  input: unknown,
  allowedEnvironmentNames: ReadonlyArray<string>,
): SandboxOperatorPolicyConfigV1 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  if (
    !exactKeys(value, [
      "version",
      "revision",
      "environmentAllowlist",
      "limitsByProfile",
      "trustedLocalRuntimeVersion",
    ]) ||
    value.version !== 1 ||
    !safePositive(value.revision) ||
    value.trustedLocalRuntimeVersion !== "builtin-v1" ||
    !Array.isArray(value.environmentAllowlist) ||
    !Array.isArray(value.limitsByProfile)
  )
    return undefined;
  const environmentAllowlist = value.environmentAllowlist;
  if (
    !environmentAllowlist.every(
      (name) =>
        typeof name === "string" &&
        envNamePattern.test(name) &&
        allowedEnvironmentNames.includes(name),
    ) ||
    !sortedUnique(environmentAllowlist as ReadonlyArray<string>)
  )
    return undefined;
  if (value.limitsByProfile.length !== profiles.length) return undefined;
  const limitsByProfile: SandboxOperatorProfileLimitsV1[] = [];
  for (const [index, rawEntry] of value.limitsByProfile.entries()) {
    if (
      typeof rawEntry !== "object" ||
      rawEntry === null ||
      Array.isArray(rawEntry)
    )
      return undefined;
    const entry = rawEntry as Record<string, unknown>;
    const profile = profiles[index];
    const limits = decodeLimitsV1(entry.limits);
    if (
      !exactKeys(entry, ["profile", "limits"]) ||
      entry.profile !== profile ||
      profile === undefined ||
      limits === undefined
    )
      return undefined;
    limitsByProfile.push({ profile, limits });
  }
  return {
    version: 1,
    revision: value.revision,
    environmentAllowlist: environmentAllowlist as ReadonlyArray<string>,
    limitsByProfile,
    trustedLocalRuntimeVersion: "builtin-v1",
  };
};

export const encodeSandboxOperatorPolicyConfigV1 = (
  config: SandboxOperatorPolicyConfigV1,
): string =>
  `{"version":1,"revision":${config.revision},"environmentAllowlist":[${config.environmentAllowlist.map((name) => JSON.stringify(name)).join(",")}],"limitsByProfile":[${config.limitsByProfile.map((entry) => `{"profile":${JSON.stringify(entry.profile)},"limits":${encodeLimitsV1(entry.limits)}}`).join(",")}],"trustedLocalRuntimeVersion":"builtin-v1"}`;

export const decodeCanonicalSandboxOperatorPolicyConfigV1 = (
  json: string,
  allowedEnvironmentNames: ReadonlyArray<string>,
): SandboxOperatorPolicyConfigV1 | undefined => {
  try {
    const decoded = decodeSandboxOperatorPolicyConfigV1(
      JSON.parse(json),
      allowedEnvironmentNames,
    );
    return decoded !== undefined &&
      encodeSandboxOperatorPolicyConfigV1(decoded) === json
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
};

const providerTuple = (entry: SandboxProviderQualificationEntryV1) =>
  [
    entry.providerId,
    entry.providerVersion,
    entry.capabilityRevision,
    entry.osFamily,
    entry.osBuild,
    entry.tuple.profile,
    entry.tuple.networkMode,
    entry.tuple.networkPolicyCodecVersion,
    entry.tuple.enforcementRuleSetDigest,
  ] as const;

const compareProviderTuple = (
  left: ReturnType<typeof providerTuple>,
  right: ReturnType<typeof providerTuple>,
): number => {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    const difference =
      typeof a === "number" && typeof b === "number"
        ? a - b
        : compareUtf8BytesV1(String(a), String(b));
    if (difference !== 0) return difference;
  }
  return 0;
};

export const decodeSandboxProviderQualificationRegistryV1 = (
  input: unknown,
): SandboxProviderQualificationRegistryV1 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const registry = input as Record<string, unknown>;
  if (
    !exactKeys(registry, ["version", "revision", "entries"]) ||
    registry.version !== 1 ||
    !safePositive(registry.revision) ||
    !Array.isArray(registry.entries)
  )
    return undefined;
  const entries: SandboxProviderQualificationEntryV1[] = [];
  for (const rawEntry of registry.entries) {
    if (
      typeof rawEntry !== "object" ||
      rawEntry === null ||
      Array.isArray(rawEntry)
    )
      return undefined;
    const entry = rawEntry as Record<string, unknown>;
    if (
      !exactKeys(entry, [
        "providerId",
        "providerVersion",
        "capabilityRevision",
        "osFamily",
        "osBuild",
        "tuple",
        "status",
        "qualificationEvidenceRef",
      ]) ||
      !canonicalId(entry.providerId) ||
      !canonicalId(entry.providerVersion) ||
      !safePositive(entry.capabilityRevision) ||
      !osFamilies.includes(entry.osFamily as (typeof osFamilies)[number]) ||
      !canonicalId(entry.osBuild) ||
      !statuses.includes(entry.status as (typeof statuses)[number])
    )
      return undefined;
    if (
      typeof entry.tuple !== "object" ||
      entry.tuple === null ||
      Array.isArray(entry.tuple)
    )
      return undefined;
    const tuple = entry.tuple as Record<string, unknown>;
    if (
      !exactKeys(tuple, [
        "profile",
        "networkMode",
        "networkPolicyCodecVersion",
        "enforcementRuleSetDigest",
      ]) ||
      (tuple.profile !== "ReadOnly" && tuple.profile !== "WorkspaceWrite") ||
      !networkModes.includes(tuple.networkMode as SandboxNetworkModeV1) ||
      tuple.networkPolicyCodecVersion !== 1 ||
      !digest(tuple.enforcementRuleSetDigest)
    )
      return undefined;
    const evidence = entry.qualificationEvidenceRef;
    if (
      evidence !== null &&
      (typeof evidence !== "string" ||
        !/^blob:sha256:[0-9a-f]{64}$/u.test(evidence))
    )
      return undefined;
    if (entry.status === "Supported" && evidence === null) return undefined;
    entries.push({
      providerId: entry.providerId,
      providerVersion: entry.providerVersion,
      capabilityRevision: entry.capabilityRevision,
      osFamily:
        entry.osFamily as SandboxProviderQualificationEntryV1["osFamily"],
      osBuild: entry.osBuild,
      tuple: {
        profile:
          tuple.profile as SandboxProviderQualificationEntryV1["tuple"]["profile"],
        networkMode:
          tuple.networkMode as SandboxProviderQualificationEntryV1["tuple"]["networkMode"],
        networkPolicyCodecVersion: 1,
        enforcementRuleSetDigest: tuple.enforcementRuleSetDigest,
      },
      status: entry.status as SandboxProviderQualificationEntryV1["status"],
      qualificationEvidenceRef: evidence as string | null,
    });
  }
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareProviderTuple(providerTuple(previous), providerTuple(current)) >= 0
    )
      return undefined;
  }
  return { version: 1, revision: registry.revision, entries };
};

export const encodeSandboxProviderQualificationRegistryV1 = (
  registry: SandboxProviderQualificationRegistryV1,
): string =>
  `{"version":1,"revision":${registry.revision},"entries":[${registry.entries.map((entry) => `{"providerId":${JSON.stringify(entry.providerId)},"providerVersion":${JSON.stringify(entry.providerVersion)},"capabilityRevision":${entry.capabilityRevision},"osFamily":${JSON.stringify(entry.osFamily)},"osBuild":${JSON.stringify(entry.osBuild)},"tuple":{"profile":${JSON.stringify(entry.tuple.profile)},"networkMode":${JSON.stringify(entry.tuple.networkMode)},"networkPolicyCodecVersion":1,"enforcementRuleSetDigest":${JSON.stringify(entry.tuple.enforcementRuleSetDigest)}},"status":${JSON.stringify(entry.status)},"qualificationEvidenceRef":${JSON.stringify(entry.qualificationEvidenceRef)}}`).join(",")}]}`;

export const encodeSandboxAuthorityBundleV2 = (
  bundle: SandboxAuthorityBundleV2,
): string => {
  const issuer = encodeSandboxPolicyGrantIssuerConfigV1(bundle.issuerConfig);
  const operator = encodeSandboxOperatorPolicyConfigV1(bundle.operatorConfig);
  const registry = encodeSandboxProviderQualificationRegistryV1(
    bundle.providerRegistry,
  );
  return `{"version":2,"sourceIdentity":${JSON.stringify(bundle.sourceIdentity)},"bundleRevision":${bundle.bundleRevision},"issuerConfigRevision":${bundle.issuerConfigRevision},"issuerConfigDigest":${JSON.stringify(bundle.issuerConfigDigest)},"issuerConfig":${issuer},"operatorConfigRevision":${bundle.operatorConfigRevision},"operatorConfigDigest":${JSON.stringify(bundle.operatorConfigDigest)},"operatorConfig":${operator},"providerRegistryRevision":${bundle.providerRegistryRevision},"providerRegistryDigest":${JSON.stringify(bundle.providerRegistryDigest)},"providerRegistry":${registry}}`;
};

export const decodeCanonicalSandboxAuthorityBundleV2 = (
  json: string,
  allowedEnvironmentNames: ReadonlyArray<string>,
  sha256Hex: Sha256Hex,
): SandboxAuthorityBundleSnapshotV2 | undefined => {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return undefined;
    const row = value as Record<string, unknown>;
    if (
      !exactKeys(row, [
        "version",
        "sourceIdentity",
        "bundleRevision",
        "issuerConfigRevision",
        "issuerConfigDigest",
        "issuerConfig",
        "operatorConfigRevision",
        "operatorConfigDigest",
        "operatorConfig",
        "providerRegistryRevision",
        "providerRegistryDigest",
        "providerRegistry",
      ]) ||
      row.version !== 2 ||
      !canonicalId(row.sourceIdentity) ||
      !safePositive(row.bundleRevision) ||
      !safePositive(row.issuerConfigRevision) ||
      !digest(row.issuerConfigDigest) ||
      !safePositive(row.operatorConfigRevision) ||
      !digest(row.operatorConfigDigest) ||
      !safePositive(row.providerRegistryRevision) ||
      !digest(row.providerRegistryDigest)
    )
      return undefined;
    const issuerJson = JSON.stringify(row.issuerConfig);
    const issuerConfig =
      decodeCanonicalSandboxPolicyGrantIssuerConfigV1(issuerJson);
    const operatorJson = JSON.stringify(row.operatorConfig);
    const operatorConfig = decodeCanonicalSandboxOperatorPolicyConfigV1(
      operatorJson,
      allowedEnvironmentNames,
    );
    const registryJson = JSON.stringify(row.providerRegistry);
    const providerRegistry = decodeSandboxProviderQualificationRegistryV1(
      row.providerRegistry,
    );
    if (
      issuerConfig === undefined ||
      operatorConfig === undefined ||
      providerRegistry === undefined ||
      issuerConfig.revision !== row.issuerConfigRevision ||
      operatorConfig.revision !== row.operatorConfigRevision ||
      providerRegistry.revision !== row.providerRegistryRevision ||
      encodeSandboxPolicyGrantIssuerConfigV1(issuerConfig) !== issuerJson ||
      encodeSandboxOperatorPolicyConfigV1(operatorConfig) !== operatorJson ||
      encodeSandboxProviderQualificationRegistryV1(providerRegistry) !==
        registryJson ||
      sha256Hex(issuerJson) !== row.issuerConfigDigest ||
      sha256Hex(operatorJson) !== row.operatorConfigDigest ||
      sha256Hex(registryJson) !== row.providerRegistryDigest
    )
      return undefined;
    const bundle: SandboxAuthorityBundleV2 = {
      version: 2,
      sourceIdentity: row.sourceIdentity,
      bundleRevision: row.bundleRevision,
      issuerConfigRevision: row.issuerConfigRevision,
      issuerConfigDigest: row.issuerConfigDigest,
      issuerConfig,
      operatorConfigRevision: row.operatorConfigRevision,
      operatorConfigDigest: row.operatorConfigDigest,
      operatorConfig,
      providerRegistryRevision: row.providerRegistryRevision,
      providerRegistryDigest: row.providerRegistryDigest,
      providerRegistry,
    };
    const canonicalJson = encodeSandboxAuthorityBundleV2(bundle);
    if (canonicalJson !== json) return undefined;
    return { bundle, canonicalJson, bundleDigest: sha256Hex(canonicalJson) };
  } catch {
    return undefined;
  }
};

export const encodeSandboxAuthorityHighWaterV2 = (
  value: SandboxAuthorityHighWaterV2,
): string =>
  `{"version":2,"sourceIdentity":${JSON.stringify(value.sourceIdentity)},"bundleRevision":${value.bundleRevision},"bundleDigest":${JSON.stringify(value.bundleDigest)},"issuerConfigRevision":${value.issuerConfigRevision},"issuerConfigDigest":${JSON.stringify(value.issuerConfigDigest)},"operatorConfigRevision":${value.operatorConfigRevision},"operatorConfigDigest":${JSON.stringify(value.operatorConfigDigest)},"providerRegistryRevision":${value.providerRegistryRevision},"providerRegistryDigest":${JSON.stringify(value.providerRegistryDigest)}}`;

export const decodeCanonicalSandboxAuthorityHighWaterV2 = (
  json: string,
): SandboxAuthorityHighWaterV2 | undefined => {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return undefined;
    const row = value as Record<string, unknown>;
    if (
      !exactKeys(row, [
        "version",
        "sourceIdentity",
        "bundleRevision",
        "bundleDigest",
        "issuerConfigRevision",
        "issuerConfigDigest",
        "operatorConfigRevision",
        "operatorConfigDigest",
        "providerRegistryRevision",
        "providerRegistryDigest",
      ]) ||
      row.version !== 2 ||
      !canonicalId(row.sourceIdentity) ||
      !safePositive(row.bundleRevision) ||
      !digest(row.bundleDigest) ||
      !safePositive(row.issuerConfigRevision) ||
      !digest(row.issuerConfigDigest) ||
      !safePositive(row.operatorConfigRevision) ||
      !digest(row.operatorConfigDigest) ||
      !safePositive(row.providerRegistryRevision) ||
      !digest(row.providerRegistryDigest)
    )
      return undefined;
    const decoded = row as unknown as SandboxAuthorityHighWaterV2;
    return encodeSandboxAuthorityHighWaterV2(decoded) === json
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
};

export const encodeSandboxAuthorityAuditRecordV2 = (
  value: SandboxAuthorityAuditRecordV2,
): string =>
  `{"version":2,"outcome":${JSON.stringify(value.outcome)},"detail":${JSON.stringify(value.detail)},"sourceIdentity":${JSON.stringify(value.sourceIdentity)},"bundleRevision":${JSON.stringify(value.bundleRevision)},"bundleDigest":${JSON.stringify(value.bundleDigest)},"issuerConfigRevision":${JSON.stringify(value.issuerConfigRevision)},"issuerConfigDigest":${JSON.stringify(value.issuerConfigDigest)},"operatorConfigRevision":${JSON.stringify(value.operatorConfigRevision)},"operatorConfigDigest":${JSON.stringify(value.operatorConfigDigest)},"providerRegistryRevision":${JSON.stringify(value.providerRegistryRevision)},"providerRegistryDigest":${JSON.stringify(value.providerRegistryDigest)},"occurredAt":${JSON.stringify(value.occurredAt)}}`;

export const decodeCanonicalSandboxAuthorityAuditRecordV2 = (
  json: string,
): SandboxAuthorityAuditRecordV2 | undefined => {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return undefined;
    const row = value as Record<string, unknown>;
    const keys = [
      "version",
      "outcome",
      "detail",
      "sourceIdentity",
      "bundleRevision",
      "bundleDigest",
      "issuerConfigRevision",
      "issuerConfigDigest",
      "operatorConfigRevision",
      "operatorConfigDigest",
      "providerRegistryRevision",
      "providerRegistryDigest",
      "occurredAt",
    ];
    if (
      !exactKeys(row, keys) ||
      row.version !== 2 ||
      !outcomes.includes(row.outcome as SandboxAuthorityAuditOutcomeV1) ||
      (row.detail !== null &&
        !loadErrors.includes(row.detail as SandboxAuthorityLoadErrorV1)) ||
      (row.sourceIdentity !== null && !canonicalId(row.sourceIdentity)) ||
      (row.bundleRevision !== null && !safePositive(row.bundleRevision)) ||
      (row.bundleDigest !== null && !digest(row.bundleDigest)) ||
      (row.issuerConfigRevision !== null &&
        !safePositive(row.issuerConfigRevision)) ||
      (row.issuerConfigDigest !== null && !digest(row.issuerConfigDigest)) ||
      (row.operatorConfigRevision !== null &&
        !safePositive(row.operatorConfigRevision)) ||
      (row.operatorConfigDigest !== null &&
        !digest(row.operatorConfigDigest)) ||
      (row.providerRegistryRevision !== null &&
        !safePositive(row.providerRegistryRevision)) ||
      (row.providerRegistryDigest !== null &&
        !digest(row.providerRegistryDigest)) ||
      !canonicalInstant(row.occurredAt)
    )
      return undefined;
    const decoded = row as unknown as SandboxAuthorityAuditRecordV2;
    return encodeSandboxAuthorityAuditRecordV2(decoded) === json
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
};
