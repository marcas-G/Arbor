import { createHash, createPrivateKey, sign } from "node:crypto";
import { win32 } from "node:path";
import {
  decodeCanonicalWindowsNativeOperatorTrustSetV1,
  encodeWindowsNativeManifestSignatureV1,
  type SandboxAuthorityBundleSnapshotV3,
} from "@arbor/domain";
import { describe, expect, it } from "vitest";
import {
  inspectWindowsNativeQualificationForRegistryEntryV3,
  inspectWindowsNativeQualificationWithAuthorityV3,
} from "../src/operator-qualification.js";
import {
  decodeCanonicalWindowsNativeArtifactManifestV1,
  encodeWindowsNativeArtifactManifestV1,
  fixedWindowsNativeProductionArtifactPaths,
  inspectFixedWindowsNativeQualificationManifest,
  inspectWindowsNativeQualificationPaths,
  WINDOWS_NATIVE_PROCESS_HOST_COMPILER_ARGUMENTS_V1,
  type WindowsNativeArtifactManifestV1,
  type WindowsNativeQualificationExpectationV1,
  type WindowsNativeQualificationIo,
} from "../src/qualification-manifest.js";

const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const sourceBytes = Buffer.from("fixed process host source", "utf8");
const compilerBytes = Buffer.from("fixed framework compiler", "utf8");
const binaryBytes = Buffer.from("shipped PE bytes", "utf8");
const controlBytes = Buffer.from("qualification control artifact", "utf8");
const signatureBytes = Buffer.from("detached signature bytes", "utf8");
const qualificationEvidenceRef = `blob:sha256:${"0".repeat(64)}`;

const manifest: WindowsNativeArtifactManifestV1 = {
  version: 1,
  providerId: "windows-restricted-appcontainer-job",
  providerVersion: "t3d-v1",
  capabilityRevision: 4,
  osFamily: "Windows",
  osBuild: "10.0.19045",
  platformPrimitiveSetId:
    "windows-restricted-token-lowintegrity-appcontainer-job-namedpipe-v1",
  qualificationRows: [
    {
      profile: "ReadOnly",
      networkMode: "Disabled",
      networkPolicyCodecVersion: 1,
      enforcementRuleSetDigest: "f".repeat(64),
    },
  ],
  sourceSha256: hash(sourceBytes),
  compilerSha256: hash(compilerBytes),
  compilerVersion: "4.8.9037.0",
  compilerArgumentsSha256: hash(
    WINDOWS_NATIVE_PROCESS_HOST_COMPILER_ARGUMENTS_V1.join("\n"),
  ),
  binarySha256: hash(binaryBytes),
  buildMethod: "fixed-framework64-csc",
  buildVersion: "1",
  testControlArtifactHashes: [
    { artifactId: "control-token", sha256: hash(controlBytes) },
  ],
  limits: {
    wallTimeMs: 60_000,
    stdoutBytes: 8192,
    stderrBytes: 8192,
    processCount: 4,
    memoryBytes: 268_435_456,
    cpuTimeMs: 30_000,
  },
  operatorConfigRevision: 3,
  operatorConfigDigest: "e".repeat(64),
  discoveryMethod: "fixed-windows-build-probe",
  discoveryVersion: "1",
  matrixResults: [{ matrixId: "disabled-readonly", result: "Pass" }],
  hostControls: [
    {
      controlId: "appcontainer-token",
      artifactId: "control-token",
      result: "Pass",
    },
  ],
};

const expected: WindowsNativeQualificationExpectationV1 = {
  providerId: manifest.providerId,
  providerVersion: manifest.providerVersion,
  capabilityRevision: manifest.capabilityRevision,
  osBuild: manifest.osBuild,
  profile: "ReadOnly",
  networkMode: "Disabled",
  enforcementRuleSetDigest: "f".repeat(64),
  qualificationEvidenceRef,
  operatorConfigRevision: manifest.operatorConfigRevision,
  operatorConfigDigest: manifest.operatorConfigDigest,
  limits: manifest.limits,
  compilerVersion: manifest.compilerVersion,
  buildMethod: manifest.buildMethod,
  buildVersion: manifest.buildVersion,
  discoveryMethod: manifest.discoveryMethod,
  discoveryVersion: manifest.discoveryVersion,
};

const paths = fixedWindowsNativeProductionArtifactPaths();
const manifestBytes = Buffer.from(
  encodeWindowsNativeArtifactManifestV1(manifest),
  "utf8",
);
const makeIo = (
  overrides: {
    readonly failPath?: string;
    readonly failOperation?: "lstat" | "realpath" | "read";
    readonly redirectedPath?: string;
    readonly symbolicPath?: string;
    readonly manifest?: Buffer;
    readonly files?: ReadonlyMap<string, Buffer>;
  } = {},
): WindowsNativeQualificationIo => {
  const files = new Map([
    [paths.source, sourceBytes],
    [paths.compiler, compilerBytes],
    [paths.binary, binaryBytes],
    [paths.manifest, overrides.manifest ?? manifestBytes],
    [paths.signature, signatureBytes],
    [win32.join(paths.testControlRoot, "control-token.artifact"), controlBytes],
  ]);
  for (const [path, bytes] of overrides.files ?? []) files.set(path, bytes);
  const shouldFail = (path: string, operation: string) =>
    path === overrides.failPath && operation === overrides.failOperation;
  return {
    lstat: (path) => {
      if (shouldFail(path, "lstat")) throw new Error("missing artifact");
      return {
        isFile: () => files.has(path),
        isDirectory: () => false,
        isSymbolicLink: () => path === overrides.symbolicPath,
      };
    },
    realpath: (path) => {
      if (shouldFail(path, "realpath")) throw new Error("path race");
      return overrides.redirectedPath === path ? `${path}.redirected` : path;
    },
    read: (path) => {
      if (shouldFail(path, "read")) throw new Error("read race");
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error("missing bytes");
      return bytes;
    },
  };
};

const verify = {
  verify: ({ manifestSha256 }: { readonly manifestSha256: string }) =>
    manifestSha256 === hash(manifestBytes),
};

describe("strict Windows native qualification manifest V1", () => {
  it("binds a genuine Ed25519 sidecar to the current V3 trust/registry tuple", () => {
    const trustJson =
      '{"version":1,"revision":1,"sourceIdentity":"host:test","providerId":"windows-restricted-appcontainer-job","keys":[{"keyId":"operator-2026-a","algorithm":"Ed25519","publicKeySpkiDerBase64":"MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=","publicKeySpkiSha256":"06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9","validFrom":"2026-10-20T00:00:00.000Z","validUntil":"2027-10-20T00:00:00.000Z","status":"Active"}],"revokedKeyIds":[]}';
    const trust = decodeCanonicalWindowsNativeOperatorTrustSetV1(
      trustJson,
      (bytes) => hash(Buffer.from(bytes)),
    );
    if (trust === undefined) throw new Error("trust KAT rejected");
    const seed = Buffer.from(
      "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      "hex",
    );
    const pkcs8 = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]);
    const privateKey = createPrivateKey({
      key: pkcs8,
      format: "der",
      type: "pkcs8",
    });
    const message = Buffer.concat([
      Buffer.from("Arbor.WindowsNativeQualificationManifestV1\0", "ascii"),
      manifestBytes,
    ]);
    const signed = sign(null, message, privateKey);
    const sidecar = Buffer.from(
      encodeWindowsNativeManifestSignatureV1({
        version: 1,
        keyId: "operator-2026-a",
        signatureBase64: signed.toString("base64"),
      }),
      "utf8",
    );
    const qualified = {
      ...expected,
      qualificationEvidenceRef: `blob:sha256:${hash(manifestBytes)}`,
    };
    const snapshot = {
      bundle: {
        version: 3,
        operatorConfigRevision: expected.operatorConfigRevision,
        operatorConfigDigest: expected.operatorConfigDigest,
        operatorConfig: {
          version: 1,
          revision: expected.operatorConfigRevision,
          environmentAllowlist: [],
          limitsByProfile: [
            { profile: "ReadOnly", limits: expected.limits },
            { profile: "WorkspaceWrite", limits: expected.limits },
            { profile: "FullAccess", limits: expected.limits },
          ],
          trustedLocalRuntimeVersion: "builtin-v1",
        },
        windowsOperatorTrustSet: trust,
        providerRegistry: {
          entries: [
            {
              providerId: expected.providerId,
              providerVersion: expected.providerVersion,
              capabilityRevision: expected.capabilityRevision,
              osFamily: "Windows",
              osBuild: expected.osBuild,
              tuple: {
                profile: expected.profile,
                networkMode: expected.networkMode,
                networkPolicyCodecVersion: 1,
                enforcementRuleSetDigest: expected.enforcementRuleSetDigest,
              },
              status: "Experimental",
              qualificationEvidenceRef: qualified.qualificationEvidenceRef,
            },
          ],
        },
      },
    } as unknown as SandboxAuthorityBundleSnapshotV3;
    const io = makeIo({ files: new Map([[paths.signature, sidecar]]) });
    const inspect = (current = snapshot) =>
      inspectWindowsNativeQualificationWithAuthorityV3(
        paths,
        qualified,
        current,
        { osFamily: "Windows", osBuild: expected.osBuild },
        "2026-10-20T00:00:00.000Z",
        io,
      );
    expect(inspect()).toMatchObject({
      _tag: "ManifestVerified",
      qualificationEvidenceRef: qualified.qualificationEvidenceRef,
    });
    const row = snapshot.bundle.providerRegistry.entries[0];
    if (row === undefined) throw new Error("test registry row missing");
    const inspectFromRow = (currentIo: WindowsNativeQualificationIo) =>
      inspectWindowsNativeQualificationForRegistryEntryV3(
        paths,
        row,
        snapshot,
        { osFamily: "Windows", osBuild: expected.osBuild },
        "2026-10-20T00:00:00.000Z",
        currentIo,
      );
    expect(inspectFromRow(io)._tag).toBe("ManifestVerified");
    const badSidecarIo = makeIo({
      files: new Map([[paths.signature, Buffer.from("bad sidecar")]]),
    });
    expect(inspectFromRow(badSidecarIo)._tag).toBe("Unavailable");
    const badBinaryIo = makeIo({
      files: new Map([
        [paths.signature, sidecar],
        [paths.binary, Buffer.from("tampered shipped PE")],
      ]),
    });
    expect(inspectFromRow(badBinaryIo)).toEqual({
      _tag: "Unavailable",
      reason: "ArtifactHashMismatch-binary",
    });
    expect(
      inspect({
        ...snapshot,
        bundle: {
          ...snapshot.bundle,
          windowsOperatorTrustSet: {
            ...trust,
            revokedKeyIds: ["operator-2026-a"],
          },
        },
      }),
    ).toEqual({ _tag: "Unavailable", reason: "OperatorProvenanceInvalid" });
    expect(
      inspect({
        ...snapshot,
        bundle: {
          ...snapshot.bundle,
          providerRegistry: {
            ...snapshot.bundle.providerRegistry,
            entries: [],
          },
        },
      }),
    ).toEqual({
      _tag: "Unavailable",
      reason: "RegistryQualificationBindingMismatch",
    });
  });

  it("pins exact ordered canonical bytes and the complete manifest digest", () => {
    const encoded = encodeWindowsNativeArtifactManifestV1(manifest);
    expect(encoded).toBe(
      `{"version":1,"providerId":"windows-restricted-appcontainer-job","providerVersion":"t3d-v1","capabilityRevision":4,"osFamily":"Windows","osBuild":"10.0.19045","platformPrimitiveSetId":"windows-restricted-token-lowintegrity-appcontainer-job-namedpipe-v1","qualificationRows":[{"profile":"ReadOnly","networkMode":"Disabled","networkPolicyCodecVersion":1,"enforcementRuleSetDigest":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}],"sourceSha256":"78f0bfea837a1d0327c086803fd36b3c185c8fa2eb82e7cedfe47b36d6c79f62","compilerSha256":"f7b5dc6a453ff8256ac9c522470f0893e42c79a9386dd112ae041132d81a047c","compilerVersion":"4.8.9037.0","compilerArgumentsSha256":"be76aa19a68405ddef714a612c8ba2388ae939885cecf38cd2e94185c2ec0b24","binarySha256":"a936fa668d25bd61f2ab21c6bfc276e29df4db3dd1bce5cc1fccca9c5657b326","buildMethod":"fixed-framework64-csc","buildVersion":"1","testControlArtifactHashes":[{"artifactId":"control-token","sha256":"7532bc41ca424cf8cea7fb8578ae7689487c721e7b40f4af118d57ab65e4eae3"}],"limits":{"wallTimeMs":60000,"stdoutBytes":8192,"stderrBytes":8192,"processCount":4,"memoryBytes":268435456,"cpuTimeMs":30000},"operatorConfigRevision":3,"operatorConfigDigest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","discoveryMethod":"fixed-windows-build-probe","discoveryVersion":"1","matrixResults":[{"matrixId":"disabled-readonly","result":"Pass"}],"hostControls":[{"controlId":"appcontainer-token","artifactId":"control-token","result":"Pass"}]}`,
    );
    expect(hash(Buffer.from(encoded, "utf8"))).toBe(
      "e502199edae3e7b74c9fe6bd9681d727f537585b99d1b5983bbf9b013b4af234",
    );
    expect(decodeCanonicalWindowsNativeArtifactManifestV1(encoded)).toEqual(
      manifest,
    );
  });

  it.each([
    ["whitespace", manifestBytes.toString("utf8").replace(",", ", ")],
    ["BOM", `\uFEFF${manifestBytes.toString("utf8")}`],
    [
      "duplicate key",
      manifestBytes
        .toString("utf8")
        .replace('{"version":1,', '{"version":1,"version":1,'),
    ],
    [
      "unknown key",
      manifestBytes
        .toString("utf8")
        .replace('"version":1,', '"unknown":1,"version":1,'),
    ],
  ])("rejects noncanonical %s encodings", (_label, bytes) => {
    expect(
      decodeCanonicalWindowsNativeArtifactManifestV1(bytes),
    ).toBeUndefined();
  });

  it("encodes array keys in closed canonical order and rejects alternate array order", () => {
    const twoRows = encodeWindowsNativeArtifactManifestV1({
      ...manifest,
      matrixResults: [
        { matrixId: "z-last", result: "Pass" },
        { matrixId: "a-first", result: "Pass" },
      ],
    });
    expect(twoRows.indexOf('"matrixId":"a-first"')).toBeLessThan(
      twoRows.indexOf('"matrixId":"z-last"'),
    );
    const reversed = twoRows.replace(
      '[{"matrixId":"a-first","result":"Pass"},{"matrixId":"z-last","result":"Pass"}]',
      '[{"matrixId":"z-last","result":"Pass"},{"matrixId":"a-first","result":"Pass"}]',
    );
    expect(
      decodeCanonicalWindowsNativeArtifactManifestV1(reversed),
    ).toBeUndefined();
    const mixedRuleSetDigests = encodeWindowsNativeArtifactManifestV1({
      ...manifest,
      qualificationRows: [
        ...manifest.qualificationRows,
        {
          profile: "WorkspaceWrite",
          networkMode: "Disabled",
          networkPolicyCodecVersion: 1,
          enforcementRuleSetDigest: "a".repeat(64),
        },
      ],
    });
    expect(
      decodeCanonicalWindowsNativeArtifactManifestV1(mixedRuleSetDigests),
    ).toBeUndefined();
  });

  it("rejects path-like manifest metadata strings", () => {
    const pathMetadata = encodeWindowsNativeArtifactManifestV1({
      ...manifest,
      buildMethod: "C:/unsafe/build",
    });
    expect(
      decodeCanonicalWindowsNativeArtifactManifestV1(pathMetadata),
    ).toBeUndefined();
  });

  it.each(["Restricted", "Enabled"] as const)(
    "rejects %s rows at the D1 checkpoint",
    (networkMode) => {
      const altered = manifestBytes
        .toString("utf8")
        .replace('"networkMode":"Disabled"', `"networkMode":"${networkMode}"`);
      expect(
        decodeCanonicalWindowsNativeArtifactManifestV1(altered),
      ).toBeUndefined();
      const bytes = Buffer.from(altered, "utf8");
      const result = inspectWindowsNativeQualificationPaths(
        paths,
        {
          ...expected,
          qualificationEvidenceRef: `blob:sha256:${hash(bytes)}`,
        },
        verify,
        makeIo({ manifest: bytes }),
      );
      expect(result).toEqual({
        _tag: "Unavailable",
        reason: "ManifestCanonicalCodecInvalid",
      });
    },
  );

  it("validates fixed artifact bytes, exact tuple/config/limits, digest reference and supplied provenance", () => {
    const inspection = inspectWindowsNativeQualificationPaths(
      paths,
      {
        ...expected,
        qualificationEvidenceRef: `blob:sha256:${hash(manifestBytes)}`,
      },
      verify,
      makeIo(),
    );
    expect(inspection).toMatchObject({
      _tag: "ManifestVerified",
      manifestSha256: hash(manifestBytes),
      qualificationEvidenceRef: `blob:sha256:${hash(manifestBytes)}`,
    });
  });

  it.each([
    [
      "OS build",
      { ...expected, osBuild: "10.0.19044" },
      "ProviderOrOperatingSystemMismatch",
    ],
    [
      "provider version",
      { ...expected, providerVersion: "other" },
      "ProviderOrOperatingSystemMismatch",
    ],
    [
      "capability revision",
      { ...expected, capabilityRevision: 5 },
      "ProviderOrOperatingSystemMismatch",
    ],
    [
      "tuple",
      { ...expected, profile: "WorkspaceWrite" as const },
      "QualificationTupleMismatch",
    ],
    [
      "limits",
      { ...expected, limits: { ...expected.limits, memoryBytes: 1 } },
      "LimitsMismatch",
    ],
    [
      "operator config",
      { ...expected, operatorConfigRevision: 2 },
      "OperatorConfigMismatch",
    ],
    [
      "compiler version",
      { ...expected, compilerVersion: "other" },
      "BuildProvenanceMismatch",
    ],
    [
      "discovery version",
      { ...expected, discoveryVersion: "other" },
      "DiscoveryMethodMismatch",
    ],
    ["evidence reference", expected, "QualificationEvidenceRefMismatch"],
  ] as const)("fails closed for %s mismatch", (_label, input, reason) => {
    const result = inspectWindowsNativeQualificationPaths(
      paths,
      input,
      verify,
      makeIo(),
    );
    expect(result).toEqual({ _tag: "Unavailable", reason });
  });

  it("requires every matrix and recorded host control to pass", () => {
    for (const changed of [
      {
        ...manifest,
        matrixResults: [
          { matrixId: "disabled-readonly", result: "Unavailable" as const },
        ],
      },
      {
        ...manifest,
        hostControls: [
          {
            controlId: "appcontainer-token",
            artifactId: "control-token",
            result: "Fail" as const,
          },
        ],
      },
    ]) {
      const bytes = Buffer.from(
        encodeWindowsNativeArtifactManifestV1(changed),
        "utf8",
      );
      const result = inspectWindowsNativeQualificationPaths(
        paths,
        { ...expected, qualificationEvidenceRef: `blob:sha256:${hash(bytes)}` },
        verify,
        makeIo({ manifest: bytes }),
      );
      expect(result).toEqual({
        _tag: "Unavailable",
        reason: "QualificationEvidenceNotAllPassing",
      });
    }
  });

  it("fails closed when a verifier is absent or rejects the detached signature", () => {
    const qualifiedRef = `blob:sha256:${hash(manifestBytes)}`;
    expect(
      inspectWindowsNativeQualificationPaths(
        paths,
        { ...expected, qualificationEvidenceRef: qualifiedRef },
        undefined,
        makeIo(),
      ),
    ).toEqual({ _tag: "Unavailable", reason: "ProvenanceVerifierUnavailable" });
    expect(
      inspectWindowsNativeQualificationPaths(
        paths,
        { ...expected, qualificationEvidenceRef: qualifiedRef },
        { verify: () => false },
        makeIo(),
      ),
    ).toEqual({ _tag: "Unavailable", reason: "OperatorProvenanceInvalid" });
    expect(
      inspectWindowsNativeQualificationPaths(
        paths,
        { ...expected, qualificationEvidenceRef: qualifiedRef },
        {
          verify: () => {
            throw new Error("trust store unavailable");
          },
        },
        makeIo(),
      ),
    ).toEqual({ _tag: "Unavailable", reason: "OperatorProvenanceInvalid" });
  });

  it("fails closed when the detached signature file is empty", () => {
    const files = new Map([[paths.signature, Buffer.alloc(0)]]);
    expect(
      inspectWindowsNativeQualificationPaths(
        paths,
        {
          ...expected,
          qualificationEvidenceRef: `blob:sha256:${hash(manifestBytes)}`,
        },
        verify,
        makeIo({ files }),
      ),
    ).toEqual({ _tag: "Unavailable", reason: "SignatureEmpty" });
  });

  it("rejects missing/unreadable, redirected, invalid UTF-8 and hash-drifted files without leaking paths", () => {
    const cases = [
      makeIo({ failPath: paths.binary, failOperation: "lstat" }),
      makeIo({ redirectedPath: paths.source }),
      makeIo({ manifest: Buffer.from([0xc3, 0x28]) }),
      makeIo({ files: new Map([[paths.source, Buffer.from("drift")]]) }),
    ];
    for (const io of cases) {
      const result = inspectWindowsNativeQualificationPaths(
        paths,
        {
          ...expected,
          qualificationEvidenceRef: `blob:sha256:${hash(manifestBytes)}`,
        },
        verify,
        io,
      );
      expect(result._tag).toBe("Unavailable");
      expect(JSON.stringify(result)).not.toContain(paths.source);
      expect(JSON.stringify(result)).not.toContain("drift");
    }
  });

  it("fails closed on missing, symlinked and racing fixed artifacts", () => {
    const artifactPaths = [
      paths.source,
      paths.compiler,
      paths.binary,
      paths.manifest,
      paths.signature,
      win32.join(paths.testControlRoot, "control-token.artifact"),
    ];
    const expectedRef = `blob:sha256:${hash(manifestBytes)}`;
    for (const path of artifactPaths) {
      for (const failure of [
        makeIo({ failPath: path, failOperation: "lstat" }),
        makeIo({ failPath: path, failOperation: "realpath" }),
        makeIo({ failPath: path, failOperation: "read" }),
        makeIo({ symbolicPath: path }),
      ]) {
        const result = inspectWindowsNativeQualificationPaths(
          paths,
          { ...expected, qualificationEvidenceRef: expectedRef },
          verify,
          failure,
        );
        expect(result._tag).toBe("Unavailable");
        expect(JSON.stringify(result)).not.toContain(path);
      }
    }
  });

  it.each([
    ["source", paths.source],
    ["compiler", paths.compiler],
    ["binary", paths.binary],
    [
      "control artifact",
      win32.join(paths.testControlRoot, "control-token.artifact"),
    ],
  ])(
    "verifies the actual %s bytes against their manifest hashes",
    (_label, path) => {
      const result = inspectWindowsNativeQualificationPaths(
        paths,
        {
          ...expected,
          qualificationEvidenceRef: `blob:sha256:${hash(manifestBytes)}`,
        },
        verify,
        makeIo({ files: new Map([[path, Buffer.from("drift")]]) }),
      );
      expect(result).toMatchObject({ _tag: "Unavailable" });
      expect(JSON.stringify(result)).toContain("HashMismatch");
    },
  );

  it("pins fixed package and compiler paths and refuses a missing Windows verifier at entry", () => {
    expect(paths.source.replaceAll("\\", "/")).toMatch(
      /adapters\/sandbox-windows\/src\/native\/WindowsSandboxProcessHost\.cs$/u,
    );
    expect(paths.binary.replaceAll("\\", "/")).toMatch(
      /adapters\/sandbox-windows\/(?:src|dist)\/native\/WindowsSandboxProcessHost\.exe$/u,
    );
    expect(paths.manifest.replaceAll("\\", "/")).toMatch(
      /adapters\/sandbox-windows\/(?:src|dist)\/native\/qualification-manifest-v1\.json$/u,
    );
    expect(paths.signature.replaceAll("\\", "/")).toMatch(
      /adapters\/sandbox-windows\/(?:src|dist)\/native\/qualification-manifest-v1\.sig$/u,
    );
    expect(paths.compiler).toBe(
      "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
    );
    const entryPointResult =
      inspectFixedWindowsNativeQualificationManifest(expected);
    expect(entryPointResult._tag).toBe("Unavailable");
  });
});
