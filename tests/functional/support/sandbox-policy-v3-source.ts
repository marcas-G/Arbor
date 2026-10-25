import { createHash, createPrivateKey, sign } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { release } from "node:os";
import { dirname, join, win32 } from "node:path";
import {
  encodeWindowsNativeArtifactManifestV1,
  fixedWindowsNativeProductionArtifactPaths,
  WINDOWS_NATIVE_PROCESS_HOST_COMPILER_ARGUMENTS_V1,
  type WindowsNativeArtifactManifestV1,
} from "../../../adapters/sandbox-windows/dist/index.js";
import {
  encodeSandboxAuthorityBundleV3,
  encodeSandboxAuthorityHighWaterV3,
  encodeSandboxEnforcementRuleSetV1,
  encodeSandboxOperatorPolicyConfigV1,
  encodeSandboxPolicyGrantIssuerConfigV1,
  encodeSandboxProviderQualificationRegistryV1,
  encodeWindowsNativeManifestSignatureV1,
  encodeWindowsNativeOperatorTrustSetV1,
  Principal,
  parse,
  type SandboxAuthorityBundleV3,
  type SandboxProviderQualificationEntryV1,
  sandboxEnforcementRuleSetV1ForProvider,
} from "../../../packages/domain/src/index.js";
import { setP39PrivateWindowsAcl } from "../../support/p39-windows-deployment-test.js";

const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

const reparsePoint = (stats: Stats) =>
  stats.isSymbolicLink() ||
  (((stats as typeof stats & { readonly attributes?: number }).attributes ??
    0) &
    0x400) !==
    0;

const artifactError = (path: string, classification: string) =>
  new Error(`synthetic D2 artifact ${path}: ${classification}`);

const lstatArtifact = (path: string) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw artifactError(path, "LstatFailed");
  }
};

const fixedArtifactBytesOrSynthetic = (
  path: string,
  syntheticBytes: Buffer,
): Buffer => {
  const stats = lstatArtifact(path);
  if (stats === undefined) return syntheticBytes;
  if (reparsePoint(stats) || !stats.isFile())
    throw artifactError(path, "ExistingTargetNotRegularFile");
  try {
    return readFileSync(path);
  } catch {
    throw artifactError(path, "ExistingTargetUnreadable");
  }
};

const limits = {
  wallTimeMs: 60_000,
  stdoutBytes: 8192,
  stderrBytes: 8192,
  processCount: 4,
  memoryBytes: 268_435_456,
  cpuTimeMs: 30_000,
};

export interface SandboxPolicyV3TestPair {
  readonly sourceIdentity: string;
  readonly bundleCanonicalJson: string;
  readonly highWaterCanonicalJson: string;
  readonly bundle: SandboxAuthorityBundleV3;
  readonly bundleDigest: string;
  readonly manifestBytes: Buffer;
  readonly signatureBytes: Buffer;
  readonly sourceArtifactBytes: Buffer;
  readonly binaryArtifactBytes: Buffer;
  readonly compilerArtifactBytes: Buffer;
  readonly controlArtifactBytes: Buffer;
}

/** Produces a disposable V3 authority pair and a genuine signed synthetic
 * Windows qualification manifest for tests. The manifest still flows through
 * the production D2 verifier; no provider is launched by this helper. */
export const sandboxPolicyV3TestPair = (input?: {
  readonly bundleRevision?: number;
  readonly registryRevision?: number;
  readonly includeRegistryDrift?: boolean;
}): SandboxPolicyV3TestPair => {
  if (process.platform !== "win32")
    throw new Error("V3 Windows qualification fixture requires Windows");
  const paths = fixedWindowsNativeProductionArtifactPaths();
  const providerId = "windows-restricted-appcontainer-job";
  const providerVersion = "t3d-v1";
  const capabilityRevision = 4;
  const osBuild = release();
  const ruleSet = sandboxEnforcementRuleSetV1ForProvider(providerId);
  if (ruleSet === undefined) throw new Error("Windows provider ruleset absent");
  const unavailableRuleSet =
    sandboxEnforcementRuleSetV1ForProvider("windows-mxc");
  if (unavailableRuleSet === undefined)
    throw new Error("Windows MXC ruleset absent");
  const enforcementRuleSetDigest = hash(
    encodeSandboxEnforcementRuleSetV1(ruleSet),
  );
  const syntheticSourceArtifactBytes = Buffer.from(
    "synthetic V6 qualification-only process host source\n",
    "utf8",
  );
  const sourceArtifactBytes = fixedArtifactBytesOrSynthetic(
    paths.source,
    syntheticSourceArtifactBytes,
  );
  const compilerArtifactBytes = readFileSync(paths.compiler);
  const syntheticBinaryArtifactBytes = Buffer.from(
    "synthetic V6 qualification-only PE artifact; never executed\n",
    "utf8",
  );
  const binaryArtifactBytes = fixedArtifactBytesOrSynthetic(
    paths.binary,
    syntheticBinaryArtifactBytes,
  );
  const controlArtifactBytes = Buffer.from(
    "synthetic V6 qualification-only control artifact\n",
    "utf8",
  );
  const issuerConfig = {
    version: 1 as const,
    revision: 1,
    issuers: [
      parse(Principal)("user:local"),
      parse(Principal)("user:operator"),
    ],
  };
  const operatorConfig = {
    version: 1 as const,
    revision: 1,
    environmentAllowlist: ["PATH"],
    limitsByProfile: (
      ["ReadOnly", "WorkspaceWrite", "FullAccess"] as const
    ).map((profile) => ({ profile, limits })),
    trustedLocalRuntimeVersion: "builtin-v1" as const,
  };
  const operatorConfigDigest = hash(
    encodeSandboxOperatorPolicyConfigV1(operatorConfig),
  );
  const manifest: WindowsNativeArtifactManifestV1 = {
    version: 1,
    providerId,
    providerVersion,
    capabilityRevision,
    osFamily: "Windows",
    osBuild,
    platformPrimitiveSetId:
      "windows-restricted-token-lowintegrity-appcontainer-job-namedpipe-v1",
    qualificationRows: [
      {
        profile: "ReadOnly",
        networkMode: "Disabled",
        networkPolicyCodecVersion: 1,
        enforcementRuleSetDigest,
      },
    ],
    sourceSha256: hash(sourceArtifactBytes),
    compilerSha256: hash(compilerArtifactBytes),
    compilerVersion: "4.8.9037.0",
    compilerArgumentsSha256: hash(
      WINDOWS_NATIVE_PROCESS_HOST_COMPILER_ARGUMENTS_V1.join("\n"),
    ),
    binarySha256: hash(binaryArtifactBytes),
    buildMethod: "fixed-framework64-csc",
    buildVersion: "1",
    testControlArtifactHashes: [
      { artifactId: "control-token", sha256: hash(controlArtifactBytes) },
    ],
    limits,
    operatorConfigRevision: operatorConfig.revision,
    operatorConfigDigest,
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
  const manifestBytes = Buffer.from(
    encodeWindowsNativeArtifactManifestV1(manifest),
    "utf8",
  );
  const qualificationEvidenceRef = `blob:sha256:${hash(manifestBytes)}`;
  const supportedRow: SandboxProviderQualificationEntryV1 = {
    providerId,
    providerVersion,
    capabilityRevision,
    osFamily: "Windows",
    osBuild,
    tuple: {
      profile: "ReadOnly",
      networkMode: "Disabled",
      networkPolicyCodecVersion: 1,
      enforcementRuleSetDigest,
    },
    status: "Supported",
    qualificationEvidenceRef,
  };
  const unavailableRow: SandboxProviderQualificationEntryV1 = {
    providerId: "windows-mxc",
    providerVersion: "mxc-test-v1",
    capabilityRevision: 1,
    osFamily: "Windows",
    osBuild,
    tuple: {
      profile: "WorkspaceWrite",
      networkMode: "Disabled",
      networkPolicyCodecVersion: 1,
      enforcementRuleSetDigest: hash(
        encodeSandboxEnforcementRuleSetV1(unavailableRuleSet),
      ),
    },
    status: "Unavailable",
    qualificationEvidenceRef: null,
  };
  const registry = {
    version: 1 as const,
    revision: input?.registryRevision ?? 1,
    entries:
      input?.includeRegistryDrift === true
        ? [unavailableRow, supportedRow]
        : [supportedRow],
  };
  const trustSet = {
    version: 1 as const,
    revision: 1,
    sourceIdentity: "host:sandbox-policy-v6-v3-process-test",
    providerId: "windows-restricted-appcontainer-job" as const,
    keys: [
      {
        keyId: "operator-2026-a",
        algorithm: "Ed25519" as const,
        publicKeySpkiDerBase64:
          "MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=",
        publicKeySpkiSha256:
          "06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9",
        validFrom: "2026-10-20T00:00:00.000Z",
        validUntil: "2027-10-20T00:00:00.000Z",
        status: "Active" as const,
      },
    ],
    revokedKeyIds: [] as string[],
  };
  const bundle: SandboxAuthorityBundleV3 = {
    version: 3,
    sourceIdentity: trustSet.sourceIdentity,
    bundleRevision: input?.bundleRevision ?? 1,
    issuerConfigRevision: issuerConfig.revision,
    issuerConfigDigest: hash(
      encodeSandboxPolicyGrantIssuerConfigV1(issuerConfig),
    ),
    issuerConfig,
    operatorConfigRevision: operatorConfig.revision,
    operatorConfigDigest,
    operatorConfig,
    providerRegistryRevision: registry.revision,
    providerRegistryDigest: hash(
      encodeSandboxProviderQualificationRegistryV1(registry),
    ),
    providerRegistry: registry,
    windowsOperatorTrustSetRevision: trustSet.revision,
    windowsOperatorTrustSetDigest: hash(
      encodeWindowsNativeOperatorTrustSetV1(trustSet),
    ),
    windowsOperatorTrustSet: trustSet,
  };
  const bundleCanonicalJson = encodeSandboxAuthorityBundleV3(bundle);
  const bundleDigest = hash(bundleCanonicalJson);
  const highWaterCanonicalJson = encodeSandboxAuthorityHighWaterV3({
    version: 3,
    sourceIdentity: bundle.sourceIdentity,
    bundleRevision: bundle.bundleRevision,
    bundleDigest,
    issuerConfigRevision: bundle.issuerConfigRevision,
    issuerConfigDigest: bundle.issuerConfigDigest,
    operatorConfigRevision: bundle.operatorConfigRevision,
    operatorConfigDigest: bundle.operatorConfigDigest,
    providerRegistryRevision: bundle.providerRegistryRevision,
    providerRegistryDigest: bundle.providerRegistryDigest,
    windowsOperatorTrustSetRevision: bundle.windowsOperatorTrustSetRevision,
    windowsOperatorTrustSetDigest: bundle.windowsOperatorTrustSetDigest,
  });
  const seed = Buffer.from(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  );
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(
    null,
    Buffer.concat([
      Buffer.from("Arbor.WindowsNativeQualificationManifestV1\0", "ascii"),
      manifestBytes,
    ]),
    privateKey,
  );
  const signatureBytes = Buffer.from(
    encodeWindowsNativeManifestSignatureV1({
      version: 1,
      keyId: "operator-2026-a",
      signatureBase64: signature.toString("base64"),
    }),
    "utf8",
  );
  return {
    sourceIdentity: bundle.sourceIdentity,
    bundleCanonicalJson,
    highWaterCanonicalJson,
    bundle,
    bundleDigest,
    manifestBytes,
    signatureBytes,
    sourceArtifactBytes,
    binaryArtifactBytes,
    compilerArtifactBytes,
    controlArtifactBytes,
  };
};

const writePair = (
  filename: string,
  value: {
    readonly sourceIdentity: string;
    readonly bundleCanonicalJson: string;
    readonly highWaterCanonicalJson: string;
  },
) => {
  const temporary = `${filename}.next`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  setP39PrivateWindowsAcl(temporary, "file");
  renameSync(temporary, filename);
  setP39PrivateWindowsAcl(filename, "file");
};

export const writeSandboxPolicyV3TestPair = (
  directory: string,
  pair: SandboxPolicyV3TestPair,
): string => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = join(directory, "v3-source.json");
  writePair(filename, pair);
  setP39PrivateWindowsAcl(directory, "directory");
  return filename;
};

export const writeSandboxPolicyV3SourceFirst = (
  filename: string,
  pair: SandboxPolicyV3TestPair,
) => {
  const prior = JSON.parse(readFileSync(filename, "utf8")) as {
    readonly highWaterCanonicalJson: string;
  };
  writePair(filename, {
    sourceIdentity: pair.sourceIdentity,
    bundleCanonicalJson: pair.bundleCanonicalJson,
    highWaterCanonicalJson: prior.highWaterCanonicalJson,
  });
};

export const commitSandboxPolicyV3HighWater = (
  filename: string,
  pair: SandboxPolicyV3TestPair,
) =>
  writePair(filename, {
    sourceIdentity: pair.sourceIdentity,
    bundleCanonicalJson: pair.bundleCanonicalJson,
    highWaterCanonicalJson: pair.highWaterCanonicalJson,
  });

export interface SandboxPolicyV3SyntheticArtifactPaths {
  readonly source: string;
  readonly binary: string;
  readonly manifest: string;
  readonly signature: string;
  readonly compiler: string;
  readonly control: string;
  readonly testControlRoot: string;
}

/** Test seam for the fixed-path installer. Existing files are adopted only
 * after exact-byte and file-kind checks; cleanup owns only newly created paths. */
export const installSandboxPolicyV3SyntheticArtifactsAtPaths = (
  pair: SandboxPolicyV3TestPair,
  paths: SandboxPolicyV3SyntheticArtifactPaths,
  applyPrivateAcl: (path: string, kind: "file" | "directory") => void = () =>
    undefined,
): (() => void) => {
  const files = [
    [paths.source, pair.sourceArtifactBytes],
    [paths.binary, pair.binaryArtifactBytes],
    [paths.manifest, pair.manifestBytes],
    [paths.signature, pair.signatureBytes],
    [paths.control, pair.controlArtifactBytes],
  ] as const;
  const existing = new Map<string, boolean>();

  // Validate every target before making any filesystem change.
  for (const [path, expected] of files) {
    const stats = lstatArtifact(path);
    if (stats === undefined) {
      existing.set(path, false);
      continue;
    }
    if (reparsePoint(stats) || !stats.isFile())
      throw artifactError(path, "ExistingTargetNotRegularFile");
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw artifactError(path, "ExistingTargetUnreadable");
    }
    if (!bytes.equals(expected))
      throw artifactError(path, "ExistingTargetBytesMismatch");
    existing.set(path, true);
  }
  const compiler = lstatArtifact(paths.compiler);
  if (compiler === undefined || reparsePoint(compiler) || !compiler.isFile())
    throw artifactError(paths.compiler, "CompilerNotRegularFile");
  let compilerBytes: Buffer;
  try {
    compilerBytes = readFileSync(paths.compiler);
  } catch {
    throw artifactError(paths.compiler, "CompilerUnreadable");
  }
  if (!compilerBytes.equals(pair.compilerArtifactBytes))
    throw artifactError(paths.compiler, "CompilerBytesMismatch");

  const createdFiles: string[] = [];
  const createdDirectories: string[] = [];
  try {
    const requiredDirectories = [
      ...new Set(files.map(([path]) => dirname(path))),
    ];
    const missingDirectories = new Set<string>();
    for (const required of requiredDirectories) {
      let cursor = required;
      while (true) {
        const stats = lstatArtifact(cursor);
        if (stats !== undefined) {
          if (reparsePoint(stats) || !stats.isDirectory())
            throw artifactError(cursor, "ParentNotRegularDirectory");
          break;
        }
        missingDirectories.add(cursor);
        const parent = dirname(cursor);
        if (parent === cursor) throw artifactError(cursor, "NoExistingParent");
        cursor = parent;
      }
    }
    for (const directory of [...missingDirectories].sort(
      (left, right) => left.length - right.length,
    )) {
      mkdirSync(directory, { mode: 0o700 });
      createdDirectories.push(directory);
      if (directory === paths.testControlRoot)
        applyPrivateAcl(directory, "directory");
    }
    for (const [path, bytes] of files) {
      if (existing.get(path) === true) continue;
      writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
      createdFiles.push(path);
      applyPrivateAcl(path, "file");
    }
  } catch (error) {
    for (const path of createdFiles.reverse()) {
      try {
        unlinkSync(path);
      } catch {
        // Keep the setup error primary; the fixture's final cleanup reports
        // any path that could not be removed.
      }
    }
    for (const directory of createdDirectories.reverse()) {
      try {
        rmdirSync(directory);
      } catch {
        // Only exact test-created empty directories are eligible for cleanup.
      }
    }
    throw error;
  }
  return () => {
    const errors: unknown[] = [];
    for (const path of createdFiles.reverse()) {
      try {
        unlinkSync(path);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const directory of createdDirectories.reverse()) {
      try {
        rmdirSync(directory);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0)
      throw new AggregateError(errors, "synthetic artifact cleanup failed");
  };
};

export const installSandboxPolicyV3SyntheticArtifacts = (
  pair: SandboxPolicyV3TestPair,
): (() => void) => {
  const paths = fixedWindowsNativeProductionArtifactPaths();
  return installSandboxPolicyV3SyntheticArtifactsAtPaths(
    pair,
    {
      ...paths,
      control: win32.join(paths.testControlRoot, "control-token.artifact"),
    },
    setP39PrivateWindowsAcl,
  );
};
