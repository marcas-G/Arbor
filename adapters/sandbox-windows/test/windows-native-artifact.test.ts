import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fixedWindowsNativeArtifactPaths,
  inspectFixedWindowsNativeArtifact,
  inspectWindowsNativeArtifactEvidence,
  WINDOWS_NATIVE_BRIDGE_SOURCE_SHA256,
  WINDOWS_NATIVE_COMPILER_ARGUMENTS,
  type WindowsNativeOperatorBuildBindingV1,
} from "../src/native-artifact.js";

const sha256 = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");

const observed = {
  sourceSha256: WINDOWS_NATIVE_BRIDGE_SOURCE_SHA256,
  compilerSha256: "a".repeat(64),
  binarySha256: "b".repeat(64),
};

const binding = {
  version: 1,
  providerId: "windows-restricted-appcontainer-job",
  providerVersion: "test-only",
  capabilityRevision: "test-only",
  osFamily: "Windows",
  osBuild: "10.0.19044",
  profile: "ReadOnly",
  networkMode: "Disabled",
  enforcementRuleSetDigest: "d".repeat(64),
  operatorConfigRevision: 1,
  operatorConfigDigest: "e".repeat(64),
  limits: {
    wallTimeMs: 10000,
    stdoutBytes: 8192,
    stderrBytes: 8192,
    processCount: 4,
    memoryBytes: 256 * 1024 * 1024,
    cpuTimeMs: 5000,
  },
  compilerVersion: "v4.0.30319",
  compilerArgumentsSha256: sha256(WINDOWS_NATIVE_COMPILER_ARGUMENTS.join("\n")),
  qualificationEvidenceRef: `blob:sha256:${"c".repeat(64)}`,
  qualificationManifestSha256: "f".repeat(64),
  operatorSignatureRef: "test-only-unverified-signature",
  ...observed,
} as const satisfies WindowsNativeOperatorBuildBindingV1;

describe("Windows fixed native artifact contract", () => {
  it("pins adapter-owned source and exact compiler/binary locations", () => {
    const paths = fixedWindowsNativeArtifactPaths("C:\\Windows");
    expect(paths.source.replaceAll("\\", "/")).toMatch(
      /adapters\/sandbox-windows\/src\/native\/WindowsSandboxBridgeHarness\.cs$/u,
    );
    expect(paths.compiler).toBe(
      "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
    );
    expect(paths.binary.replaceAll("\\", "/")).toMatch(
      /adapters\/sandbox-windows\/(?:src|dist)\/native\/WindowsSandboxBridgeHarness\.exe$/u,
    );
    expect(sha256(readFileSync(paths.source))).toBe(
      WINDOWS_NATIVE_BRIDGE_SOURCE_SHA256,
    );
    expect(WINDOWS_NATIVE_COMPILER_ARGUMENTS).toContain("/platform:x64");
  });

  it("fails closed on missing or mismatched source, compiler, binary, and argument evidence", () => {
    expect(inspectWindowsNativeArtifactEvidence(observed, undefined)).toEqual({
      _tag: "Unavailable",
      reason: "OperatorBuildBindingMissing",
    });
    for (const [changed, reason] of [
      [
        { ...observed, sourceSha256: "0".repeat(64) },
        "NativeSourceHashMismatch",
      ],
      [observed, "BoundSourceHashMismatch"],
      [observed, "CompilerHashMismatch"],
      [observed, "BinaryHashMismatch"],
      [observed, "CompilerArgumentsMismatch"],
    ] as const) {
      const altered =
        reason === "BoundSourceHashMismatch"
          ? { ...binding, sourceSha256: "0".repeat(64) }
          : reason === "CompilerHashMismatch"
            ? { ...binding, compilerSha256: "0".repeat(64) }
            : reason === "BinaryHashMismatch"
              ? { ...binding, binarySha256: "0".repeat(64) }
              : reason === "CompilerArgumentsMismatch"
                ? { ...binding, compilerArgumentsSha256: "0".repeat(64) }
                : binding;
      expect(inspectWindowsNativeArtifactEvidence(changed, altered)).toEqual({
        _tag: "Unavailable",
        reason,
      });
    }
  });

  it("keeps byte-matched candidate evidence unqualified without an operator verifier", () => {
    expect(inspectWindowsNativeArtifactEvidence(observed, binding)).toEqual({
      _tag: "ObservedUnqualified",
      reason: "OperatorQualificationVerifierUnavailable",
      observed,
    });
    expect(inspectFixedWindowsNativeArtifact(undefined)).toEqual({
      _tag: "Unavailable",
      reason: "WindowsRootMissing",
    });
    expect(
      inspectFixedWindowsNativeArtifact(process.env.WINDIR)?._tag,
    ).not.toBe("Qualified");
  });
});
