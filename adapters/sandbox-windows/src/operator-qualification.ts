import { readFileSync } from "node:fs";
import type {
  SandboxAuthorityBundleSnapshotCurrent,
  SandboxProviderQualificationEntryV1,
} from "@arbor/domain";
import { Clock, CurrentSandboxAuthoritySnapshotPort } from "@arbor/ports";
import { Effect } from "effect";
import { verifyWindowsNativeOperatorProvenanceV1 } from "./operator-provenance.js";
import {
  decodeCanonicalWindowsNativeArtifactManifestV1,
  fixedWindowsNativeProductionArtifactPaths,
  inspectWindowsNativeQualificationPaths,
  type WindowsNativeQualificationExpectationV1,
  type WindowsNativeQualificationInspection,
  type WindowsNativeQualificationIo,
} from "./qualification-manifest.js";

const unavailable = (reason: string): WindowsNativeQualificationInspection => ({
  _tag: "Unavailable",
  reason,
});

/** Registry/host/operator limits are authority. Manifest metadata is read
 * only to form fixed build expectations; the subsequent inspector re-reads
 * its exact bytes, matches the registry digest and verifies the signature. */
export const inspectWindowsNativeQualificationForRegistryEntryV3 = (
  paths: ReturnType<typeof fixedWindowsNativeProductionArtifactPaths>,
  row: SandboxProviderQualificationEntryV1,
  snapshot: SandboxAuthorityBundleSnapshotCurrent,
  currentHost: {
    readonly osFamily: "Linux" | "macOS" | "Windows";
    readonly osBuild: string;
  },
  now: string,
  io?: WindowsNativeQualificationIo,
): WindowsNativeQualificationInspection => {
  if (
    snapshot.bundle.version !== 3 ||
    row.providerId !== "windows-restricted-appcontainer-job" ||
    row.osFamily !== "Windows" ||
    row.tuple.networkMode !== "Disabled" ||
    row.qualificationEvidenceRef === null
  )
    return unavailable("RegistryQualificationBindingMismatch");
  const limits = snapshot.bundle.operatorConfig.limitsByProfile.find(
    (entry) => entry.profile === row.tuple.profile,
  )?.limits;
  if (limits === undefined) return unavailable("OperatorConfigMismatch");
  try {
    const metadataBytes =
      io?.read(paths.manifest) ?? readFileSync(paths.manifest);
    const metadataText = new TextDecoder("utf-8", { fatal: true }).decode(
      metadataBytes,
    );
    if (!Buffer.from(metadataText, "utf8").equals(metadataBytes))
      return unavailable("ManifestCanonicalCodecInvalid");
    const metadata =
      decodeCanonicalWindowsNativeArtifactManifestV1(metadataText);
    if (metadata === undefined)
      return unavailable("ManifestCanonicalCodecInvalid");
    return inspectWindowsNativeQualificationWithAuthorityV3(
      paths,
      {
        providerId: "windows-restricted-appcontainer-job",
        providerVersion: row.providerVersion,
        capabilityRevision: row.capabilityRevision,
        osBuild: row.osBuild,
        profile: row.tuple.profile,
        networkMode: "Disabled",
        enforcementRuleSetDigest: row.tuple.enforcementRuleSetDigest,
        qualificationEvidenceRef: row.qualificationEvidenceRef,
        operatorConfigRevision: snapshot.bundle.operatorConfigRevision,
        operatorConfigDigest: snapshot.bundle.operatorConfigDigest,
        limits,
        compilerVersion: metadata.compilerVersion,
        buildMethod: metadata.buildMethod,
        buildVersion: metadata.buildVersion,
        discoveryMethod: metadata.discoveryMethod,
        discoveryVersion: metadata.discoveryVersion,
      },
      snapshot,
      currentHost,
      now,
      io,
    );
  } catch {
    return unavailable("ManifestUnavailable");
  }
};

/** Identity evidence only. The caller cannot supply a digest-only verifier:
 * the Ed25519 key is selected solely from this immutable verified V3
 * snapshot. This function does not promote a capability or launch a helper. */
export const inspectWindowsNativeQualificationWithAuthorityV3 = (
  paths: ReturnType<typeof fixedWindowsNativeProductionArtifactPaths>,
  expected: WindowsNativeQualificationExpectationV1,
  snapshot: SandboxAuthorityBundleSnapshotCurrent,
  currentHost: {
    readonly osFamily: "Linux" | "macOS" | "Windows";
    readonly osBuild: string;
  },
  now: string,
  io?: WindowsNativeQualificationIo,
): WindowsNativeQualificationInspection => {
  if (snapshot.bundle.version !== 3) return unavailable("TrustSetUnavailable");
  const bundle = snapshot.bundle;
  if (
    currentHost.osFamily !== "Windows" ||
    currentHost.osBuild !== expected.osBuild
  )
    return unavailable("ProviderOrOperatingSystemMismatch");
  if (
    bundle.operatorConfigRevision !== expected.operatorConfigRevision ||
    bundle.operatorConfigDigest !== expected.operatorConfigDigest
  )
    return unavailable("OperatorConfigMismatch");
  const rows = bundle.providerRegistry.entries.filter(
    (row) =>
      row.providerId === expected.providerId &&
      row.providerVersion === expected.providerVersion &&
      row.capabilityRevision === expected.capabilityRevision &&
      row.osFamily === "Windows" &&
      row.osBuild === expected.osBuild &&
      row.tuple.profile === expected.profile &&
      row.tuple.networkMode === expected.networkMode &&
      row.tuple.networkPolicyCodecVersion === 1 &&
      row.tuple.enforcementRuleSetDigest ===
        expected.enforcementRuleSetDigest &&
      row.qualificationEvidenceRef === expected.qualificationEvidenceRef,
  );
  if (rows.length !== 1)
    return unavailable("RegistryQualificationBindingMismatch");
  const verifier = {
    verify: ({
      manifestBytes,
      signatureBytes,
    }: {
      readonly manifestBytes: Buffer;
      readonly signatureBytes: Buffer;
      readonly manifestSha256: string;
    }) =>
      verifyWindowsNativeOperatorProvenanceV1({
        trustSet: bundle.windowsOperatorTrustSet,
        manifestBytes,
        sidecarBytes: signatureBytes,
        now,
      })._tag === "Verified",
  };
  return inspectWindowsNativeQualificationPaths(paths, expected, verifier, io);
};

/** Production-bound D2 factory: reload the P5 protected source/high-water
 * and trusted host clock on every probe/admission call. No caller verifier,
 * anchor, source path, or cached green result enters this boundary. */
export const inspectCurrentWindowsNativeQualificationManifest = (
  expected: WindowsNativeQualificationExpectationV1,
): Effect.Effect<
  WindowsNativeQualificationInspection,
  never,
  CurrentSandboxAuthoritySnapshotPort | Clock
> =>
  Effect.gen(function* () {
    if (process.platform !== "win32") return unavailable("WindowsHostRequired");
    const currentPort = yield* CurrentSandboxAuthoritySnapshotPort;
    const clock = yield* Clock;
    const current = yield* currentPort.loadCurrentVerifiedV2();
    if (current._tag !== "Available")
      return unavailable("TrustCurrentnessMismatch");
    const now = yield* clock.now();
    try {
      return inspectWindowsNativeQualificationWithAuthorityV3(
        fixedWindowsNativeProductionArtifactPaths(),
        expected,
        current.snapshot,
        current.currentHost,
        now,
      );
    } catch {
      return unavailable("OperatorProvenanceInvalid");
    }
  });
