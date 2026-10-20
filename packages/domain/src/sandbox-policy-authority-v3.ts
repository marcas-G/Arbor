import { encodeSandboxPolicyGrantIssuerConfigV1 } from "./sandbox-policy.js";
import {
  decodeCanonicalSandboxAuthorityBundleV2,
  encodeSandboxOperatorPolicyConfigV1,
  encodeSandboxProviderQualificationRegistryV1,
  type SandboxAuthorityBundleV2,
} from "./sandbox-policy-authority-v2.js";
import type { Sha256Hex } from "./sandbox-policy-producers.js";
import {
  decodeCanonicalWindowsNativeOperatorTrustSetV1,
  encodeWindowsNativeOperatorTrustSetV1,
  type Sha256BytesHex,
  type WindowsNativeOperatorTrustSetV1,
} from "./windows-operator-trust-v1.js";

export interface SandboxAuthorityBundleV3
  extends Omit<SandboxAuthorityBundleV2, "version"> {
  readonly version: 3;
  readonly windowsOperatorTrustSetRevision: number;
  readonly windowsOperatorTrustSetDigest: string;
  readonly windowsOperatorTrustSet: WindowsNativeOperatorTrustSetV1;
}

export interface SandboxAuthorityBundleSnapshotV3 {
  readonly bundle: SandboxAuthorityBundleV3;
  readonly bundleDigest: string;
  readonly canonicalJson: string;
}

export interface SandboxAuthorityHighWaterV3 {
  readonly version: 3;
  readonly sourceIdentity: string;
  readonly bundleRevision: number;
  readonly bundleDigest: string;
  readonly issuerConfigRevision: number;
  readonly issuerConfigDigest: string;
  readonly operatorConfigRevision: number;
  readonly operatorConfigDigest: string;
  readonly providerRegistryRevision: number;
  readonly providerRegistryDigest: string;
  readonly windowsOperatorTrustSetRevision: number;
  readonly windowsOperatorTrustSetDigest: string;
}

const exactKeys = (
  value: Record<string, unknown>,
  keys: ReadonlyArray<string>,
) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const canonicalId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);

export const encodeSandboxAuthorityBundleV3 = (
  bundle: SandboxAuthorityBundleV3,
): string =>
  `{"version":3,"sourceIdentity":${JSON.stringify(bundle.sourceIdentity)},"bundleRevision":${bundle.bundleRevision},"issuerConfigRevision":${bundle.issuerConfigRevision},"issuerConfigDigest":${JSON.stringify(bundle.issuerConfigDigest)},"issuerConfig":${encodeSandboxPolicyGrantIssuerConfigV1(bundle.issuerConfig)},"operatorConfigRevision":${bundle.operatorConfigRevision},"operatorConfigDigest":${JSON.stringify(bundle.operatorConfigDigest)},"operatorConfig":${encodeSandboxOperatorPolicyConfigV1(bundle.operatorConfig)},"providerRegistryRevision":${bundle.providerRegistryRevision},"providerRegistryDigest":${JSON.stringify(bundle.providerRegistryDigest)},"providerRegistry":${encodeSandboxProviderQualificationRegistryV1(bundle.providerRegistry)},"windowsOperatorTrustSetRevision":${bundle.windowsOperatorTrustSetRevision},"windowsOperatorTrustSetDigest":${JSON.stringify(bundle.windowsOperatorTrustSetDigest)},"windowsOperatorTrustSet":${encodeWindowsNativeOperatorTrustSetV1(bundle.windowsOperatorTrustSet)}}`;

export const decodeCanonicalSandboxAuthorityBundleV3 = (
  json: string,
  allowedEnvironmentNames: ReadonlyArray<string>,
  sha256Hex: Sha256Hex,
  sha256BytesHex: Sha256BytesHex,
): SandboxAuthorityBundleSnapshotV3 | undefined => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return undefined;
    const row = parsed as Record<string, unknown>;
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
        "windowsOperatorTrustSetRevision",
        "windowsOperatorTrustSetDigest",
        "windowsOperatorTrustSet",
      ]) ||
      row.version !== 3 ||
      !canonicalId(row.sourceIdentity) ||
      !positive(row.bundleRevision) ||
      !positive(row.windowsOperatorTrustSetRevision) ||
      !digest(row.windowsOperatorTrustSetDigest)
    )
      return undefined;
    // The V2 projection is decoder-only: exact existing child codecs and
    // digests are reused without widening the V2 physical format.
    const v2Projection = JSON.stringify({
      version: 2,
      sourceIdentity: row.sourceIdentity,
      bundleRevision: row.bundleRevision,
      issuerConfigRevision: row.issuerConfigRevision,
      issuerConfigDigest: row.issuerConfigDigest,
      issuerConfig: row.issuerConfig,
      operatorConfigRevision: row.operatorConfigRevision,
      operatorConfigDigest: row.operatorConfigDigest,
      operatorConfig: row.operatorConfig,
      providerRegistryRevision: row.providerRegistryRevision,
      providerRegistryDigest: row.providerRegistryDigest,
      providerRegistry: row.providerRegistry,
    });
    const base = decodeCanonicalSandboxAuthorityBundleV2(
      v2Projection,
      allowedEnvironmentNames,
      sha256Hex,
    );
    const trustJson = JSON.stringify(row.windowsOperatorTrustSet);
    const trust = decodeCanonicalWindowsNativeOperatorTrustSetV1(
      trustJson,
      sha256BytesHex,
    );
    if (
      base === undefined ||
      trust === undefined ||
      trust.revision !== row.windowsOperatorTrustSetRevision ||
      trust.sourceIdentity !== row.sourceIdentity ||
      sha256Hex(trustJson) !== row.windowsOperatorTrustSetDigest
    )
      return undefined;
    const bundle: SandboxAuthorityBundleV3 = {
      ...base.bundle,
      version: 3,
      windowsOperatorTrustSetRevision: row.windowsOperatorTrustSetRevision,
      windowsOperatorTrustSetDigest: row.windowsOperatorTrustSetDigest,
      windowsOperatorTrustSet: trust,
    };
    const canonicalJson = encodeSandboxAuthorityBundleV3(bundle);
    return canonicalJson === json
      ? { bundle, canonicalJson, bundleDigest: sha256Hex(canonicalJson) }
      : undefined;
  } catch {
    return undefined;
  }
};

export const encodeSandboxAuthorityHighWaterV3 = (
  value: SandboxAuthorityHighWaterV3,
): string =>
  `{"version":3,"sourceIdentity":${JSON.stringify(value.sourceIdentity)},"bundleRevision":${value.bundleRevision},"bundleDigest":${JSON.stringify(value.bundleDigest)},"issuerConfigRevision":${value.issuerConfigRevision},"issuerConfigDigest":${JSON.stringify(value.issuerConfigDigest)},"operatorConfigRevision":${value.operatorConfigRevision},"operatorConfigDigest":${JSON.stringify(value.operatorConfigDigest)},"providerRegistryRevision":${value.providerRegistryRevision},"providerRegistryDigest":${JSON.stringify(value.providerRegistryDigest)},"windowsOperatorTrustSetRevision":${value.windowsOperatorTrustSetRevision},"windowsOperatorTrustSetDigest":${JSON.stringify(value.windowsOperatorTrustSetDigest)}}`;

export const decodeCanonicalSandboxAuthorityHighWaterV3 = (
  json: string,
): SandboxAuthorityHighWaterV3 | undefined => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return undefined;
    const row = parsed as Record<string, unknown>;
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
        "windowsOperatorTrustSetRevision",
        "windowsOperatorTrustSetDigest",
      ]) ||
      row.version !== 3 ||
      !canonicalId(row.sourceIdentity) ||
      !positive(row.bundleRevision) ||
      !digest(row.bundleDigest) ||
      !positive(row.issuerConfigRevision) ||
      !digest(row.issuerConfigDigest) ||
      !positive(row.operatorConfigRevision) ||
      !digest(row.operatorConfigDigest) ||
      !positive(row.providerRegistryRevision) ||
      !digest(row.providerRegistryDigest) ||
      !positive(row.windowsOperatorTrustSetRevision) ||
      !digest(row.windowsOperatorTrustSetDigest)
    )
      return undefined;
    const decoded = row as unknown as SandboxAuthorityHighWaterV3;
    return encodeSandboxAuthorityHighWaterV3(decoded) === json
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
};
