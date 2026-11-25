import { createHash } from "node:crypto";
import { release } from "node:os";
import {
  decodeCanonicalSandboxAuthorityBundleV2,
  decodeCanonicalSandboxAuthorityBundleV3,
  decodeCanonicalSandboxAuthorityHighWaterV2,
  decodeCanonicalSandboxAuthorityHighWaterV3,
  decodeCanonicalSandboxLinuxQualificationManifestV2,
  type SandboxProviderQualificationEntryV1,
} from "@arbor/domain";
import {
  SANDBOX_ENV_ALLOWLIST,
  type TrustedHostConfigurationSourceService,
} from "@arbor/ports";
import { Effect } from "effect";

export interface LinuxSupportedQualificationRow {
  readonly providerId: "linux-bwrap";
  readonly providerVersion: string;
  readonly capabilityRevision: string;
  readonly osBuild: string;
  readonly profile: "ReadOnly" | "WorkspaceWrite";
  readonly networkMode: "Disabled" | "Restricted" | "Enabled";
  readonly enforcementRuleSetDigest: string;
  readonly qualificationEvidenceRef: `blob:sha256:${string}`;
}

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const sha256Bytes = (value: Uint8Array): string => sha256(value);

const isLinuxRow = (
  entry: SandboxProviderQualificationEntryV1,
  osBuild: string,
): entry is SandboxProviderQualificationEntryV1 & {
  readonly providerId: "linux-bwrap";
  readonly status: "Supported";
  readonly qualificationEvidenceRef: `blob:sha256:${string}`;
} =>
  entry.providerId === "linux-bwrap" &&
  entry.osFamily === "Linux" &&
  entry.osBuild === osBuild &&
  entry.status === "Supported" &&
  entry.qualificationEvidenceRef !== null;

type CurrentAuthorityBundle =
  | ReturnType<typeof decodeCanonicalSandboxAuthorityBundleV2>
  | ReturnType<typeof decodeCanonicalSandboxAuthorityBundleV3>;

const currentBundleFromCanonicalPair = (input: {
  readonly sourceIdentity: string;
  readonly canonicalJson: string;
  readonly highWaterJson: string;
}): CurrentAuthorityBundle => {
  let version: unknown;
  try {
    const parsed: unknown = JSON.parse(input.canonicalJson);
    version =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).version
        : undefined;
  } catch {
    return undefined;
  }

  if (version === 2) {
    const decoded = decodeCanonicalSandboxAuthorityBundleV2(
      input.canonicalJson,
      SANDBOX_ENV_ALLOWLIST,
      sha256,
    );
    const highWater = decodeCanonicalSandboxAuthorityHighWaterV2(
      input.highWaterJson,
    );
    if (
      decoded === undefined ||
      highWater === undefined ||
      decoded.bundle.sourceIdentity !== input.sourceIdentity ||
      highWater.sourceIdentity !== decoded.bundle.sourceIdentity ||
      highWater.bundleRevision !== decoded.bundle.bundleRevision ||
      highWater.bundleDigest !== decoded.bundleDigest ||
      highWater.issuerConfigRevision !== decoded.bundle.issuerConfigRevision ||
      highWater.issuerConfigDigest !== decoded.bundle.issuerConfigDigest ||
      highWater.operatorConfigRevision !==
        decoded.bundle.operatorConfigRevision ||
      highWater.operatorConfigDigest !== decoded.bundle.operatorConfigDigest ||
      highWater.providerRegistryRevision !==
        decoded.bundle.providerRegistryRevision ||
      highWater.providerRegistryDigest !== decoded.bundle.providerRegistryDigest
    )
      return undefined;
    return decoded;
  }

  if (version === 3) {
    const decoded = decodeCanonicalSandboxAuthorityBundleV3(
      input.canonicalJson,
      SANDBOX_ENV_ALLOWLIST,
      sha256,
      sha256Bytes,
    );
    const highWater = decodeCanonicalSandboxAuthorityHighWaterV3(
      input.highWaterJson,
    );
    if (
      decoded === undefined ||
      highWater === undefined ||
      decoded.bundle.sourceIdentity !== input.sourceIdentity ||
      highWater.sourceIdentity !== decoded.bundle.sourceIdentity ||
      highWater.bundleRevision !== decoded.bundle.bundleRevision ||
      highWater.bundleDigest !== decoded.bundleDigest ||
      highWater.issuerConfigRevision !== decoded.bundle.issuerConfigRevision ||
      highWater.issuerConfigDigest !== decoded.bundle.issuerConfigDigest ||
      highWater.operatorConfigRevision !==
        decoded.bundle.operatorConfigRevision ||
      highWater.operatorConfigDigest !== decoded.bundle.operatorConfigDigest ||
      highWater.providerRegistryRevision !==
        decoded.bundle.providerRegistryRevision ||
      highWater.providerRegistryDigest !==
        decoded.bundle.providerRegistryDigest ||
      highWater.windowsOperatorTrustSetRevision !==
        decoded.bundle.windowsOperatorTrustSetRevision ||
      highWater.windowsOperatorTrustSetDigest !==
        decoded.bundle.windowsOperatorTrustSetDigest
    )
      return undefined;
    return decoded;
  }
  return undefined;
};

const readCurrentAuthorityBundle = (
  source: TrustedHostConfigurationSourceService,
) =>
  Effect.gen(function* () {
    const first = yield* Effect.all({
      source: source.readVerifiedSandboxAuthorityBundle(),
      highWater: source.readSandboxAuthorityHighWater(),
    }).pipe(Effect.option);
    if (
      first._tag === "None" ||
      first.value.source === undefined ||
      first.value.highWater === undefined
    )
      return undefined;
    const second = yield* Effect.all({
      source: source.readVerifiedSandboxAuthorityBundle(),
      highWater: source.readSandboxAuthorityHighWater(),
    }).pipe(Effect.option);
    if (
      second._tag === "None" ||
      second.value.source === undefined ||
      second.value.highWater === undefined
    )
      return undefined;
    if (
      first.value.source.sourceIdentity !==
        second.value.source.sourceIdentity ||
      first.value.source.canonicalJson !== second.value.source.canonicalJson ||
      first.value.highWater !== second.value.highWater
    )
      return undefined;
    return currentBundleFromCanonicalPair({
      sourceIdentity: second.value.source.sourceIdentity,
      canonicalJson: second.value.source.canonicalJson,
      highWaterJson: second.value.highWater,
    });
  }).pipe(Effect.orElseSucceed(() => undefined));

const rowsFromCanonicalJson = (
  decoded: CurrentAuthorityBundle,
): ReadonlyArray<LinuxSupportedQualificationRow> => {
  const entries = decoded?.bundle.providerRegistry.entries;
  if (entries === undefined) return [];
  const osBuild = release();
  return entries
    .filter(
      (
        entry,
      ): entry is typeof entry & {
        readonly providerId: "linux-bwrap";
        readonly status: "Supported";
        readonly qualificationEvidenceRef: `blob:sha256:${string}`;
      } => isLinuxRow(entry, osBuild),
    )
    .map((entry) => ({
      providerId: "linux-bwrap",
      providerVersion: entry.providerVersion,
      capabilityRevision: String(entry.capabilityRevision),
      osBuild: entry.osBuild,
      profile: entry.tuple.profile,
      networkMode: entry.tuple.networkMode,
      enforcementRuleSetDigest: entry.tuple.enforcementRuleSetDigest,
      qualificationEvidenceRef: entry.qualificationEvidenceRef,
    }));
};

/**
 * Read only the operator-issued rows that can authorize Linux process
 * execution. The source remains the authority; this helper never creates a
 * row, upgrades Experimental to Supported, or writes a high-water mark.
 */
export const readLinuxSupportedQualificationRows = async (
  source: TrustedHostConfigurationSourceService | undefined,
): Promise<ReadonlyArray<LinuxSupportedQualificationRow>> => {
  if (source === undefined || process.platform !== "linux") return [];
  const current = await Effect.runPromise(readCurrentAuthorityBundle(source));
  return current === undefined ? [] : rowsFromCanonicalJson(current);
};

/** Synchronous catalog-startup check. It controls whether the shell definition
 * is advertised, while every actual decision still reloads the protected
 * source and verifies the full authority/currentness contract. */
export const hasLinuxSupportedQualificationSync = (
  source: TrustedHostConfigurationSourceService | undefined,
): boolean => {
  if (source === undefined || process.platform !== "linux") return false;
  try {
    const current = Effect.runSync(readCurrentAuthorityBundle(source));
    return current === undefined
      ? false
      : rowsFromCanonicalJson(current).length > 0;
  } catch {
    return false;
  }
};

export const hasLinuxWorkspaceWriteEnabledQualificationSync = (
  source: TrustedHostConfigurationSourceService | undefined,
): boolean => {
  if (source === undefined || process.platform !== "linux") return false;
  try {
    const current = Effect.runSync(readCurrentAuthorityBundle(source));
    return (
      current !== undefined &&
      rowsFromCanonicalJson(current).some(
        (row) =>
          row.profile === "WorkspaceWrite" && row.networkMode === "Enabled",
      )
    );
  } catch {
    return false;
  }
};

export const hasLinuxSupportedQualification = async (
  source: TrustedHostConfigurationSourceService | undefined,
): Promise<boolean> =>
  (await readLinuxSupportedQualificationRows(source)).length > 0;

/** Read only an authority-issued qualification blob. The reference is the
 * complete lookup key; callers cannot provide a filesystem path. */
export const readLinuxSandboxQualificationEvidence = async (
  source: TrustedHostConfigurationSourceService | undefined,
  ref: `blob:sha256:${string}`,
): Promise<string | undefined> => {
  if (source?.readLinuxSandboxQualificationEvidence === undefined)
    return undefined;
  try {
    return await Effect.runPromise(
      source.readLinuxSandboxQualificationEvidence(ref),
    );
  } catch {
    return undefined;
  }
};

export const decodeLinuxSandboxQualificationEvidence = async (
  source: TrustedHostConfigurationSourceService | undefined,
  ref: `blob:sha256:${string}`,
) => {
  const json = await readLinuxSandboxQualificationEvidence(source, ref);
  if (json === undefined) return undefined;
  return decodeCanonicalSandboxLinuxQualificationManifestV2(json);
};
