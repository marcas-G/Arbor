import { createHash } from "node:crypto";
import {
  encodeSandboxAuthorityBundleV3,
  encodeSandboxAuthorityHighWaterV3,
  encodeSandboxOperatorPolicyConfigV1,
  encodeWindowsNativeOperatorTrustSetV1,
  Principal,
  parse,
  type SandboxAuthorityBundleV3,
} from "@arbor/domain";
import { SANDBOX_ENV_ALLOWLIST } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { loadSandboxAuthorityBundleSnapshotCurrent } from "../src/sandbox-authority-bundle.js";

const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const fixture = () => {
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
  const providerRegistry = { version: 1 as const, revision: 1, entries: [] };
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
    providerRegistryDigest: hash('{"version":1,"revision":1,"entries":[]}'),
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
});
