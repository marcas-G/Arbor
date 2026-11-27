import { createHash } from "node:crypto";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import {
  loadSandboxAuthorityBundleSnapshotV1Forensic,
  type SandboxAuthorityForensicReadPort,
} from "../src/sandbox-authority-bundle.js";

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
): SandboxAuthorityForensicReadPort => ({
  readVerifiedSandboxAuthorityBundle: () =>
    Effect.succeed(
      bundleJson === undefined
        ? undefined
        : { sourceIdentity: "host-config-test", canonicalJson: bundleJson },
    ),
  readSandboxAuthorityHighWater: () => Effect.succeed(highWaterJson),
});

describe("SandboxAuthorityBundleV1", () => {
  it.effect(
    "validates canonical bundle/high-water and returns one immutable snapshot",
    () =>
      Effect.gen(function* () {
        const current = fixture();
        const source = sourceFor(current.bundleJson, current.highWaterJson);
        const result =
          yield* loadSandboxAuthorityBundleSnapshotV1Forensic(source);
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
        expect(Object.keys(source).sort()).toEqual([
          "readSandboxAuthorityHighWater",
          "readVerifiedSandboxAuthorityBundle",
        ]);
        expect(source).not.toHaveProperty("commitSandboxAuthorityHighWater");
        expect(source).not.toHaveProperty("appendSandboxAuthorityAudit");
      }),
  );

  it.effect("never advances high-water when a forensic source is ahead", () =>
    Effect.gen(function* () {
      const previous = fixture(1);
      const next = fixture(2);
      const result = yield* loadSandboxAuthorityBundleSnapshotV1Forensic(
        sourceFor(next.bundleJson, previous.highWaterJson),
      );
      expect(result).toEqual({
        _tag: "Unavailable",
        failure: "HighWaterCommitFailed",
      });
    }),
  );

  it.effect.each<[string | undefined, string]>([
    [undefined, "HighWaterMissing"],
    ["{bad", "HighWaterCorrupt"],
  ])("fails closed for invalid high-water %s", ([highWater, failure]) =>
    Effect.gen(function* () {
      const current = fixture();
      const result = yield* loadSandboxAuthorityBundleSnapshotV1Forensic(
        sourceFor(current.bundleJson, highWater),
      );
      expect(result).toEqual({ _tag: "Unavailable", failure });
    }),
  );

  it.effect(
    "rejects bundle tampering and source rollback without updating high-water",
    () =>
      Effect.gen(function* () {
        const current = fixture(2);
        const prior = fixture(1);
        const tampered = current.bundleJson.replace(
          '"sourceIdentity":"host-config-test"',
          '"sourceIdentity":"host-config-test","unknown":true',
        );
        const malformed = yield* loadSandboxAuthorityBundleSnapshotV1Forensic(
          sourceFor(tampered, current.highWaterJson),
        );
        expect(malformed).toEqual({
          _tag: "Unavailable",
          failure: "BundleMalformed",
        });
        const rollback = yield* loadSandboxAuthorityBundleSnapshotV1Forensic(
          sourceFor(prior.bundleJson, current.highWaterJson),
        );
        expect(rollback).toEqual({
          _tag: "Unavailable",
          failure: "RevisionRollback",
        });
      }),
  );
});
