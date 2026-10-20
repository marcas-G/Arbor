import type { SandboxAuthorityBundleSnapshotCurrent } from "@arbor/domain";
import { Clock, CurrentSandboxAuthoritySnapshotPort } from "@arbor/ports";
import { Effect } from "effect";
import { verifyWindowsNativeOperatorProvenanceV1 } from "./operator-provenance.js";
import {
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
