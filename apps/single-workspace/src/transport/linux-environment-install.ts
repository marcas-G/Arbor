import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { release } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  decodeCanonicalSandboxAuthorityBundleV2,
  decodeCanonicalSandboxAuthorityHighWaterV2,
  decodeCanonicalSandboxLinuxQualificationManifestV2,
  encodeSandboxAuthorityBundleV2,
  encodeSandboxAuthorityHighWaterV2,
  encodeSandboxOperatorPolicyConfigV1,
  encodeSandboxPolicyGrantIssuerConfigV1,
  encodeSandboxProviderQualificationRegistryV1,
  Principal,
  parse,
  type SandboxAuthorityBundleV2,
  type SandboxOperatorPolicyConfigV1,
  type SandboxProviderQualificationRegistryV1,
} from "@arbor/domain";
import { validateP39ProtectedDirectory } from "@arbor/persistence-sqlite";
import { SANDBOX_ENV_ALLOWLIST } from "@arbor/ports";
import { Effect } from "effect";
import lockfile from "proper-lockfile";
import { defaultSandboxAuthorityPaths } from "../sandbox-authority-default.js";
import { makeSandboxAuthorityProvisioningFileStore } from "../sandbox-authority-provisioning-file-store.js";
import { probeInstalledLinuxSandbox } from "../sandbox-linux-capability.js";
import { LOCAL_PRINCIPAL } from "./auth.js";
import { checkLinuxSandboxEnvironment } from "./linux-sandbox-checks.js";

const sha = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const flushDirectory = async (path: string) => {
  const descriptor = await open(path, "r");
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
};

const writeDurable = async (path: string, bytes: string | Uint8Array) => {
  const descriptor = await open(path, "wx", 0o600);
  try {
    await descriptor.writeFile(bytes);
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
};

/** Offline first-install operation, never imported by daemon composition. It
 * runs the real controls itself; callers cannot supply a Supported row, report,
 * authority destination, executable path or weaker validation callback. */
const installLinuxSandboxEnvironmentInternal = async (
  input: Parameters<typeof checkLinuxSandboxEnvironment>[0],
  replaceExisting: boolean,
) => {
  if (process.platform !== "linux") throw new Error("Linux is required");
  const paths = defaultSandboxAuthorityPaths();
  const parent = dirname(paths.protectedRoot);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  assert.equal(
    await realpath(parent),
    parent,
    "Authority parent is redirected",
  );
  const lockPath = join(
    parent,
    `.${basename(paths.protectedRoot)}-install.lock`,
  );
  const releaseLock = await lockfile.lock(parent, {
    lockfilePath: lockPath,
    stale: 30_000,
    update: 5_000,
    retries: 0,
  });
  let staging: string | undefined;
  try {
    const existing = await lstat(paths.protectedRoot).catch(
      (error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return undefined;
        throw error;
      },
    );
    if (!replaceExisting) {
      assert.equal(
        existing,
        undefined,
        "An authority installation already exists; it has not been changed",
      );
    } else if (existing !== undefined) {
      // Requalification is an explicit operator action. Refuse a symlink or
      // other unexpected filesystem object rather than moving it out of the
      // authority location and hiding a possible tampering signal.
      assert.ok(
        existing.isDirectory(),
        "The existing authority installation is not a regular directory; it has not been changed",
      );
    }
    assert.ok(
      validateP39ProtectedDirectory(parent),
      "执行环境目录不满足持久本地存储和目录权限要求；请使用当前用户的本地磁盘数据目录，不能放在 /tmp 内存盘或网络盘。",
    );
    const report = await checkLinuxSandboxEnvironment(input);
    if (report.status !== "QualifiedCandidate" || !report.manifestRef)
      return { ...report, installed: false };
    const manifestBytes = await readFile(
      join(report.output, "manifest.json"),
      "utf8",
    );
    assert.equal(`blob:sha256:${sha(manifestBytes)}`, report.manifestRef);
    const manifest =
      decodeCanonicalSandboxLinuxQualificationManifestV2(manifestBytes);
    assert.ok(manifest, "Qualification manifest is not canonical");
    assert.equal(manifest.osBuild, release());
    staging = await mkdtemp(join(parent, ".sandbox-authority-install-"));
    const forensic = join(staging, "forensic");
    await mkdir(forensic, { mode: 0o700 });
    for (const control of manifest.cases) {
      const digest = control.evidenceRef.slice("blob:sha256:".length);
      const source = await open(
        join(report.output, `${digest}.raw`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let bytes: Buffer;
      try {
        const metadata = await source.stat();
        assert.ok(metadata.isFile() && metadata.nlink === 1);
        bytes = await source.readFile();
      } finally {
        await source.close();
      }
      assert.equal(sha(bytes), digest);
      const recorded = JSON.parse(bytes.toString("utf8"));
      assert.equal(recorded.caseId, control.caseId);
      assert.equal(recorded.verdict, "PASS");
      await writeDurable(join(forensic, `${digest}.raw`), bytes);
    }
    await writeDurable(
      join(forensic, `${sha(manifestBytes)}.raw`),
      manifestBytes,
    );
    const issuerConfig = {
      version: 1 as const,
      revision: 1,
      issuers: [parse(Principal)(LOCAL_PRINCIPAL)],
    };
    const operatorConfig: SandboxOperatorPolicyConfigV1 = {
      version: 1,
      revision: 1,
      environmentAllowlist: [],
      limitsByProfile: ["ReadOnly", "WorkspaceWrite", "FullAccess"].map(
        (profile) => ({
          profile: profile as "ReadOnly" | "WorkspaceWrite" | "FullAccess",
          limits: manifest.validatedLimits,
        }),
      ),
      trustedLocalRuntimeVersion: "builtin-v1",
    };
    const providerRegistry: SandboxProviderQualificationRegistryV1 = {
      version: 1,
      revision: 1,
      entries: [
        {
          providerId: manifest.providerId,
          providerVersion: manifest.providerVersion,
          capabilityRevision: manifest.capabilityRevision,
          osFamily: manifest.osFamily,
          osBuild: manifest.osBuild,
          tuple: {
            profile: manifest.profile,
            networkMode: manifest.networkMode,
            networkPolicyCodecVersion: manifest.networkPolicyCodecVersion,
            enforcementRuleSetDigest: manifest.enforcementRuleSetDigest,
          },
          status: "Supported",
          qualificationEvidenceRef:
            report.manifestRef as `blob:sha256:${string}`,
        },
      ],
    };
    const bundle: SandboxAuthorityBundleV2 = {
      version: 2,
      sourceIdentity: paths.sourceIdentity,
      bundleRevision: 1,
      issuerConfigRevision: 1,
      issuerConfigDigest: sha(
        encodeSandboxPolicyGrantIssuerConfigV1(issuerConfig),
      ),
      issuerConfig,
      operatorConfigRevision: 1,
      operatorConfigDigest: sha(
        encodeSandboxOperatorPolicyConfigV1(operatorConfig),
      ),
      operatorConfig,
      providerRegistryRevision: 1,
      providerRegistryDigest: sha(
        encodeSandboxProviderQualificationRegistryV1(providerRegistry),
      ),
      providerRegistry,
    };
    const canonicalBundle = encodeSandboxAuthorityBundleV2(bundle);
    assert.ok(
      decodeCanonicalSandboxAuthorityBundleV2(
        canonicalBundle,
        SANDBOX_ENV_ALLOWLIST,
        sha,
      ),
    );
    const canonicalHighWater = encodeSandboxAuthorityHighWaterV2({
      version: 2,
      sourceIdentity: bundle.sourceIdentity,
      bundleRevision: bundle.bundleRevision,
      bundleDigest: sha(canonicalBundle),
      issuerConfigRevision: bundle.issuerConfigRevision,
      issuerConfigDigest: bundle.issuerConfigDigest,
      operatorConfigRevision: bundle.operatorConfigRevision,
      operatorConfigDigest: bundle.operatorConfigDigest,
      providerRegistryRevision: bundle.providerRegistryRevision,
      providerRegistryDigest: bundle.providerRegistryDigest,
    });
    assert.ok(decodeCanonicalSandboxAuthorityHighWaterV2(canonicalHighWater));
    const stagedPaths = {
      ...paths,
      protectedRoot: staging,
      sourceFile: join(staging, basename(paths.sourceFile)),
      highWaterFile: join(staging, basename(paths.highWaterFile)),
      forensicDirectory: forensic,
    };
    await writeDurable(stagedPaths.sourceFile, canonicalBundle);
    await writeDurable(stagedPaths.highWaterFile, canonicalHighWater);
    const source = Effect.runSync(
      makeSandboxAuthorityProvisioningFileStore(stagedPaths),
    );
    const capability = await probeInstalledLinuxSandbox(source);
    assert.equal(capability.status, "Supported", JSON.stringify(capability));
    await flushDirectory(forensic);
    await flushDirectory(staging);
    // A cooperating installer holds the exclusive lock. First install never
    // replaces an existing source. Explicit requalification first moves the
    // old source to a recoverable, timestamped sibling, then publishes the
    // fully qualified candidate with same-volume directory renames. If the
    // second rename fails, restore the old source before reporting failure.
    let previousAuthorityDirectory: string | undefined;
    if (replaceExisting && existing !== undefined) {
      previousAuthorityDirectory = join(
        parent,
        `sandbox-authority-stale-${new Date().toISOString().replace(/[-:.TZ]/gu, "")}-${randomUUID()}`,
      );
      await rename(paths.protectedRoot, previousAuthorityDirectory);
    }
    await assert.rejects(lstat(paths.protectedRoot), { code: "ENOENT" });
    try {
      await rename(staging, paths.protectedRoot);
    } catch (error) {
      if (previousAuthorityDirectory !== undefined) {
        await rename(previousAuthorityDirectory, paths.protectedRoot).catch(
          () => undefined,
        );
      }
      throw error;
    }
    staging = undefined;
    await flushDirectory(parent);
    return {
      ...report,
      installed: true,
      authorityDirectory: paths.protectedRoot,
      ...(previousAuthorityDirectory === undefined
        ? {}
        : { previousAuthorityDirectory }),
    };
  } finally {
    if (staging !== undefined)
      await rm(staging, { recursive: true, force: true });
    await releaseLock();
  }
};

/** Install the first authority and refuse to overwrite an existing one. */
export const installLinuxSandboxEnvironment = (
  input: Parameters<typeof checkLinuxSandboxEnvironment>[0],
) => installLinuxSandboxEnvironmentInternal(input, false);

/** Requalify the host sandbox after an Arbor/provider upgrade. The old
 * authority is retained beside the new one so a failed or interrupted
 * upgrade never destroys the operator's previous evidence. */
export const reinstallLinuxSandboxEnvironment = (
  input: Parameters<typeof checkLinuxSandboxEnvironment>[0],
) => installLinuxSandboxEnvironmentInternal(input, true);
