import type { WorkspaceId } from "./ids.js";
import type { CanonicalResourceRegion } from "./resources.js";
import { canonicalRegionString } from "./resources.js";
import { encodeNetworkPolicyV1 } from "./sandbox-policy.js";
import type { SandboxPolicyLimitsV1 } from "./sandbox-policy-result.js";

export type Sha256Hex = (canonicalUtf8Bytes: string) => string;
export type SandboxResourceSpaceV1 = "filesystem" | "database" | "external";

export interface SandboxTargetRefV1 {
  readonly version: 1;
  readonly kind: "RegionDigest";
  readonly resourceSpace: SandboxResourceSpaceV1;
  readonly regionIdentityDigest: string;
}

export interface SandboxPolicyMountV1 {
  readonly mountId: string;
  readonly targetRef: SandboxTargetRefV1;
  readonly targetIdentityDigest: string;
  readonly access: "ReadOnly" | "ReadWrite";
}

export type SandboxNetworkBrokerControlsV1 =
  | {
      readonly version: 1;
      readonly mode: "Disabled";
      readonly directNetwork: "Denied";
      readonly broker: "Disabled";
    }
  | {
      readonly version: 1;
      readonly mode: "Restricted" | "Enabled";
      readonly brokerProtocolVersion: 1;
      readonly directNetwork: "Denied";
      readonly dns: "BrokerOnly";
      readonly pref64: "FreshPerResolutionAndConnection";
      readonly ipPinning: "AllAnswersPublicPerConnection";
      readonly redirectMaxHops: 5;
      readonly tlsIdentity: "ExactSniHostCertificate";
      readonly rawIp: "Denied";
      readonly udp: "Denied";
      readonly specialUse: "Denied";
    };

export type SandboxNetworkModeV1 = "Disabled" | "Restricted" | "Enabled";

export interface ResourceBoundaryDigestInputV1 {
  readonly version: 1;
  readonly basisResponsibilityRevision: number;
  readonly regions: ReadonlyArray<string>;
}

export interface OsEnforcedSandboxEnvironmentBasisV1 {
  readonly version: 1;
  readonly kind: "OsEnforced";
  readonly workspaceId: WorkspaceId;
  readonly resourceBoundaryRevision: number;
  readonly mounts: ReadonlyArray<SandboxPolicyMountV1>;
  readonly environmentAllowlist: ReadonlyArray<string>;
  readonly limits: SandboxPolicyLimitsV1;
  readonly authorityBundleRevision: number;
  readonly authorityBundleDigest: string;
  readonly providerRegistryRevision: number;
  readonly providerRegistryDigest: string;
  readonly qualificationEvidenceRef: string;
}

export interface TrustedLocalSandboxEnvironmentBasisV1 {
  readonly version: 1;
  readonly kind: "TrustedLocalUnconfinedV1";
  readonly workspaceId: WorkspaceId;
  readonly resourceBoundaryRevision: number;
  readonly mounts: ReadonlyArray<SandboxPolicyMountV1>;
  readonly environmentAllowlist: ReadonlyArray<string>;
  readonly limits: SandboxPolicyLimitsV1;
  readonly authorityBundleRevision: number;
  readonly authorityBundleDigest: string;
  readonly operatorConfigRevision: number;
  readonly operatorConfigDigest: string;
  readonly trustedRuntimeVersion: "builtin-v1";
}

export type SandboxEnvironmentBasisV1 =
  | OsEnforcedSandboxEnvironmentBasisV1
  | TrustedLocalSandboxEnvironmentBasisV1;

const digestPattern = /^[0-9a-f]{64}$/u;
const sourceSpaceValues = new Set<SandboxResourceSpaceV1>([
  "filesystem",
  "database",
  "external",
]);

const exactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
): boolean =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));

/** UTF-8 byte ordering is equivalent to Unicode scalar ordering for valid
 * strings. Reject lone surrogates so JavaScript replacement encoding cannot
 * make two distinct source strings share the same UTF-8 preimage. */
export const compareUtf8BytesV1 = (left: string, right: string): number => {
  const a = Array.from(left, (character) => character.codePointAt(0) ?? -1);
  const b = Array.from(right, (character) => character.codePointAt(0) ?? -1);
  const count = Math.min(a.length, b.length);
  for (let index = 0; index < count; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
};

const hasOnlyScalarValues = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const sortedUnique = (values: ReadonlyArray<string>): boolean =>
  values.every(
    (value, index) =>
      hasOnlyScalarValues(value) &&
      (index === 0 || compareUtf8BytesV1(values[index - 1] ?? "", value) < 0),
  );

const nonnegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const encodeSandboxTargetRefV1 = (value: SandboxTargetRefV1): string =>
  `{"version":1,"kind":"RegionDigest","resourceSpace":${JSON.stringify(value.resourceSpace)},"regionIdentityDigest":${JSON.stringify(value.regionIdentityDigest)}}`;

export const decodeSandboxTargetRefV1 = (
  input: unknown,
): SandboxTargetRefV1 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  if (
    !exactKeys(value, [
      "version",
      "kind",
      "resourceSpace",
      "regionIdentityDigest",
    ]) ||
    value.version !== 1 ||
    value.kind !== "RegionDigest" ||
    typeof value.resourceSpace !== "string" ||
    !sourceSpaceValues.has(value.resourceSpace as SandboxResourceSpaceV1) ||
    typeof value.regionIdentityDigest !== "string" ||
    !digestPattern.test(value.regionIdentityDigest)
  )
    return undefined;
  return {
    version: 1,
    kind: "RegionDigest",
    resourceSpace: value.resourceSpace as SandboxResourceSpaceV1,
    regionIdentityDigest: value.regionIdentityDigest,
  };
};

export const decodeCanonicalSandboxTargetRefV1 = (
  json: string,
): SandboxTargetRefV1 | undefined => {
  try {
    const decoded = decodeSandboxTargetRefV1(JSON.parse(json));
    return decoded !== undefined && encodeSandboxTargetRefV1(decoded) === json
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
};

export const sandboxTargetRefOfRegionV1 = (
  region: CanonicalResourceRegion,
  sha256Hex: Sha256Hex,
): SandboxTargetRefV1 | undefined => {
  if (!sourceSpaceValues.has(region.resourceSpaceId as SandboxResourceSpaceV1))
    return undefined;
  const regionIdentityDigest = sha256Hex(canonicalRegionString(region));
  if (!digestPattern.test(regionIdentityDigest)) return undefined;
  return {
    version: 1,
    kind: "RegionDigest",
    resourceSpace: region.resourceSpaceId as SandboxResourceSpaceV1,
    regionIdentityDigest,
  };
};

export const targetRefDigestV1 = (
  targetRef: SandboxTargetRefV1,
  sha256Hex: Sha256Hex,
): string => sha256Hex(encodeSandboxTargetRefV1(targetRef));

export const canonicalRegionStringsV1 = (
  regions: ReadonlyArray<CanonicalResourceRegion>,
): ReadonlyArray<string> =>
  [...new Set(regions.map(canonicalRegionString))].sort(compareUtf8BytesV1);

export const encodeResourceBoundaryDigestInputV1 = (
  input: ResourceBoundaryDigestInputV1,
): string =>
  `{"version":1,"basisResponsibilityRevision":${input.basisResponsibilityRevision},"regions":[${input.regions.map((region) => JSON.stringify(region)).join(",")}]}`;

export const resourceBoundaryDigestOfV1 = (
  basisResponsibilityRevision: number,
  canonicalRegions: ReadonlyArray<string>,
  sha256Hex: Sha256Hex,
): string | undefined => {
  if (!nonnegativeSafeInteger(basisResponsibilityRevision)) return undefined;
  const regions = [...new Set(canonicalRegions)].sort(compareUtf8BytesV1);
  if (!regions.every((region) => isCanonicalRegionStringV1(region)))
    return undefined;
  return sha256Hex(
    encodeResourceBoundaryDigestInputV1({
      version: 1,
      basisResponsibilityRevision,
      regions,
    }),
  );
};

export const resourceBoundaryDigestFromRegionsV1 = (
  basisResponsibilityRevision: number,
  regions: ReadonlyArray<CanonicalResourceRegion>,
  sha256Hex: Sha256Hex,
): string | undefined =>
  resourceBoundaryDigestOfV1(
    basisResponsibilityRevision,
    canonicalRegionStringsV1(regions),
    sha256Hex,
  );

const isCanonicalRegionStringV1 = (value: unknown): value is string => {
  if (typeof value !== "string" || !hasOnlyScalarValues(value)) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return false;
    const row = parsed as Record<string, unknown>;
    if (typeof row.resourceSpaceId !== "string" || typeof row.kind !== "string")
      return false;
    const normalizedRegion =
      row.kind === "FileTree"
        ? { kind: "FileTree", path: row.path }
        : row.kind === "DatabaseNamespace"
          ? { kind: "DatabaseNamespace", namespace: row.namespace }
          : row.kind === "ExternalResource"
            ? { kind: "ExternalResource", address: row.address }
            : undefined;
    if (normalizedRegion === undefined) return false;
    const expectedKeys =
      row.kind === "FileTree"
        ? ["resourceSpaceId", "kind", "path"]
        : row.kind === "DatabaseNamespace"
          ? ["resourceSpaceId", "kind", "namespace"]
          : ["resourceSpaceId", "kind", "address"];
    return (
      exactKeys(row, expectedKeys) &&
      canonicalRegionString({
        resourceSpaceId: row.resourceSpaceId,
        normalizedRegion,
      } as CanonicalResourceRegion) === value
    );
  } catch {
    return false;
  }
};

export const decodeResourceBoundaryDigestInputV1 = (
  input: unknown,
): ResourceBoundaryDigestInputV1 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  if (
    !exactKeys(value, ["version", "basisResponsibilityRevision", "regions"]) ||
    value.version !== 1 ||
    !nonnegativeSafeInteger(value.basisResponsibilityRevision) ||
    !Array.isArray(value.regions) ||
    !value.regions.every(isCanonicalRegionStringV1) ||
    !sortedUnique(value.regions as ReadonlyArray<string>)
  )
    return undefined;
  return {
    version: 1,
    basisResponsibilityRevision: value.basisResponsibilityRevision,
    regions: value.regions as ReadonlyArray<string>,
  };
};

export const decodeCanonicalResourceBoundaryDigestInputV1 = (
  json: string,
): ResourceBoundaryDigestInputV1 | undefined => {
  try {
    const decoded = decodeResourceBoundaryDigestInputV1(JSON.parse(json));
    return decoded !== undefined &&
      encodeResourceBoundaryDigestInputV1(decoded) === json
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
};

export const deriveSandboxMountIdV1 = (
  targetRef: SandboxTargetRefV1,
  primaryManagedGitWorktree: boolean,
): string =>
  primaryManagedGitWorktree
    ? "workspace"
    : `resource-${targetRef.regionIdentityDigest}`;

export const encodeTargetIdentityInputV1 = (input: {
  readonly workspaceId: WorkspaceId;
  readonly mountId: string;
  readonly targetRef: SandboxTargetRefV1;
  readonly resourceBoundaryRevision: number;
  readonly access: "ReadOnly" | "ReadWrite";
}): string =>
  `{"version":1,"workspaceId":${JSON.stringify(input.workspaceId)},"mountId":${JSON.stringify(input.mountId)},"targetRef":${encodeSandboxTargetRefV1(input.targetRef)},"resourceBoundaryRevision":${input.resourceBoundaryRevision},"access":${JSON.stringify(input.access)}}`;

export const targetIdentityDigestOfV1 = (
  input: Parameters<typeof encodeTargetIdentityInputV1>[0],
  sha256Hex: Sha256Hex,
): string => sha256Hex(encodeTargetIdentityInputV1(input));

const encodeMountV1 = (mount: SandboxPolicyMountV1): string =>
  `{"mountId":${JSON.stringify(mount.mountId)},"targetRef":${encodeSandboxTargetRefV1(mount.targetRef)},"targetIdentityDigest":${JSON.stringify(mount.targetIdentityDigest)},"access":${JSON.stringify(mount.access)}}`;

export const canonicalSandboxMountsV1 = (
  mounts: ReadonlyArray<SandboxPolicyMountV1>,
): ReadonlyArray<SandboxPolicyMountV1> =>
  [...mounts].sort((left, right) =>
    compareUtf8BytesV1(left.mountId, right.mountId),
  );

export const encodeSandboxHandleBindingInputV1 = (input: {
  readonly workspaceId: WorkspaceId;
  readonly mounts: ReadonlyArray<SandboxPolicyMountV1>;
  readonly resourceBoundaryRevision: number;
}): string =>
  `{"version":1,"workspaceId":${JSON.stringify(input.workspaceId)},"mounts":[${canonicalSandboxMountsV1(input.mounts).map(encodeMountV1).join(",")}],"resourceBoundaryRevision":${input.resourceBoundaryRevision}}`;

export const sandboxHandleBindingDigestOfV1 = (
  input: Parameters<typeof encodeSandboxHandleBindingInputV1>[0],
  sha256Hex: Sha256Hex,
): string => sha256Hex(encodeSandboxHandleBindingInputV1(input));

export const encodeNetworkBrokerControlsV1 = (
  controls: SandboxNetworkBrokerControlsV1,
): string =>
  controls.mode === "Disabled"
    ? `{"version":1,"mode":"Disabled","directNetwork":"Denied","broker":"Disabled"}`
    : `{"version":1,"mode":${JSON.stringify(controls.mode)},"brokerProtocolVersion":1,"directNetwork":"Denied","dns":"BrokerOnly","pref64":"FreshPerResolutionAndConnection","ipPinning":"AllAnswersPublicPerConnection","redirectMaxHops":5,"tlsIdentity":"ExactSniHostCertificate","rawIp":"Denied","udp":"Denied","specialUse":"Denied"}`;

export const networkBrokerControlsV1ForMode = (
  mode: SandboxNetworkModeV1,
): SandboxNetworkBrokerControlsV1 =>
  mode === "Disabled"
    ? {
        version: 1,
        mode: "Disabled",
        directNetwork: "Denied",
        broker: "Disabled",
      }
    : {
        version: 1,
        mode,
        brokerProtocolVersion: 1,
        directNetwork: "Denied",
        dns: "BrokerOnly",
        pref64: "FreshPerResolutionAndConnection",
        ipPinning: "AllAnswersPublicPerConnection",
        redirectMaxHops: 5,
        tlsIdentity: "ExactSniHostCertificate",
        rawIp: "Denied",
        udp: "Denied",
        specialUse: "Denied",
      };

export const decodeNetworkBrokerControlsV1 = (
  input: unknown,
): SandboxNetworkBrokerControlsV1 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  if (value.mode === "Disabled") {
    const expected: SandboxNetworkBrokerControlsV1 = {
      version: 1,
      mode: "Disabled",
      directNetwork: "Denied",
      broker: "Disabled",
    };
    return exactKeys(value, Object.keys(expected)) &&
      Object.entries(expected).every(([key, item]) => value[key] === item)
      ? expected
      : undefined;
  }
  if (value.mode !== "Restricted" && value.mode !== "Enabled") return undefined;
  const expected = networkBrokerControlsV1ForMode(value.mode);
  return exactKeys(value, Object.keys(expected)) &&
    Object.entries(expected).every(([key, item]) => value[key] === item)
    ? expected
    : undefined;
};

export const encodeSandboxEnvironmentBasisV1 = (
  basis: SandboxEnvironmentBasisV1,
): string => {
  const mounts = canonicalSandboxMountsV1(basis.mounts);
  const environment = [...basis.environmentAllowlist].sort(compareUtf8BytesV1);
  const limits = basis.limits;
  const common = `"version":1,"kind":${JSON.stringify(basis.kind)},"workspaceId":${JSON.stringify(basis.workspaceId)},"resourceBoundaryRevision":${basis.resourceBoundaryRevision},"mounts":[${mounts.map(encodeMountV1).join(",")}],"environmentAllowlist":[${environment.map((name) => JSON.stringify(name)).join(",")}],"limits":{"wallTimeMs":${limits.wallTimeMs},"stdoutBytes":${limits.stdoutBytes},"stderrBytes":${limits.stderrBytes},"processCount":${limits.processCount},"memoryBytes":${limits.memoryBytes},"cpuTimeMs":${limits.cpuTimeMs}},"authorityBundleRevision":${basis.authorityBundleRevision},"authorityBundleDigest":${JSON.stringify(basis.authorityBundleDigest)}`;
  return basis.kind === "OsEnforced"
    ? `{${common},"providerRegistryRevision":${basis.providerRegistryRevision},"providerRegistryDigest":${JSON.stringify(basis.providerRegistryDigest)},"qualificationEvidenceRef":${JSON.stringify(basis.qualificationEvidenceRef)}}`
    : `{${common},"operatorConfigRevision":${basis.operatorConfigRevision},"operatorConfigDigest":${JSON.stringify(basis.operatorConfigDigest)},"trustedRuntimeVersion":"builtin-v1"}`;
};

export const sandboxEnvironmentBasisDigestOfV1 = (
  basis: SandboxEnvironmentBasisV1,
  sha256Hex: Sha256Hex,
): string => sha256Hex(encodeSandboxEnvironmentBasisV1(basis));

export const networkPolicyDigestV1 = (
  policy: import("./sandbox-policy.js").NetworkPolicyV1,
  sha256Hex: Sha256Hex,
): string => sha256Hex(encodeNetworkPolicyV1(policy));
