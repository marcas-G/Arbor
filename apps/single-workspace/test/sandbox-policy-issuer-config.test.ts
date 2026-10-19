import { createHash } from "node:crypto";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { loadSandboxAuthorityBundleSnapshot } from "../src/sandbox-authority-bundle.js";

const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const fixture = (revision = 1) => {
  const issuerConfig = {
    version: 1 as const,
    revision,
    issuers: ["user:operator"],
  };
  const issuerConfigJson = `{"version":1,"revision":${revision},"issuers":["user:operator"]}`;
  const providerRegistry = { version: 1 as const, revision: 1, entries: [] };
  const providerRegistryJson = '{"version":1,"revision":1,"entries":[]}';
  const issuerConfigDigest = hash(issuerConfigJson);
  const providerRegistryDigest = hash(providerRegistryJson);
  const bundle = {
    version: 1,
    sourceIdentity: "host-config-test",
    bundleRevision: revision,
    issuerConfigRevision: revision,
    issuerConfigDigest,
    issuerConfig,
    providerRegistryRevision: 1,
    providerRegistryDigest,
    providerRegistry,
  };
  const bundleJson = `{"version":1,"sourceIdentity":"host-config-test","bundleRevision":${revision},"issuerConfigRevision":${revision},"issuerConfigDigest":"${issuerConfigDigest}","issuerConfig":${issuerConfigJson},"providerRegistryRevision":1,"providerRegistryDigest":"${providerRegistryDigest}","providerRegistry":${providerRegistryJson}}`;
  const bundleDigest = hash(bundleJson);
  const highWater = {
    version: 1,
    sourceIdentity: "host-config-test",
    bundleRevision: revision,
    bundleDigest,
    issuerConfigRevision: revision,
    issuerConfigDigest,
    providerRegistryRevision: 1,
    providerRegistryDigest,
  };
  const highWaterJson = `{"version":1,"sourceIdentity":"host-config-test","bundleRevision":${revision},"bundleDigest":"${bundleDigest}","issuerConfigRevision":${revision},"issuerConfigDigest":"${issuerConfigDigest}","providerRegistryRevision":1,"providerRegistryDigest":"${providerRegistryDigest}"}`;
  return { bundle, bundleJson, bundleDigest, highWater, highWaterJson };
};

const sourceFor = (
  bundleJson: string | undefined,
  highWaterJson: string | undefined,
  writes: { highWater?: string; audit: string[] } = { audit: [] },
) => ({
  readVerifiedSandboxAuthorityBundle: () =>
    Effect.succeed(
      bundleJson === undefined
        ? undefined
        : { sourceIdentity: "host-config-test", canonicalJson: bundleJson },
    ),
  readSandboxAuthorityHighWater: () => Effect.succeed(highWaterJson),
  commitSandboxAuthorityHighWater: (json: string) =>
    Effect.sync(() => {
      writes.highWater = json;
      return true;
    }),
  appendSandboxAuthorityAudit: (json: string) =>
    Effect.sync(() => {
      writes.audit.push(json);
      return true;
    }),
});

describe("P5 SandboxAuthorityBundleV1", () => {
  it("validates canonical bundle/high-water and returns one immutable snapshot", async () => {
    const current = fixture();
    const writes: { highWater?: string; audit: string[] } = { audit: [] };
    const result = await Effect.runPromise(
      loadSandboxAuthorityBundleSnapshot(
        sourceFor(current.bundleJson, current.highWaterJson, writes),
        "2026-10-19T00:00:00.000Z",
      ),
    );
    expect(result._tag).toBe("Available");
    if (result._tag !== "Available") return;
    expect(result.snapshot.bundleDigest).toBe(current.bundleDigest);
    expect(result.snapshot.issuerConfigSnapshot).toMatchObject({
      config: current.bundle.issuerConfig,
      configDigest: current.bundle.issuerConfigDigest,
      authorityBundleRevision: 1,
      authorityBundleDigest: current.bundleDigest,
      providerRegistryRevision: 1,
      providerRegistryDigest: current.bundle.providerRegistryDigest,
    });
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(writes.highWater).toBeUndefined();
    expect(JSON.parse(writes.audit[0] ?? "{}")).toMatchObject({
      version: 1,
      outcome: "Loaded",
      detail: null,
      occurredAt: "2026-10-19T00:00:00.000Z",
    });
  });

  it("requires forward monotone high-water advancement before loading changed config", async () => {
    const previous = fixture(1);
    const next = fixture(2);
    const writes: { highWater?: string; audit: string[] } = { audit: [] };
    const result = await Effect.runPromise(
      loadSandboxAuthorityBundleSnapshot(
        sourceFor(next.bundleJson, previous.highWaterJson, writes),
        "2026-10-19T00:00:00.000Z",
      ),
    );
    expect(result._tag).toBe("Available");
    expect(writes.highWater).toBe(next.highWaterJson);
    expect(JSON.parse(writes.audit[0] ?? "{}").outcome).toBe(
      "HighWaterAdvanced",
    );
  });

  it.each([
    [undefined, "HighWaterMissing"],
    ["{bad", "HighWaterCorrupt"],
  ] as const)(
    "fails closed for invalid high-water %s",
    async (highWater, failure) => {
      const current = fixture();
      const result = await Effect.runPromise(
        loadSandboxAuthorityBundleSnapshot(
          sourceFor(current.bundleJson, highWater),
          "2026-10-19T00:00:00.000Z",
        ),
      );
      expect(result).toEqual({ _tag: "Unavailable", failure });
    },
  );

  it("rejects bundle tampering and source rollback without updating high-water", async () => {
    const current = fixture(2);
    const prior = fixture(1);
    const writes: { highWater?: string; audit: string[] } = { audit: [] };
    const tampered = current.bundleJson.replace(
      '"sourceIdentity":"host-config-test"',
      '"sourceIdentity":"host-config-test","unknown":true',
    );
    const malformed = await Effect.runPromise(
      loadSandboxAuthorityBundleSnapshot(
        sourceFor(tampered, current.highWaterJson, writes),
        "2026-10-19T00:00:00.000Z",
      ),
    );
    expect(malformed).toEqual({
      _tag: "Unavailable",
      failure: "BundleMalformed",
    });
    const rollback = await Effect.runPromise(
      loadSandboxAuthorityBundleSnapshot(
        sourceFor(prior.bundleJson, current.highWaterJson, writes),
        "2026-10-19T00:00:00.000Z",
      ),
    );
    expect(rollback).toEqual({
      _tag: "Unavailable",
      failure: "RevisionRollback",
    });
    expect(writes.highWater).toBeUndefined();
  });
});
