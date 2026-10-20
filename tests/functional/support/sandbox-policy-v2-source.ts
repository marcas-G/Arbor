import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  encodeSandboxAuthorityBundleV2,
  encodeSandboxAuthorityHighWaterV2,
  encodeSandboxOperatorPolicyConfigV1,
  encodeSandboxPolicyGrantIssuerConfigV1,
  encodeSandboxProviderQualificationRegistryV1,
  Principal,
  parse,
  type SandboxAuthorityBundleV2,
} from "../../../packages/domain/src/index.js";
import { setP39PrivateWindowsAcl } from "../../support/p39-windows-deployment-test.js";

const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const limits = {
  wallTimeMs: 60_000,
  stdoutBytes: 8192,
  stderrBytes: 8192,
  processCount: 8,
  memoryBytes: 134_217_728,
  cpuTimeMs: 30_000,
};

const bundleFor = (input: {
  readonly bundleRevision: number;
  readonly registryRevision: number;
}): SandboxAuthorityBundleV2 => {
  const issuerConfig = {
    version: 1 as const,
    revision: 1,
    issuers: [parse(Principal)("user:local")],
  };
  const operatorConfig = {
    version: 1 as const,
    revision: 1,
    environmentAllowlist: ["PATH"],
    limitsByProfile: ("ReadOnly WorkspaceWrite FullAccess" as const)
      .split(" ")
      .map((profile) => ({
        profile: profile as "ReadOnly" | "WorkspaceWrite" | "FullAccess",
        limits,
      })),
    trustedLocalRuntimeVersion: "builtin-v1" as const,
  };
  const providerRegistry = {
    version: 1 as const,
    revision: input.registryRevision,
    entries: [],
  };
  return {
    version: 2,
    sourceIdentity: "host:sandbox-policy-v6-process-test",
    bundleRevision: input.bundleRevision,
    issuerConfigRevision: issuerConfig.revision,
    issuerConfigDigest: hash(
      encodeSandboxPolicyGrantIssuerConfigV1(issuerConfig),
    ),
    issuerConfig,
    operatorConfigRevision: operatorConfig.revision,
    operatorConfigDigest: hash(
      encodeSandboxOperatorPolicyConfigV1(operatorConfig),
    ),
    operatorConfig,
    providerRegistryRevision: providerRegistry.revision,
    providerRegistryDigest: hash(
      encodeSandboxProviderQualificationRegistryV1(providerRegistry),
    ),
    providerRegistry,
  };
};

export interface SandboxPolicyV2TestPair {
  readonly sourceIdentity: string;
  readonly bundleCanonicalJson: string;
  readonly highWaterCanonicalJson: string;
  readonly bundle: SandboxAuthorityBundleV2;
  readonly bundleDigest: string;
}

export const sandboxPolicyV2TestPair = (input?: {
  readonly bundleRevision?: number;
  readonly registryRevision?: number;
}): SandboxPolicyV2TestPair => {
  const bundle = bundleFor({
    bundleRevision: input?.bundleRevision ?? 1,
    registryRevision: input?.registryRevision ?? 1,
  });
  const bundleCanonicalJson = encodeSandboxAuthorityBundleV2(bundle);
  const bundleDigest = hash(bundleCanonicalJson);
  return {
    sourceIdentity: bundle.sourceIdentity,
    bundleCanonicalJson,
    bundle,
    bundleDigest,
    highWaterCanonicalJson: encodeSandboxAuthorityHighWaterV2({
      version: 2,
      sourceIdentity: bundle.sourceIdentity,
      bundleRevision: bundle.bundleRevision,
      bundleDigest,
      issuerConfigRevision: bundle.issuerConfigRevision,
      issuerConfigDigest: bundle.issuerConfigDigest,
      operatorConfigRevision: bundle.operatorConfigRevision,
      operatorConfigDigest: bundle.operatorConfigDigest,
      providerRegistryRevision: bundle.providerRegistryRevision,
      providerRegistryDigest: bundle.providerRegistryDigest,
    }),
  };
};

/** Creates/atomically replaces only the disposable test source pair. The
 * directory is private on Windows and the files are owner-only on POSIX. */
export const writeSandboxPolicyV2TestPair = (
  directory: string,
  pair: SandboxPolicyV2TestPair,
): string => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sourceFilename = join(directory, "v2-source.json");
  const temporary = `${sourceFilename}.next`;
  writeFileSync(
    temporary,
    JSON.stringify({
      sourceIdentity: pair.sourceIdentity,
      bundleCanonicalJson: pair.bundleCanonicalJson,
      highWaterCanonicalJson: pair.highWaterCanonicalJson,
    }),
    { mode: 0o600 },
  );
  chmodSync(temporary, 0o600);
  setP39PrivateWindowsAcl(temporary, "file");
  renameSync(temporary, sourceFilename);
  setP39PrivateWindowsAcl(sourceFilename, "file");
  setP39PrivateWindowsAcl(directory, "directory");
  return sourceFilename;
};
