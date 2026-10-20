import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeCanonicalSandboxAuthorityBundleV3,
  decodeCanonicalSandboxAuthorityHighWaterV3,
  encodeSandboxAuthorityBundleV3,
  encodeSandboxAuthorityHighWaterV3,
} from "../src/index.js";

const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const hashBytes = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const issuer = '{"version":1,"revision":1,"issuers":["user:operator"]}';
const operator =
  '{"version":1,"revision":1,"environmentAllowlist":[],"limitsByProfile":[{"profile":"ReadOnly","limits":{"wallTimeMs":1,"stdoutBytes":1,"stderrBytes":1,"processCount":1,"memoryBytes":1,"cpuTimeMs":1}},{"profile":"WorkspaceWrite","limits":{"wallTimeMs":1,"stdoutBytes":1,"stderrBytes":1,"processCount":1,"memoryBytes":1,"cpuTimeMs":1}},{"profile":"FullAccess","limits":{"wallTimeMs":1,"stdoutBytes":1,"stderrBytes":1,"processCount":1,"memoryBytes":1,"cpuTimeMs":1}}],"trustedLocalRuntimeVersion":"builtin-v1"}';
const registry = '{"version":1,"revision":1,"entries":[]}';
const trust =
  '{"version":1,"revision":1,"sourceIdentity":"host:test","providerId":"windows-restricted-appcontainer-job","keys":[{"keyId":"operator-2026-a","algorithm":"Ed25519","publicKeySpkiDerBase64":"MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=","publicKeySpkiSha256":"06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9","validFrom":"2026-10-20T00:00:00.000Z","validUntil":"2027-10-20T00:00:00.000Z","status":"Active"}],"revokedKeyIds":[]}';
const bundle = `{"version":3,"sourceIdentity":"host:test","bundleRevision":3,"issuerConfigRevision":1,"issuerConfigDigest":"${hash(issuer)}","issuerConfig":${issuer},"operatorConfigRevision":1,"operatorConfigDigest":"${hash(operator)}","operatorConfig":${operator},"providerRegistryRevision":1,"providerRegistryDigest":"${hash(registry)}","providerRegistry":${registry},"windowsOperatorTrustSetRevision":1,"windowsOperatorTrustSetDigest":"${hash(trust)}","windowsOperatorTrustSet":${trust}}`;
const highWater = `{"version":3,"sourceIdentity":"host:test","bundleRevision":3,"bundleDigest":"${hash(bundle)}","issuerConfigRevision":1,"issuerConfigDigest":"${hash(issuer)}","operatorConfigRevision":1,"operatorConfigDigest":"${hash(operator)}","providerRegistryRevision":1,"providerRegistryDigest":"${hash(registry)}","windowsOperatorTrustSetRevision":1,"windowsOperatorTrustSetDigest":"${hash(trust)}"}`;

describe("SandboxAuthorityBundleV3 physical codec", () => {
  it("pins accepted complete bytes and hashes", () => {
    expect(hash(issuer)).toBe(
      "e334867ac506dd06d6e07ae81501e02032121be70cd1308929d6fcccf33352fa",
    );
    expect(hash(operator)).toBe(
      "948aa1b3e0e732a00f0fd25a843ab02242b9098d6cb456320cb14a39a590f836",
    );
    expect(hash(registry)).toBe(
      "25889d79d251fd8d4e5adf6180ab31a586134fb33575d555cd716982fef6c9d2",
    );
    expect(hash(trust)).toBe(
      "be159a9cfea6d65bf27b6645f94bbe12efa65b7d7ffe513d53477ed48241ea4d",
    );
    expect(hash(bundle)).toBe(
      "5971402bc958c5f99cd1cdeeca95f364e161821945fb05dc0f8ea642d2399954",
    );
    expect(hash(highWater)).toBe(
      "deb5867f939177d2a077c780d245aee91e6d4f8b9b9ba71c7b5a0b364fb2f27e",
    );
    const decoded = decodeCanonicalSandboxAuthorityBundleV3(
      bundle,
      [],
      hash,
      hashBytes,
    );
    expect(decoded).toBeDefined();
    if (decoded === undefined) throw new Error("bundle KAT rejected");
    expect(encodeSandboxAuthorityBundleV3(decoded.bundle)).toBe(bundle);
    const decodedHighWater =
      decodeCanonicalSandboxAuthorityHighWaterV3(highWater);
    expect(decodedHighWater).toBeDefined();
    if (decodedHighWater === undefined)
      throw new Error("high-water KAT rejected");
    expect(encodeSandboxAuthorityHighWaterV3(decodedHighWater)).toBe(highWater);
  });

  it("rejects source/trust mismatch and noncanonical/reordered bytes", () => {
    expect(
      decodeCanonicalSandboxAuthorityBundleV3(
        `${bundle}\n`,
        [],
        hash,
        hashBytes,
      ),
    ).toBeUndefined();
    expect(
      decodeCanonicalSandboxAuthorityBundleV3(
        bundle.replace('"version":3,"sourceIdentity"', '"sourceIdentity"'),
        [],
        hash,
        hashBytes,
      ),
    ).toBeUndefined();
    expect(
      decodeCanonicalSandboxAuthorityBundleV3(
        bundle.replace(
          '"sourceIdentity":"host:test","providerId"',
          '"sourceIdentity":"host:other","providerId"',
        ),
        [],
        hash,
        hashBytes,
      ),
    ).toBeUndefined();
    expect(
      decodeCanonicalSandboxAuthorityHighWaterV3(`${highWater} `),
    ).toBeUndefined();
    expect(
      decodeCanonicalSandboxAuthorityHighWaterV3(
        highWater.replace(
          '"bundleRevision":3,',
          '"bundleRevision":3,"bundleRevision":3,',
        ),
      ),
    ).toBeUndefined();
  });
});
