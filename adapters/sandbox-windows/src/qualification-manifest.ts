import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";

export type WindowsQualificationProfileV1 = "ReadOnly" | "WorkspaceWrite";
export type WindowsQualificationNetworkModeV1 =
  | "Disabled"
  | "Restricted"
  | "Enabled";

export interface WindowsNativeQualificationTupleV1 {
  readonly profile: WindowsQualificationProfileV1;
  readonly networkMode: WindowsQualificationNetworkModeV1;
  readonly networkPolicyCodecVersion: 1;
  readonly enforcementRuleSetDigest: string;
}

export interface WindowsNativeArtifactHashV1 {
  readonly artifactId: string;
  readonly sha256: string;
}

export interface WindowsNativeQualificationMatrixResultV1 {
  readonly matrixId: string;
  readonly result: "Pass" | "Fail" | "Unavailable";
}

export interface WindowsNativeQualificationHostControlV1 {
  readonly controlId: string;
  readonly artifactId: string;
  readonly result: "Pass" | "Fail" | "Unavailable";
}

export interface WindowsNativeQualificationLimitsV1 {
  readonly wallTimeMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly processCount: number;
  readonly memoryBytes: number;
  readonly cpuTimeMs: number;
}

/** The manifest intentionally has no self digest, evidence ref, or signature. */
export interface WindowsNativeArtifactManifestV1 {
  readonly version: 1;
  readonly providerId: "windows-restricted-appcontainer-job";
  readonly providerVersion: string;
  readonly capabilityRevision: number;
  readonly osFamily: "Windows";
  readonly osBuild: string;
  readonly platformPrimitiveSetId: "windows-restricted-token-lowintegrity-appcontainer-job-namedpipe-v1";
  readonly qualificationRows: ReadonlyArray<WindowsNativeQualificationTupleV1>;
  readonly sourceSha256: string;
  readonly compilerSha256: string;
  readonly compilerVersion: string;
  readonly compilerArgumentsSha256: string;
  readonly binarySha256: string;
  readonly buildMethod: string;
  readonly buildVersion: string;
  readonly testControlArtifactHashes: ReadonlyArray<WindowsNativeArtifactHashV1>;
  readonly limits: WindowsNativeQualificationLimitsV1;
  readonly operatorConfigRevision: number;
  readonly operatorConfigDigest: string;
  readonly discoveryMethod: string;
  readonly discoveryVersion: string;
  readonly matrixResults: ReadonlyArray<WindowsNativeQualificationMatrixResultV1>;
  readonly hostControls: ReadonlyArray<WindowsNativeQualificationHostControlV1>;
}

const digestPattern = /^[0-9a-f]{64}$/u;
const identifierPattern = /^[a-z][a-z0-9._-]{0,95}$/u;
const canonicalTextPattern = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;
const profileOrder: Readonly<Record<WindowsQualificationProfileV1, number>> = {
  ReadOnly: 0,
  WorkspaceWrite: 1,
};
const networkModeOrder: Readonly<
  Record<WindowsQualificationNetworkModeV1, number>
> = {
  Disabled: 0,
  Restricted: 1,
  Enabled: 2,
};

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const exactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
): boolean =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));

const canonicalText = (value: unknown): value is string =>
  typeof value === "string" && canonicalTextPattern.test(value);

const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

const digest = (value: unknown): value is string =>
  typeof value === "string" && digestPattern.test(value);

const encodeTuple = (tuple: WindowsNativeQualificationTupleV1): string =>
  `{"profile":${JSON.stringify(tuple.profile)},"networkMode":${JSON.stringify(tuple.networkMode)},"networkPolicyCodecVersion":1,"enforcementRuleSetDigest":${JSON.stringify(tuple.enforcementRuleSetDigest)}}`;

const encodeArtifactHash = (artifact: WindowsNativeArtifactHashV1): string =>
  `{"artifactId":${JSON.stringify(artifact.artifactId)},"sha256":${JSON.stringify(artifact.sha256)}}`;

const encodeMatrixResult = (
  result: WindowsNativeQualificationMatrixResultV1,
): string =>
  `{"matrixId":${JSON.stringify(result.matrixId)},"result":${JSON.stringify(result.result)}}`;

const encodeHostControl = (
  control: WindowsNativeQualificationHostControlV1,
): string =>
  `{"controlId":${JSON.stringify(control.controlId)},"artifactId":${JSON.stringify(control.artifactId)},"result":${JSON.stringify(control.result)}}`;

const canonicalRows = (
  rows: ReadonlyArray<WindowsNativeQualificationTupleV1>,
) =>
  [...rows].sort(
    (left, right) =>
      profileOrder[left.profile] - profileOrder[right.profile] ||
      networkModeOrder[left.networkMode] - networkModeOrder[right.networkMode],
  );

export const encodeWindowsNativeArtifactManifestV1 = (
  manifest: WindowsNativeArtifactManifestV1,
): string =>
  `{"version":1,"providerId":"windows-restricted-appcontainer-job","providerVersion":${JSON.stringify(manifest.providerVersion)},"capabilityRevision":${manifest.capabilityRevision},"osFamily":"Windows","osBuild":${JSON.stringify(manifest.osBuild)},"platformPrimitiveSetId":"windows-restricted-token-lowintegrity-appcontainer-job-namedpipe-v1","qualificationRows":[${canonicalRows(manifest.qualificationRows).map(encodeTuple).join(",")}],"sourceSha256":${JSON.stringify(manifest.sourceSha256)},"compilerSha256":${JSON.stringify(manifest.compilerSha256)},"compilerVersion":${JSON.stringify(manifest.compilerVersion)},"compilerArgumentsSha256":${JSON.stringify(manifest.compilerArgumentsSha256)},"binarySha256":${JSON.stringify(manifest.binarySha256)},"buildMethod":${JSON.stringify(manifest.buildMethod)},"buildVersion":${JSON.stringify(manifest.buildVersion)},"testControlArtifactHashes":[${[
    ...manifest.testControlArtifactHashes,
  ]
    .sort((a, b) => compare(a.artifactId, b.artifactId))
    .map(encodeArtifactHash)
    .join(
      ",",
    )}],"limits":{"wallTimeMs":${manifest.limits.wallTimeMs},"stdoutBytes":${manifest.limits.stdoutBytes},"stderrBytes":${manifest.limits.stderrBytes},"processCount":${manifest.limits.processCount},"memoryBytes":${manifest.limits.memoryBytes},"cpuTimeMs":${manifest.limits.cpuTimeMs}},"operatorConfigRevision":${manifest.operatorConfigRevision},"operatorConfigDigest":${JSON.stringify(manifest.operatorConfigDigest)},"discoveryMethod":${JSON.stringify(manifest.discoveryMethod)},"discoveryVersion":${JSON.stringify(manifest.discoveryVersion)},"matrixResults":[${[
    ...manifest.matrixResults,
  ]
    .sort((a, b) => compare(a.matrixId, b.matrixId))
    .map(encodeMatrixResult)
    .join(",")}],"hostControls":[${[...manifest.hostControls]
    .sort((a, b) => compare(a.controlId, b.controlId))
    .map(encodeHostControl)
    .join(",")}]}`;

const decodeTuple = (
  input: unknown,
): WindowsNativeQualificationTupleV1 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  if (
    !exactKeys(value, [
      "profile",
      "networkMode",
      "networkPolicyCodecVersion",
      "enforcementRuleSetDigest",
    ]) ||
    (value.profile !== "ReadOnly" && value.profile !== "WorkspaceWrite") ||
    (value.networkMode !== "Disabled" &&
      value.networkMode !== "Restricted" &&
      value.networkMode !== "Enabled") ||
    value.networkPolicyCodecVersion !== 1 ||
    !digest(value.enforcementRuleSetDigest)
  )
    return undefined;
  return {
    profile: value.profile,
    networkMode: value.networkMode,
    networkPolicyCodecVersion: 1,
    enforcementRuleSetDigest: value.enforcementRuleSetDigest,
  };
};

const decodeArtifactHash = (
  input: unknown,
): WindowsNativeArtifactHashV1 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  if (
    !exactKeys(value, ["artifactId", "sha256"]) ||
    typeof value.artifactId !== "string" ||
    !identifierPattern.test(value.artifactId) ||
    !digest(value.sha256)
  )
    return undefined;
  return { artifactId: value.artifactId, sha256: value.sha256 };
};

const decodeMatrixResult = (
  input: unknown,
): WindowsNativeQualificationMatrixResultV1 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  if (
    !exactKeys(value, ["matrixId", "result"]) ||
    typeof value.matrixId !== "string" ||
    !identifierPattern.test(value.matrixId) ||
    (value.result !== "Pass" &&
      value.result !== "Fail" &&
      value.result !== "Unavailable")
  )
    return undefined;
  return { matrixId: value.matrixId, result: value.result };
};

const decodeHostControl = (
  input: unknown,
): WindowsNativeQualificationHostControlV1 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  if (
    !exactKeys(value, ["controlId", "artifactId", "result"]) ||
    typeof value.controlId !== "string" ||
    !identifierPattern.test(value.controlId) ||
    typeof value.artifactId !== "string" ||
    !identifierPattern.test(value.artifactId) ||
    (value.result !== "Pass" &&
      value.result !== "Fail" &&
      value.result !== "Unavailable")
  )
    return undefined;
  return {
    controlId: value.controlId,
    artifactId: value.artifactId,
    result: value.result,
  };
};

const manifestKeys = [
  "version",
  "providerId",
  "providerVersion",
  "capabilityRevision",
  "osFamily",
  "osBuild",
  "platformPrimitiveSetId",
  "qualificationRows",
  "sourceSha256",
  "compilerSha256",
  "compilerVersion",
  "compilerArgumentsSha256",
  "binarySha256",
  "buildMethod",
  "buildVersion",
  "testControlArtifactHashes",
  "limits",
  "operatorConfigRevision",
  "operatorConfigDigest",
  "discoveryMethod",
  "discoveryVersion",
  "matrixResults",
  "hostControls",
] as const;

const isSortedUnique = <A>(
  values: ReadonlyArray<A>,
  key: (value: A) => string,
): boolean => {
  const keys = values.map(key);
  return keys.every(
    (value, index) => index === 0 || compare(keys[index - 1] ?? "", value) < 0,
  );
};

const decodeLimits = (
  input: unknown,
): WindowsNativeQualificationLimitsV1 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  const keys = [
    "wallTimeMs",
    "stdoutBytes",
    "stderrBytes",
    "processCount",
    "memoryBytes",
    "cpuTimeMs",
  ];
  if (
    !exactKeys(value, keys) ||
    !keys.every((key) => positiveInteger(value[key]))
  )
    return undefined;
  return {
    wallTimeMs: value.wallTimeMs as number,
    stdoutBytes: value.stdoutBytes as number,
    stderrBytes: value.stderrBytes as number,
    processCount: value.processCount as number,
    memoryBytes: value.memoryBytes as number,
    cpuTimeMs: value.cpuTimeMs as number,
  };
};

export const decodeWindowsNativeArtifactManifestV1 = (
  input: unknown,
): WindowsNativeArtifactManifestV1 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  if (
    !exactKeys(value, manifestKeys) ||
    value.version !== 1 ||
    value.providerId !== "windows-restricted-appcontainer-job" ||
    !canonicalText(value.providerVersion) ||
    !positiveInteger(value.capabilityRevision) ||
    value.osFamily !== "Windows" ||
    !canonicalText(value.osBuild) ||
    value.platformPrimitiveSetId !==
      "windows-restricted-token-lowintegrity-appcontainer-job-namedpipe-v1" ||
    !Array.isArray(value.qualificationRows) ||
    !digest(value.sourceSha256) ||
    !digest(value.compilerSha256) ||
    !canonicalText(value.compilerVersion) ||
    !digest(value.compilerArgumentsSha256) ||
    !digest(value.binarySha256) ||
    !canonicalText(value.buildMethod) ||
    !canonicalText(value.buildVersion) ||
    !Array.isArray(value.testControlArtifactHashes) ||
    !positiveInteger(value.operatorConfigRevision) ||
    !digest(value.operatorConfigDigest) ||
    !canonicalText(value.discoveryMethod) ||
    !canonicalText(value.discoveryVersion) ||
    !Array.isArray(value.matrixResults) ||
    !Array.isArray(value.hostControls)
  )
    return undefined;
  const qualificationRows = value.qualificationRows.map(decodeTuple);
  const testControlArtifactHashes =
    value.testControlArtifactHashes.map(decodeArtifactHash);
  const matrixResults = value.matrixResults.map(decodeMatrixResult);
  const hostControls = value.hostControls.map(decodeHostControl);
  const limits = decodeLimits(value.limits);
  if (
    limits === undefined ||
    qualificationRows.length === 0 ||
    qualificationRows.some((row) => row === undefined) ||
    testControlArtifactHashes.length === 0 ||
    testControlArtifactHashes.some((artifact) => artifact === undefined) ||
    matrixResults.length === 0 ||
    matrixResults.some((matrix) => matrix === undefined) ||
    hostControls.length === 0 ||
    hostControls.some((control) => control === undefined)
  )
    return undefined;
  const rows = qualificationRows as Array<WindowsNativeQualificationTupleV1>;
  const artifacts =
    testControlArtifactHashes as Array<WindowsNativeArtifactHashV1>;
  const matrices =
    matrixResults as Array<WindowsNativeQualificationMatrixResultV1>;
  const controls =
    hostControls as Array<WindowsNativeQualificationHostControlV1>;
  if (
    !isSortedUnique(
      rows,
      (row) =>
        `${profileOrder[row.profile]}:${networkModeOrder[row.networkMode]}`,
    ) ||
    !isSortedUnique(artifacts, (artifact) => artifact.artifactId) ||
    !isSortedUnique(matrices, (matrix) => matrix.matrixId) ||
    !isSortedUnique(controls, (control) => control.controlId) ||
    new Set(rows.map((row) => `${row.profile}:${row.networkMode}`)).size !==
      rows.length ||
    new Set(rows.map((row) => row.enforcementRuleSetDigest)).size !== 1 ||
    controls.some(
      (control) =>
        !artifacts.some(
          (artifact) => artifact.artifactId === control.artifactId,
        ),
    )
  )
    return undefined;
  return {
    version: 1,
    providerId: "windows-restricted-appcontainer-job",
    providerVersion: value.providerVersion,
    capabilityRevision: value.capabilityRevision,
    osFamily: "Windows",
    osBuild: value.osBuild,
    platformPrimitiveSetId:
      "windows-restricted-token-lowintegrity-appcontainer-job-namedpipe-v1",
    qualificationRows: rows,
    sourceSha256: value.sourceSha256,
    compilerSha256: value.compilerSha256,
    compilerVersion: value.compilerVersion,
    compilerArgumentsSha256: value.compilerArgumentsSha256,
    binarySha256: value.binarySha256,
    buildMethod: value.buildMethod,
    buildVersion: value.buildVersion,
    testControlArtifactHashes: artifacts,
    limits,
    operatorConfigRevision: value.operatorConfigRevision,
    operatorConfigDigest: value.operatorConfigDigest,
    discoveryMethod: value.discoveryMethod,
    discoveryVersion: value.discoveryVersion,
    matrixResults: matrices,
    hostControls: controls,
  };
};

export const decodeCanonicalWindowsNativeArtifactManifestV1 = (
  json: string,
): WindowsNativeArtifactManifestV1 | undefined => {
  try {
    const manifest = decodeWindowsNativeArtifactManifestV1(JSON.parse(json));
    return manifest !== undefined &&
      encodeWindowsNativeArtifactManifestV1(manifest) === json
      ? manifest
      : undefined;
  } catch {
    return undefined;
  }
};

export const WINDOWS_NATIVE_PROCESS_HOST_COMPILER_ARGUMENTS_V1 = [
  "/nologo",
  "/warnaserror",
  "/platform:x64",
  "/reference:System.dll",
  "/reference:System.Core.dll",
  "/reference:System.Security.dll",
  "/target:exe",
  "/out:<adapter-dist-native>/WindowsSandboxProcessHost.exe",
  "<adapter-src-native>/WindowsSandboxProcessHost.cs",
] as const;

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

export const fixedWindowsNativeProductionArtifactPaths = () => ({
  source: fileURLToPath(
    new URL("../src/native/WindowsSandboxProcessHost.cs", import.meta.url),
  ),
  compiler: win32.join(
    "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  ),
  binary: fileURLToPath(
    new URL("./native/WindowsSandboxProcessHost.exe", import.meta.url),
  ),
  manifest: fileURLToPath(
    new URL("./native/qualification-manifest-v1.json", import.meta.url),
  ),
  signature: fileURLToPath(
    new URL("./native/qualification-manifest-v1.sig", import.meta.url),
  ),
  testControlRoot: fileURLToPath(
    new URL("./native/test-controls/", import.meta.url),
  ),
});

export interface WindowsNativeQualificationIo {
  readonly lstat: (path: string) => {
    readonly isFile: () => boolean;
    readonly isDirectory: () => boolean;
    readonly isSymbolicLink: () => boolean;
  };
  readonly realpath: (path: string) => string;
  readonly read: (path: string) => Buffer;
}

const qualificationIo: WindowsNativeQualificationIo = {
  lstat: lstatSync,
  realpath: realpathSync.native,
  read: readFileSync,
};

export interface WindowsNativeQualificationExpectationV1 {
  readonly providerId: "windows-restricted-appcontainer-job";
  readonly providerVersion: string;
  readonly capabilityRevision: number;
  readonly osBuild: string;
  readonly profile: WindowsQualificationProfileV1;
  readonly networkMode: WindowsQualificationNetworkModeV1;
  readonly enforcementRuleSetDigest: string;
  readonly qualificationEvidenceRef: string;
  readonly operatorConfigRevision: number;
  readonly operatorConfigDigest: string;
  readonly limits: WindowsNativeQualificationLimitsV1;
  readonly compilerVersion: string;
  readonly buildMethod: string;
  readonly buildVersion: string;
  readonly discoveryMethod: string;
  readonly discoveryVersion: string;
}

export interface WindowsNativeQualificationProvenanceVerifier {
  /** Must verify the detached signature using an externally accepted trust
   * anchor. The adapter intentionally has no default key or verifier. */
  readonly verify: (input: {
    readonly manifestBytes: Buffer;
    readonly signatureBytes: Buffer;
    readonly manifestSha256: string;
  }) => boolean;
}

export type WindowsNativeQualificationInspection =
  | { readonly _tag: "Unavailable"; readonly reason: string }
  | {
      readonly _tag: "ManifestVerified";
      readonly manifest: WindowsNativeArtifactManifestV1;
      readonly manifestSha256: string;
      readonly qualificationEvidenceRef: string;
    };

const unavailable = (reason: string): WindowsNativeQualificationInspection => ({
  _tag: "Unavailable",
  reason,
});

const readExactFile = (
  path: string,
  label: string,
  io: WindowsNativeQualificationIo,
): Buffer | WindowsNativeQualificationInspection => {
  try {
    const finalPath = io.realpath(path);
    const normalizedPath = win32.normalize(path).toLowerCase();
    if (win32.normalize(finalPath).toLowerCase() !== normalizedPath)
      return unavailable(`${label}PathRedirected`);
    const info = io.lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      return unavailable(`${label}NotRegularFile`);
    const finalInfo = io.lstat(finalPath);
    if (!finalInfo.isFile() || finalInfo.isSymbolicLink())
      return unavailable(`${label}FinalPathNotRegularFile`);
    const bytes = io.read(finalPath);
    return bytes.length === 0 ? unavailable(`${label}Empty`) : bytes;
  } catch {
    return unavailable(`${label}Unavailable`);
  }
};

const readManifestText = (bytes: Buffer): string | undefined => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
  } catch {
    return undefined;
  }
};

const sameLimits = (
  left: WindowsNativeQualificationLimitsV1,
  right: WindowsNativeQualificationLimitsV1,
) =>
  left.wallTimeMs === right.wallTimeMs &&
  left.stdoutBytes === right.stdoutBytes &&
  left.stderrBytes === right.stderrBytes &&
  left.processCount === right.processCount &&
  left.memoryBytes === right.memoryBytes &&
  left.cpuTimeMs === right.cpuTimeMs;

export const inspectWindowsNativeQualificationPaths = (
  paths: ReturnType<typeof fixedWindowsNativeProductionArtifactPaths>,
  expected: WindowsNativeQualificationExpectationV1,
  verifier: WindowsNativeQualificationProvenanceVerifier | undefined,
  io: WindowsNativeQualificationIo = qualificationIo,
): WindowsNativeQualificationInspection => {
  if (verifier === undefined)
    return unavailable("ProvenanceVerifierUnavailable");
  const manifestBytes = readExactFile(paths.manifest, "Manifest", io);
  if (!Buffer.isBuffer(manifestBytes)) return manifestBytes;
  const signatureBytes = readExactFile(paths.signature, "Signature", io);
  if (!Buffer.isBuffer(signatureBytes)) return signatureBytes;
  const manifestText = readManifestText(manifestBytes);
  if (manifestText === undefined) return unavailable("ManifestUtf8Invalid");
  const manifest = decodeCanonicalWindowsNativeArtifactManifestV1(manifestText);
  if (manifest === undefined)
    return unavailable("ManifestCanonicalCodecInvalid");
  if (
    manifest.matrixResults.some((matrix) => matrix.result !== "Pass") ||
    manifest.hostControls.some((control) => control.result !== "Pass")
  )
    return unavailable("QualificationEvidenceNotAllPassing");
  const expectedRow = manifest.qualificationRows.filter(
    (row) =>
      row.profile === expected.profile &&
      row.networkMode === expected.networkMode &&
      row.enforcementRuleSetDigest === expected.enforcementRuleSetDigest,
  );
  if (expectedRow.length !== 1)
    return unavailable("QualificationTupleMismatch");
  if (
    manifest.providerId !== expected.providerId ||
    manifest.providerVersion !== expected.providerVersion ||
    manifest.capabilityRevision !== expected.capabilityRevision ||
    manifest.osBuild !== expected.osBuild
  )
    return unavailable("ProviderOrOperatingSystemMismatch");
  if (
    manifest.operatorConfigRevision !== expected.operatorConfigRevision ||
    manifest.operatorConfigDigest !== expected.operatorConfigDigest
  )
    return unavailable("OperatorConfigMismatch");
  if (
    manifest.compilerVersion !== expected.compilerVersion ||
    manifest.buildMethod !== expected.buildMethod ||
    manifest.buildVersion !== expected.buildVersion
  )
    return unavailable("BuildProvenanceMismatch");
  if (
    manifest.discoveryMethod !== expected.discoveryMethod ||
    manifest.discoveryVersion !== expected.discoveryVersion
  )
    return unavailable("DiscoveryMethodMismatch");
  if (!sameLimits(manifest.limits, expected.limits))
    return unavailable("LimitsMismatch");

  const artifactPaths = [
    { id: "source", path: paths.source, expected: manifest.sourceSha256 },
    { id: "compiler", path: paths.compiler, expected: manifest.compilerSha256 },
    { id: "binary", path: paths.binary, expected: manifest.binarySha256 },
    ...manifest.testControlArtifactHashes.map((artifact) => ({
      id: artifact.artifactId,
      path: win32.join(
        paths.testControlRoot,
        `${artifact.artifactId}.artifact`,
      ),
      expected: artifact.sha256,
    })),
  ];
  const observedArtifactIds = new Set<string>();
  for (const artifact of artifactPaths) {
    if (observedArtifactIds.has(artifact.id))
      return unavailable("ArtifactIdentityDuplicate");
    observedArtifactIds.add(artifact.id);
    const bytes = readExactFile(artifact.path, `Artifact-${artifact.id}`, io);
    if (!Buffer.isBuffer(bytes)) return bytes;
    if (sha256(bytes) !== artifact.expected)
      return unavailable(`ArtifactHashMismatch-${artifact.id}`);
  }
  const argumentDigest = createHash("sha256")
    .update(
      WINDOWS_NATIVE_PROCESS_HOST_COMPILER_ARGUMENTS_V1.join("\n"),
      "utf8",
    )
    .digest("hex");
  if (manifest.compilerArgumentsSha256 !== argumentDigest)
    return unavailable("CompilerArgumentsMismatch");
  for (const control of manifest.hostControls) {
    if (
      !manifest.testControlArtifactHashes.some(
        (artifact) => artifact.artifactId === control.artifactId,
      )
    )
      return unavailable("HostControlArtifactBindingMismatch");
  }
  const manifestSha256 = sha256(manifestBytes);
  const qualificationEvidenceRef = `blob:sha256:${manifestSha256}`;
  if (expected.qualificationEvidenceRef !== qualificationEvidenceRef)
    return unavailable("QualificationEvidenceRefMismatch");
  try {
    if (
      !verifier.verify({
        manifestBytes,
        signatureBytes,
        manifestSha256,
      })
    )
      return unavailable("OperatorProvenanceInvalid");
  } catch {
    return unavailable("OperatorProvenanceInvalid");
  }
  return {
    _tag: "ManifestVerified",
    manifest,
    manifestSha256,
    qualificationEvidenceRef,
  };
};

export const inspectFixedWindowsNativeQualificationManifest = (
  expected: WindowsNativeQualificationExpectationV1,
  verifier?: WindowsNativeQualificationProvenanceVerifier,
): WindowsNativeQualificationInspection => {
  if (process.platform !== "win32") return unavailable("WindowsHostRequired");
  try {
    return inspectWindowsNativeQualificationPaths(
      fixedWindowsNativeProductionArtifactPaths(),
      expected,
      verifier,
    );
  } catch {
    return unavailable("NativeQualificationInspectionFailed");
  }
};
