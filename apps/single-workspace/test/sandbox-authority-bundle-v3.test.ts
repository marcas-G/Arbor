import { createHash, createPrivateKey, sign } from "node:crypto";
import { release } from "node:os";
import { win32 } from "node:path";
import {
  encodeSandboxAuthorityBundleV3,
  encodeSandboxAuthorityHighWaterV3,
  encodeSandboxOperatorPolicyConfigV1,
  encodeSandboxProviderQualificationRegistryV1,
  encodeWindowsNativeOperatorTrustSetV1,
  Principal,
  parse,
  type SandboxAuthorityBundleV3,
  type SandboxProviderQualificationEntryV1,
} from "@arbor/domain";
import { SANDBOX_ENV_ALLOWLIST } from "@arbor/ports";
import {
  encodeWindowsNativeArtifactManifestV1,
  fixedWindowsNativeProductionArtifactPaths,
  WINDOWS_NATIVE_PROCESS_HOST_COMPILER_ARGUMENTS_V1,
  type WindowsNativeQualificationIo,
} from "@arbor/sandbox-windows";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeProductionWindowsSandboxProcessPort } from "../src/composition.js";
import { loadSandboxAuthorityBundleSnapshotCurrent } from "../src/sandbox-authority-bundle.js";
import { inspectWindowsQualificationAtP4Admission } from "../src/sandbox-process-policy-materializer.js";

const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const fixture = (
  entries: ReadonlyArray<SandboxProviderQualificationEntryV1> = [],
) => {
  const issuerConfig = {
    version: 1 as const,
    revision: 1,
    issuers: [parse(Principal)("user:operator")],
  };
  const operatorConfig = {
    version: 1 as const,
    revision: 1,
    environmentAllowlist: [] as string[],
    limitsByProfile: (
      ["ReadOnly", "WorkspaceWrite", "FullAccess"] as const
    ).map((profile) => ({
      profile,
      limits: {
        wallTimeMs: 1,
        stdoutBytes: 1,
        stderrBytes: 1,
        processCount: 1,
        memoryBytes: 1,
        cpuTimeMs: 1,
      },
    })),
    trustedLocalRuntimeVersion: "builtin-v1" as const,
  };
  const providerRegistry = { version: 1 as const, revision: 1, entries };
  const windowsOperatorTrustSet = {
    version: 1 as const,
    revision: 1,
    sourceIdentity: "host:test",
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
    sourceIdentity: "host:test",
    bundleRevision: 3,
    issuerConfigRevision: 1,
    issuerConfigDigest: hash(
      '{"version":1,"revision":1,"issuers":["user:operator"]}',
    ),
    issuerConfig,
    operatorConfigRevision: 1,
    operatorConfigDigest: hash(
      encodeSandboxOperatorPolicyConfigV1(operatorConfig),
    ),
    operatorConfig,
    providerRegistryRevision: 1,
    providerRegistryDigest: hash(
      encodeSandboxProviderQualificationRegistryV1(providerRegistry),
    ),
    providerRegistry,
    windowsOperatorTrustSetRevision: 1,
    windowsOperatorTrustSetDigest: hash(
      encodeWindowsNativeOperatorTrustSetV1(windowsOperatorTrustSet),
    ),
    windowsOperatorTrustSet,
  };
  const bundleJson = encodeSandboxAuthorityBundleV3(bundle);
  const highWaterJson = encodeSandboxAuthorityHighWaterV3({
    version: 3,
    sourceIdentity: bundle.sourceIdentity,
    bundleRevision: bundle.bundleRevision,
    bundleDigest: hash(bundleJson),
    issuerConfigRevision: bundle.issuerConfigRevision,
    issuerConfigDigest: bundle.issuerConfigDigest,
    operatorConfigRevision: bundle.operatorConfigRevision,
    operatorConfigDigest: bundle.operatorConfigDigest,
    providerRegistryRevision: bundle.providerRegistryRevision,
    providerRegistryDigest: bundle.providerRegistryDigest,
    windowsOperatorTrustSetRevision: bundle.windowsOperatorTrustSetRevision,
    windowsOperatorTrustSetDigest: bundle.windowsOperatorTrustSetDigest,
  });
  return { bundle, bundleJson, highWaterJson };
};

describe("P5 Windows D2 V3 current protected authority", () => {
  it.skipIf(process.platform !== "win32")(
    "re-reads protected source, sidecar and PE at P4 admission after an earlier positive inspection",
    async () => {
      const paths = fixedWindowsNativeProductionArtifactPaths();
      const sourceBytes = Buffer.from("operator-fixed-source");
      const compilerBytes = Buffer.from("operator-fixed-compiler");
      const binaryBytes = Buffer.from("operator-shipped-PE");
      const controlBytes = Buffer.from("qualification-control");
      const osBuild = release();
      const ruleDigest = "f".repeat(64);
      const limits = {
        wallTimeMs: 1,
        stdoutBytes: 1,
        stderrBytes: 1,
        processCount: 1,
        memoryBytes: 1,
        cpuTimeMs: 1,
      };
      const manifest = {
        version: 1 as const,
        providerId: "windows-restricted-appcontainer-job" as const,
        providerVersion: "t3d-v1",
        capabilityRevision: 1,
        osFamily: "Windows" as const,
        osBuild,
        platformPrimitiveSetId:
          "windows-restricted-token-lowintegrity-appcontainer-job-namedpipe-v1" as const,
        qualificationRows: [
          {
            profile: "ReadOnly" as const,
            networkMode: "Disabled" as const,
            networkPolicyCodecVersion: 1 as const,
            enforcementRuleSetDigest: ruleDigest,
          },
        ],
        sourceSha256: hash(sourceBytes),
        compilerSha256: hash(compilerBytes),
        compilerVersion: "4.8.0",
        compilerArgumentsSha256: hash(
          WINDOWS_NATIVE_PROCESS_HOST_COMPILER_ARGUMENTS_V1.join("\n"),
        ),
        binarySha256: hash(binaryBytes),
        buildMethod: "fixed-framework64-csc",
        buildVersion: "1",
        testControlArtifactHashes: [
          { artifactId: "control-token", sha256: hash(controlBytes) },
        ],
        limits,
        operatorConfigRevision: 1,
        operatorConfigDigest: "",
        discoveryMethod: "fixed-windows-build-probe",
        discoveryVersion: "1",
        matrixResults: [
          { matrixId: "disabled-readonly", result: "Pass" as const },
        ],
        hostControls: [
          {
            controlId: "appcontainer-token",
            artifactId: "control-token",
            result: "Pass" as const,
          },
        ],
      };
      const provisional = fixture();
      const manifestBytes = Buffer.from(
        encodeWindowsNativeArtifactManifestV1({
          ...manifest,
          operatorConfigDigest: provisional.bundle.operatorConfigDigest,
        }),
        "utf8",
      );
      const evidenceRef = `blob:sha256:${hash(manifestBytes)}`;
      const row: SandboxProviderQualificationEntryV1 = {
        providerId: manifest.providerId,
        providerVersion: manifest.providerVersion,
        capabilityRevision: 1,
        osFamily: "Windows",
        osBuild,
        tuple: {
          profile: "ReadOnly",
          networkMode: "Disabled",
          networkPolicyCodecVersion: 1,
          enforcementRuleSetDigest: ruleDigest,
        },
        status: "Experimental",
        qualificationEvidenceRef: evidenceRef,
      };
      const current = fixture([row]);
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
      const sidecar = Buffer.from(
        JSON.stringify({
          version: 1,
          keyId: "operator-2026-a",
          signatureBase64: signature.toString("base64"),
        }),
        "utf8",
      );
      const files = new Map<string, Buffer>([
        [paths.source, sourceBytes],
        [paths.compiler, compilerBytes],
        [paths.binary, binaryBytes],
        [paths.manifest, manifestBytes],
        [paths.signature, sidecar],
        [
          win32.join(paths.testControlRoot, "control-token.artifact"),
          controlBytes,
        ],
      ]);
      let artifactReads = 0;
      const io: WindowsNativeQualificationIo = {
        realpath: (path) => path,
        lstat: (path) => ({
          isFile: () => files.has(path),
          isDirectory: () => false,
          isSymbolicLink: () => false,
        }),
        read: (path) => {
          artifactReads += 1;
          const bytes = files.get(path);
          if (bytes === undefined) throw new Error("test artifact missing");
          return bytes;
        },
      };
      const protectedPair = {
        source: current.bundleJson,
        highWater: current.highWaterJson,
      };
      let sourceReads = 0;
      const source = {
        readVerifiedSandboxAuthorityBundle: () =>
          Effect.sync(() => {
            sourceReads += 1;
            return {
              sourceIdentity: "host:test",
              canonicalJson: protectedPair.source,
            };
          }),
        readSandboxAuthorityHighWater: () =>
          Effect.succeed(protectedPair.highWater),
        commitSandboxAuthorityHighWater: () => Effect.succeed(false),
        appendSandboxAuthorityAudit: () => Effect.succeed(true),
      };
      const summary = {
        providerId: row.providerId,
        providerVersion: row.providerVersion,
        capabilityRevision: row.capabilityRevision,
        osFamily: row.osFamily,
        osBuild: row.osBuild,
        qualificationEvidenceRef: evidenceRef,
        profile: row.tuple.profile,
        networkPolicy: {
          version: 1 as const,
          mode: "Disabled" as const,
          destinations: [],
        },
      };
      const inspect = () =>
        Effect.runPromise(
          inspectWindowsQualificationAtP4Admission({
            source,
            now: "2026-10-20T00:00:00.000Z",
            summary,
            io,
          }),
        );
      const productionProvider =
        makeProductionWindowsSandboxProcessPort(source);
      const capabilities = await Effect.runPromise(
        productionProvider.capabilities(),
      );
      expect(
        capabilities.every(
          (capability) =>
            capability.status === "Experimental" &&
            capability.profiles.length === 0,
        ),
      ).toBe(true);
      const readsAfterCapabilityProbe = sourceReads;
      expect(readsAfterCapabilityProbe).toBeGreaterThan(0);
      protectedPair.source = "{bad-json";
      expect((await inspect())._tag).toBe("Unavailable");
      expect(sourceReads).toBeGreaterThan(readsAfterCapabilityProbe);
      protectedPair.source = current.bundleJson;
      expect((await inspect())._tag).toBe("ManifestVerified");
      const readsAfterProbe = { sourceReads, artifactReads };
      files.set(
        paths.signature,
        Buffer.from(
          JSON.stringify({
            version: 1,
            keyId: "operator-2026-b",
            signatureBase64: signature.toString("base64"),
          }),
          "utf8",
        ),
      );
      expect((await inspect())._tag).toBe("Unavailable");
      expect(sourceReads).toBeGreaterThan(readsAfterProbe.sourceReads);
      expect(artifactReads).toBeGreaterThan(readsAfterProbe.artifactReads);
      files.set(paths.signature, sidecar);
      files.set(paths.binary, Buffer.from("changed PE after probe"));
      expect((await inspect())._tag).toBe("Unavailable");
      files.set(paths.binary, binaryBytes);
    },
  );

  it("publishes only the exact V3 pair with versioned audit", async () => {
    const current = fixture();
    const audit: string[] = [];
    const source = {
      readVerifiedSandboxAuthorityBundle: () =>
        Effect.succeed({
          sourceIdentity: "host:test",
          canonicalJson: current.bundleJson,
        }),
      readSandboxAuthorityHighWater: () =>
        Effect.succeed(current.highWaterJson),
      commitSandboxAuthorityHighWater: () => Effect.succeed(false),
      appendSandboxAuthorityAudit: (json: string) =>
        Effect.sync(() => {
          audit.push(json);
          return true;
        }),
    };
    const result = await Effect.runPromise(
      loadSandboxAuthorityBundleSnapshotCurrent(
        source,
        "2026-10-20T00:00:00.000Z",
        SANDBOX_ENV_ALLOWLIST,
      ),
    );
    expect(result._tag).toBe("Available");
    if (result._tag !== "Available") return;
    expect(result.snapshot.bundle).toEqual(current.bundle);
    expect(Object.isFrozen(result.snapshot.bundle)).toBe(true);
    expect(JSON.parse(audit[0] ?? "{}")).toMatchObject({
      version: 3,
      outcome: "Loaded",
      windowsOperatorTrustSetRevision: 1,
    });
  });

  it("rejects V3 source with V2 high-water and source drift without fallback", async () => {
    const current = fixture();
    let readCount = 0;
    const source = {
      readVerifiedSandboxAuthorityBundle: () =>
        Effect.sync(() => ({
          sourceIdentity: "host:test",
          canonicalJson: ++readCount < 2 ? current.bundleJson : "{}",
        })),
      readSandboxAuthorityHighWater: () =>
        Effect.succeed(current.highWaterJson),
      commitSandboxAuthorityHighWater: () => Effect.succeed(false),
      appendSandboxAuthorityAudit: () => Effect.succeed(true),
    };
    const drifted = await Effect.runPromise(
      loadSandboxAuthorityBundleSnapshotCurrent(
        source,
        "2026-10-20T00:00:00.000Z",
        SANDBOX_ENV_ALLOWLIST,
      ),
    );
    expect(drifted).toEqual({
      _tag: "Unavailable",
      failure: "TrustCurrentnessMismatch",
    });
    const wrongHighWater = {
      ...source,
      readVerifiedSandboxAuthorityBundle: () =>
        Effect.succeed({
          sourceIdentity: "host:test",
          canonicalJson: current.bundleJson,
        }),
      readSandboxAuthorityHighWater: () =>
        Effect.succeed(
          current.highWaterJson.replace('"version":3', '"version":2'),
        ),
    };
    const mismatch = await Effect.runPromise(
      loadSandboxAuthorityBundleSnapshotCurrent(
        wrongHighWater,
        "2026-10-20T00:00:00.000Z",
        SANDBOX_ENV_ALLOWLIST,
      ),
    );
    expect(mismatch).toEqual({
      _tag: "Unavailable",
      failure: "HighWaterCorrupt",
    });
  });

  it("classifies malformed trust and digest mismatch without exposing bytes", async () => {
    const current = fixture();
    const load = (canonicalJson: string) =>
      Effect.runPromise(
        loadSandboxAuthorityBundleSnapshotCurrent(
          {
            readVerifiedSandboxAuthorityBundle: () =>
              Effect.succeed({
                sourceIdentity: "host:test",
                canonicalJson,
              }),
            readSandboxAuthorityHighWater: () =>
              Effect.succeed(current.highWaterJson),
            commitSandboxAuthorityHighWater: () => Effect.succeed(false),
            appendSandboxAuthorityAudit: () => Effect.succeed(true),
          },
          "2026-10-20T00:00:00.000Z",
          SANDBOX_ENV_ALLOWLIST,
        ),
      );
    const malformed = await load(
      current.bundleJson.replace('"algorithm":"Ed25519"', '"algorithm":"RSA"'),
    );
    expect(malformed).toEqual({
      _tag: "Unavailable",
      failure: "TrustSetMalformed",
    });
    const wrongDigest = await load(
      current.bundleJson.replace(
        /(?<="windowsOperatorTrustSetDigest":")[0-9a-f]{64}/u,
        "f".repeat(64),
      ),
    );
    expect(wrongDigest).toEqual({
      _tag: "Unavailable",
      failure: "TrustSetDigestMismatch",
    });
  });

  it("audits unclassified initial read and bad JSON without leaking source text", async () => {
    for (const initial of ["read-error", "bad-json"] as const) {
      const records: string[] = [];
      const source = {
        readVerifiedSandboxAuthorityBundle: () =>
          initial === "read-error"
            ? Effect.fail("SourceUnreadable" as const)
            : Effect.succeed({
                sourceIdentity: "host:test",
                canonicalJson: "{secret",
              }),
        readSandboxAuthorityHighWater: () => Effect.succeed(undefined),
        commitSandboxAuthorityHighWater: () => Effect.succeed(false),
        appendSandboxAuthorityAudit: (record: string) =>
          Effect.sync(() => {
            records.push(record);
            return true;
          }),
      };
      const result = await Effect.runPromise(
        loadSandboxAuthorityBundleSnapshotCurrent(
          source,
          "2026-10-20T00:00:00.000Z",
          SANDBOX_ENV_ALLOWLIST,
        ),
      );
      expect(result).toEqual({
        _tag: "Unavailable",
        failure:
          initial === "read-error" ? "SourceUnreadable" : "BundleMalformed",
      });
      expect(records).toHaveLength(1);
      expect(JSON.parse(records[0] ?? "{}")).toMatchObject({
        version: 2,
        outcome: "Rejected",
        sourceIdentity: null,
      });
      expect(records[0]).not.toContain("secret");
    }
  });
});
