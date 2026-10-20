import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { arch, release } from "node:os";
import type {
  SandboxProviderCapability,
  SandboxProviderId,
} from "@arbor/domain";
import {
  type ClockService,
  type CurrentSandboxAuthoritySnapshotPortService,
  SandboxProcessPort,
  type SandboxProcessPortService,
  type SandboxProcessRequest,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { inspectWindowsNativeQualificationForRegistryEntryV3 } from "./operator-qualification.js";
import { fixedWindowsNativeProductionArtifactPaths } from "./qualification-manifest.js";

export {
  fixedWindowsNativeArtifactPaths,
  inspectFixedWindowsNativeArtifact,
  inspectWindowsNativeArtifactEvidence,
  inspectWindowsNativeArtifactPaths,
  WINDOWS_NATIVE_BRIDGE_SOURCE_SHA256,
  WINDOWS_NATIVE_COMPILER_ARGUMENTS,
  type WindowsNativeArtifactDigests,
  type WindowsNativeArtifactInspection,
  type WindowsNativeArtifactIo,
  type WindowsNativeOperatorBuildBindingV1,
} from "./native-artifact.js";
export {
  verifyWindowsNativeOperatorProvenanceV1,
  type WindowsNativeOperatorProvenanceResult,
} from "./operator-provenance.js";

export {
  inspectCurrentWindowsNativeQualificationManifest,
  inspectWindowsNativeQualificationForRegistryEntryV3,
  inspectWindowsNativeQualificationWithAuthorityV3,
} from "./operator-qualification.js";
export {
  decodeCanonicalWindowsNativeArtifactManifestV1,
  decodeWindowsNativeArtifactManifestV1,
  encodeWindowsNativeArtifactManifestV1,
  fixedWindowsNativeProductionArtifactPaths,
  inspectFixedWindowsNativeQualificationManifest,
  WINDOWS_NATIVE_PROCESS_HOST_COMPILER_ARGUMENTS_V1,
  type WindowsNativeArtifactHashV1,
  type WindowsNativeArtifactManifestV1,
  type WindowsNativeQualificationExpectationV1,
  type WindowsNativeQualificationHostControlV1,
  type WindowsNativeQualificationInspection,
  type WindowsNativeQualificationIo,
  type WindowsNativeQualificationLimitsV1,
  type WindowsNativeQualificationMatrixResultV1,
  type WindowsNativeQualificationProvenanceVerifier,
  type WindowsNativeQualificationTupleV1,
} from "./qualification-manifest.js";

export const WINDOWS_SANDBOX_PROVIDER_IDS = {
  mxc: "windows-mxc",
  elevatedDedicatedUser: "windows-elevated-dedicated-user",
  restrictedAppContainerJob: "windows-restricted-appcontainer-job",
} as const satisfies Record<string, SandboxProviderId>;

export interface WindowsSandboxProbeSnapshot {
  readonly platform: string;
  readonly osVersion: string;
  readonly architecture: string;
  readonly elevated: boolean | null;
  readonly windowsSdkAvailable: boolean;
  readonly compilerAvailable: boolean;
  readonly nativeApiBridgeAvailable: boolean;
  readonly secureBrokerAvailable: boolean;
  readonly admittedRootAclAvailable?: boolean;
  readonly reparseDefenseAvailable?: boolean;
  readonly jobObjectLimitsAvailable?: boolean;
}

export interface WindowsSandboxProbe {
  readonly probe: () => WindowsSandboxProbeSnapshot;
}

const windowsPath = (...segments: string[]): string | undefined => {
  const root = process.env.WINDIR;
  return root === undefined ? undefined : [root, ...segments].join("\\");
};

/** A non-spawning prerequisite probe. API presence alone is never treated as
 * enforcement evidence; the missing reviewed native runner keeps every
 * provider Experimental and unavailable. */
export const probeWindowsSandboxHost = (): WindowsSandboxProbeSnapshot => {
  const sdkRoot = process.env["ProgramFiles(x86)"];
  const frameworkRoot = windowsPath(
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
  );
  return {
    platform: process.platform,
    osVersion: release(),
    architecture: arch(),
    // Node has no supported Windows token/privilege inspection API. Unknown
    // is kept distinct from false and fails closed for elevated providers.
    elevated: null,
    windowsSdkAvailable:
      sdkRoot !== undefined &&
      existsSync(`${sdkRoot}\\Windows Kits\\10\\Include`),
    compilerAvailable:
      frameworkRoot !== undefined && existsSync(`${frameworkRoot}\\csc.exe`),
    // Fixed source is packaged for qualification, but no signed helper, T3
    // evidence verifier, or production launch path exists.
    nativeApiBridgeAvailable: false,
    secureBrokerAvailable: false,
    admittedRootAclAvailable: false,
    reparseDefenseAvailable: false,
    jobObjectLimitsAvailable: false,
  };
};

const canonicalSnapshot = (snapshot: WindowsSandboxProbeSnapshot) =>
  JSON.stringify({
    platform: snapshot.platform,
    osVersion: snapshot.osVersion,
    architecture: snapshot.architecture,
    elevated: snapshot.elevated,
    windowsSdkAvailable: snapshot.windowsSdkAvailable,
    compilerAvailable: snapshot.compilerAvailable,
    nativeApiBridgeAvailable: snapshot.nativeApiBridgeAvailable,
    secureBrokerAvailable: snapshot.secureBrokerAvailable,
    admittedRootAclAvailable: snapshot.admittedRootAclAvailable ?? false,
    reparseDefenseAvailable: snapshot.reparseDefenseAvailable ?? false,
    jobObjectLimitsAvailable: snapshot.jobObjectLimitsAvailable ?? false,
  });

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const providerFailureCode = (
  providerId: string,
  snapshot: WindowsSandboxProbeSnapshot,
): string => {
  if (snapshot.platform !== "win32") return "WindowsHostRequired";
  switch (providerId) {
    case WINDOWS_SANDBOX_PROVIDER_IDS.mxc:
      return "MxcPrerequisitesUnverified";
    case WINDOWS_SANDBOX_PROVIDER_IDS.elevatedDedicatedUser:
      if (snapshot.elevated !== true) return "ElevationNotVerified";
      return "DedicatedUserProviderUnqualified";
    case WINDOWS_SANDBOX_PROVIDER_IDS.restrictedAppContainerJob:
      if (!snapshot.windowsSdkAvailable) return "WindowsSdkUnavailable";
      if (!snapshot.compilerAvailable) return "NativeCompilerUnavailable";
      if (!snapshot.nativeApiBridgeAvailable)
        return "NativeApiBridgeUnavailable";
      if (!snapshot.secureBrokerAvailable) return "NamedPipeBrokerUnavailable";
      if (!snapshot.admittedRootAclAvailable)
        return "AdmittedRootAclUnavailable";
      if (!snapshot.reparseDefenseAvailable) return "ReparseDefenseUnavailable";
      if (!snapshot.jobObjectLimitsAvailable)
        return "JobObjectLimitsUnavailable";
      return "NativeControlsUnqualified";
    default:
      return "ProviderNotRegistered";
  }
};

const capabilityFor = (
  providerId: SandboxProviderId,
  snapshot: WindowsSandboxProbeSnapshot,
): SandboxProviderCapability => {
  const evidenceDigest = sha256(canonicalSnapshot(snapshot));
  const providerDigest = sha256(`${providerId}\n${evidenceDigest}`);
  return {
    providerId,
    providerVersion: "windows-t2-probe-v1",
    capabilityRevision: `winprobe-${providerDigest}`,
    probeEvidenceRef: `sha256:${evidenceDigest}`,
    enforcementRuleSetDigest: null,
    qualificationEvidenceRef: null,
    status: "Experimental",
    boundary: "OsEnforced",
    profiles: [],
    networkModes: [],
  };
};

export const makeWindowsSandboxProcessPort = (
  probe: WindowsSandboxProbe = { probe: probeWindowsSandboxHost },
  qualification?: {
    readonly currentAuthority: CurrentSandboxAuthoritySnapshotPortService;
    readonly clock: ClockService;
  },
): SandboxProcessPortService => ({
  capabilities: () =>
    Effect.gen(function* () {
      const snapshot = probe.probe();
      if (qualification !== undefined && snapshot.platform === "win32") {
        const current =
          yield* qualification.currentAuthority.loadCurrentVerifiedV2();
        if (
          current._tag === "Available" &&
          current.snapshot.bundle.version === 3
        ) {
          const now = yield* qualification.clock.now();
          for (const row of current.snapshot.bundle.providerRegistry.entries) {
            if (
              row.providerId ===
              WINDOWS_SANDBOX_PROVIDER_IDS.restrictedAppContainerJob
            )
              inspectWindowsNativeQualificationForRegistryEntryV3(
                fixedWindowsNativeProductionArtifactPaths(),
                row,
                current.snapshot,
                current.currentHost,
                now,
              );
          }
        }
      }
      return Object.values(WINDOWS_SANDBOX_PROVIDER_IDS).map((providerId) =>
        capabilityFor(providerId, snapshot),
      );
    }),
  run: (request: SandboxProcessRequest) =>
    Effect.gen(function* () {
      const snapshot = probe.probe();
      if (qualification !== undefined && snapshot.platform === "win32") {
        const current =
          yield* qualification.currentAuthority.loadCurrentVerifiedV2();
        if (
          current._tag === "Available" &&
          current.snapshot.bundle.version === 3
        ) {
          const row = current.snapshot.bundle.providerRegistry.entries.find(
            (entry) =>
              entry.providerId === request.policy.providerId &&
              entry.providerVersion === request.policy.providerVersion &&
              String(entry.capabilityRevision) ===
                request.policy.capabilityRevision &&
              entry.tuple.profile === request.policy.profile &&
              entry.tuple.networkMode === request.policy.networkPolicy.mode &&
              entry.tuple.enforcementRuleSetDigest ===
                request.policy.enforcementRuleSetDigest &&
              entry.qualificationEvidenceRef ===
                request.policy.qualificationEvidenceRef,
          );
          if (row !== undefined) {
            const now = yield* qualification.clock.now();
            inspectWindowsNativeQualificationForRegistryEntryV3(
              fixedWindowsNativeProductionArtifactPaths(),
              row,
              current.snapshot,
              current.currentHost,
              now,
            );
          }
        }
      }
      const capability = capabilityFor(request.policy.providerId, snapshot);
      return {
        _tag: "Unavailable" as const,
        providerId: request.policy.providerId,
        providerVersion: capability.providerVersion,
        capabilityRevision: capability.capabilityRevision,
        probeEvidenceRef: capability.probeEvidenceRef,
        failureCode: providerFailureCode(request.policy.providerId, snapshot),
      };
    }),
});

export const SandboxProcessPortLive = (
  probe: WindowsSandboxProbe = { probe: probeWindowsSandboxHost },
): Layer.Layer<SandboxProcessPort> =>
  Layer.succeed(SandboxProcessPort, makeWindowsSandboxProcessPort(probe));
