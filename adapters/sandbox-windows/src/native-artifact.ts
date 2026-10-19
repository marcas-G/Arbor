import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOWS_NATIVE_BRIDGE_SOURCE_SHA256 =
  "6a18eb4d3c64b48c771041c116704256c91a774fb66854a43f924598bde16366";

export const WINDOWS_NATIVE_COMPILER_ARGUMENTS = [
  "/nologo",
  "/warnaserror",
  "/platform:x64",
  "/reference:System.dll",
  "/reference:System.Core.dll",
  "/reference:System.Security.dll",
  "/target:exe",
  "/out:<adapter-dist-native>/WindowsSandboxBridgeHarness.exe",
  "<adapter-src-native>/WindowsSandboxBridgeHarness.cs",
] as const;

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Paths are fixed by the adapter package and Windows Framework installation.
 * Neither PATH search nor caller-supplied executable paths are accepted. */
export const fixedWindowsNativeArtifactPaths = (windowsRoot: string) => ({
  source: fileURLToPath(
    new URL("../src/native/WindowsSandboxBridgeHarness.cs", import.meta.url),
  ),
  compiler: win32.join(
    windowsRoot,
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  ),
  binary: fileURLToPath(
    new URL("./native/WindowsSandboxBridgeHarness.exe", import.meta.url),
  ),
});

export interface WindowsNativeArtifactDigests {
  readonly sourceSha256: string;
  readonly compilerSha256: string;
  readonly binarySha256: string;
}

/** Operator-issued evidence is a necessary input, not self-asserting authority.
 * There is currently no signature or T3 manifest verifier in this adapter. */
export interface WindowsNativeOperatorBuildBindingV1
  extends WindowsNativeArtifactDigests {
  readonly version: 1;
  readonly providerId: "windows-restricted-appcontainer-job";
  readonly providerVersion: string;
  readonly capabilityRevision: string;
  readonly osFamily: "Windows";
  readonly osBuild: string;
  readonly profile: "ReadOnly" | "WorkspaceWrite";
  readonly networkMode: "Disabled" | "Restricted" | "Enabled";
  readonly enforcementRuleSetDigest: string;
  readonly operatorConfigRevision: number;
  readonly operatorConfigDigest: string;
  readonly limits: Readonly<{
    wallTimeMs: number;
    stdoutBytes: number;
    stderrBytes: number;
    processCount: number;
    memoryBytes: number;
    cpuTimeMs: number;
  }>;
  readonly compilerVersion: string;
  readonly compilerArgumentsSha256: string;
  readonly qualificationEvidenceRef: `blob:sha256:${string}`;
  readonly qualificationManifestSha256: string;
  readonly operatorSignatureRef: string;
}

export type WindowsNativeArtifactInspection =
  | { readonly _tag: "Unavailable"; readonly reason: string }
  | {
      readonly _tag: "ObservedUnqualified";
      readonly reason: "OperatorQualificationVerifierUnavailable";
      readonly observed: WindowsNativeArtifactDigests;
    };

export const inspectWindowsNativeArtifactEvidence = (
  observed: WindowsNativeArtifactDigests,
  binding: WindowsNativeOperatorBuildBindingV1 | undefined,
): WindowsNativeArtifactInspection => {
  if (observed.sourceSha256 !== WINDOWS_NATIVE_BRIDGE_SOURCE_SHA256)
    return { _tag: "Unavailable", reason: "NativeSourceHashMismatch" };
  if (binding === undefined)
    return { _tag: "Unavailable", reason: "OperatorBuildBindingMissing" };
  if (binding.providerId !== "windows-restricted-appcontainer-job")
    return { _tag: "Unavailable", reason: "ProviderIdentityMismatch" };
  if (binding.sourceSha256 !== observed.sourceSha256)
    return { _tag: "Unavailable", reason: "BoundSourceHashMismatch" };
  if (binding.compilerSha256 !== observed.compilerSha256)
    return { _tag: "Unavailable", reason: "CompilerHashMismatch" };
  if (binding.binarySha256 !== observed.binarySha256)
    return { _tag: "Unavailable", reason: "BinaryHashMismatch" };
  const argumentDigest = createHash("sha256")
    .update(WINDOWS_NATIVE_COMPILER_ARGUMENTS.join("\n"), "utf8")
    .digest("hex");
  if (binding.compilerArgumentsSha256 !== argumentDigest)
    return { _tag: "Unavailable", reason: "CompilerArgumentsMismatch" };
  // Exact byte matches do not authenticate the operator or T3 manifest.
  return {
    _tag: "ObservedUnqualified",
    reason: "OperatorQualificationVerifierUnavailable",
    observed,
  };
};

/** Read-only candidate inspection. It never compiles, loads, or launches a helper. */
export const inspectFixedWindowsNativeArtifact = (
  windowsRoot: string | undefined,
  binding?: WindowsNativeOperatorBuildBindingV1,
): WindowsNativeArtifactInspection => {
  if (windowsRoot === undefined || windowsRoot.length === 0)
    return { _tag: "Unavailable", reason: "WindowsRootMissing" };
  const paths = fixedWindowsNativeArtifactPaths(windowsRoot);
  if (!existsSync(paths.source))
    return { _tag: "Unavailable", reason: "NativeSourceMissing" };
  const sourceSha256 = sha256(readFileSync(paths.source));
  if (sourceSha256 !== WINDOWS_NATIVE_BRIDGE_SOURCE_SHA256)
    return { _tag: "Unavailable", reason: "NativeSourceHashMismatch" };
  if (!existsSync(paths.compiler))
    return { _tag: "Unavailable", reason: "NativeCompilerMissing" };
  if (!existsSync(paths.binary))
    return { _tag: "Unavailable", reason: "NativeBinaryMissing" };
  return inspectWindowsNativeArtifactEvidence(
    {
      sourceSha256,
      compilerSha256: sha256(readFileSync(paths.compiler)),
      binarySha256: sha256(readFileSync(paths.binary)),
    },
    binding,
  );
};
