import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fixedWindowsNativeArtifactPaths,
  inspectFixedWindowsNativeArtifact,
  inspectWindowsNativeArtifactEvidence,
  inspectWindowsNativeArtifactPaths,
  WINDOWS_NATIVE_BRIDGE_SOURCE_SHA256,
  WINDOWS_NATIVE_COMPILER_ARGUMENTS,
  type WindowsNativeArtifactIo,
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

const fixturePaths = {
  source: "source",
  compiler: "compiler",
  binary: "binary",
};

const digestFor = (name: string) =>
  name === "source"
    ? WINDOWS_NATIVE_BRIDGE_SOURCE_SHA256
    : name === "compiler"
      ? observed.compilerSha256
      : observed.binarySha256;

const fixtureIo: WindowsNativeArtifactIo = {
  lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
  realpath: (path) => path,
  read: (path) => Buffer.from(path),
  hash: (bytes) => digestFor(bytes.toString("utf8")),
};

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

  it("turns deletion and unreadability races at every file I/O step into typed Unavailable", () => {
    const secretPath = "C:\\private\\token.txt";
    for (const [file, label] of [
      ["source", "NativeSource"],
      ["compiler", "NativeCompiler"],
      ["binary", "NativeBinary"],
    ] as const) {
      for (const operation of ["lstat", "realpath", "read", "hash"] as const) {
        for (const code of ["ENOENT", "EACCES"] as const) {
          const failure = Object.assign(
            new Error(`cannot read ${secretPath}`),
            {
              code,
              path: secretPath,
            },
          );
          const io: WindowsNativeArtifactIo = {
            lstat: (path) => {
              if (file === path && operation === "lstat") throw failure;
              return fixtureIo.lstat(path);
            },
            realpath: (path) => {
              if (file === path && operation === "realpath") throw failure;
              return fixtureIo.realpath(path);
            },
            read: (path) => {
              if (file === path && operation === "read") throw failure;
              return fixtureIo.read(path);
            },
            hash: (bytes) => {
              if (file === bytes.toString("utf8") && operation === "hash")
                throw failure;
              return fixtureIo.hash(bytes);
            },
          };
          const result = inspectWindowsNativeArtifactPaths(
            fixturePaths,
            binding,
            io,
          );
          expect(result).toEqual({
            _tag: "Unavailable",
            reason: `${label}${code === "ENOENT" ? "Missing" : "Unreadable"}`,
          });
          expect(JSON.stringify(result)).not.toContain(secretPath);
          expect(JSON.stringify(result)).not.toContain("cannot read");
        }
      }
    }
  });

  it("rejects symlinks and non-files without reading them", () => {
    for (const [symbolicLink, regularFile] of [
      [true, true],
      [false, false],
    ] as const) {
      let readCalled = false;
      const io: WindowsNativeArtifactIo = {
        ...fixtureIo,
        lstat: () => ({
          isFile: () => regularFile,
          isSymbolicLink: () => symbolicLink,
        }),
        read: (path) => {
          readCalled = true;
          return fixtureIo.read(path);
        },
      };
      expect(
        inspectWindowsNativeArtifactPaths(fixturePaths, binding, io),
      ).toEqual({
        _tag: "Unavailable",
        reason: "NativeSourceNotRegularFile",
      });
      expect(readCalled).toBe(false);
    }
  });
});
