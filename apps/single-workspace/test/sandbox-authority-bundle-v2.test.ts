import { createHash } from "node:crypto";
import {
  encodeSandboxAuthorityBundleV2,
  encodeSandboxAuthorityHighWaterV2,
  encodeSandboxOperatorPolicyConfigV1,
} from "@arbor/domain";
import { SANDBOX_ENV_ALLOWLIST } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { loadSandboxAuthorityBundleSnapshotV2 } from "../src/sandbox-authority-bundle.js";

const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const fixture = (bundleRevision = 2) => {
  const issuerConfig = {
    version: 1 as const,
    revision: 1,
    issuers: ["user:operator"],
  };
  const issuerConfigJson =
    '{"version":1,"revision":1,"issuers":["user:operator"]}';
  const operatorConfig = {
    version: 1 as const,
    revision: 1,
    environmentAllowlist: ["PATH"],
    limitsByProfile: ["ReadOnly", "WorkspaceWrite", "FullAccess"].map(
      (profile) => ({
        profile,
        limits: {
          wallTimeMs: 60_000,
          stdoutBytes: 8192,
          stderrBytes: 8192,
          processCount: 8,
          memoryBytes: 134_217_728,
          cpuTimeMs: 30_000,
        },
      }),
    ),
    trustedLocalRuntimeVersion: "builtin-v1" as const,
  };
  const operatorConfigJson =
    encodeSandboxOperatorPolicyConfigV1(operatorConfig);
  const providerRegistry = { version: 1 as const, revision: 1, entries: [] };
  const providerRegistryJson = '{"version":1,"revision":1,"entries":[]}';
  const bundle = {
    version: 2 as const,
    sourceIdentity: "host-config-test",
    bundleRevision,
    issuerConfigRevision: 1,
    issuerConfigDigest: hash(issuerConfigJson),
    issuerConfig,
    operatorConfigRevision: 1,
    operatorConfigDigest: hash(operatorConfigJson),
    operatorConfig,
    providerRegistryRevision: 1,
    providerRegistryDigest: hash(providerRegistryJson),
    providerRegistry,
  };
  const bundleJson = encodeSandboxAuthorityBundleV2(bundle);
  const highWater = {
    version: 2 as const,
    sourceIdentity: bundle.sourceIdentity,
    bundleRevision,
    bundleDigest: hash(bundleJson),
    issuerConfigRevision: bundle.issuerConfigRevision,
    issuerConfigDigest: bundle.issuerConfigDigest,
    operatorConfigRevision: bundle.operatorConfigRevision,
    operatorConfigDigest: bundle.operatorConfigDigest,
    providerRegistryRevision: bundle.providerRegistryRevision,
    providerRegistryDigest: bundle.providerRegistryDigest,
  };
  return {
    bundle,
    bundleJson,
    highWater,
    highWaterJson: encodeSandboxAuthorityHighWaterV2(highWater),
  };
};

const sourceFor = (
  bundleJson: string | undefined,
  highWaterJson: string | undefined,
  writes: { readonly highWater: string[]; readonly audit: string[] } = {
    highWater: [],
    audit: [],
  },
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
      writes.highWater.push(json);
      return true;
    }),
  appendSandboxAuthorityAudit: (json: string) =>
    Effect.sync(() => {
      writes.audit.push(json);
      return true;
    }),
});

const now = "2026-10-19T00:00:00.000Z";

describe("P5 SandboxAuthorityBundleV2 exact source/high-water admission", () => {
  it("publishes only the exact V2 source/high-water pair and emits V2 audit", async () => {
    const current = fixture();
    const writes = { highWater: [] as string[], audit: [] as string[] };
    const result = await Effect.runPromise(
      loadSandboxAuthorityBundleSnapshotV2(
        sourceFor(current.bundleJson, current.highWaterJson, writes),
        now,
        SANDBOX_ENV_ALLOWLIST,
      ),
    );
    expect(result._tag).toBe("Available");
    if (result._tag !== "Available") return;
    expect(result.snapshot.bundle).toEqual(current.bundle);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.bundle.operatorConfig)).toBe(true);
    expect(
      Object.isFrozen(result.snapshot.bundle.operatorConfig.limitsByProfile),
    ).toBe(true);
    expect(writes.highWater).toEqual([]);
    expect(JSON.parse(writes.audit[0] ?? "{}")).toMatchObject({
      version: 2,
      outcome: "Loaded",
      detail: null,
      operatorConfigRevision: 1,
      occurredAt: now,
    });
  });

  it("fails closed for V1 high-water and never falls back or upgrades at startup", async () => {
    const current = fixture();
    const v1HighWater =
      '{"version":1,"sourceIdentity":"host-config-test","bundleRevision":1,"bundleDigest":"' +
      "a".repeat(64) +
      '","issuerConfigRevision":1,"issuerConfigDigest":"' +
      "b".repeat(64) +
      '","providerRegistryRevision":1,"providerRegistryDigest":"' +
      "c".repeat(64) +
      '"}';
    const writes = { highWater: [] as string[], audit: [] as string[] };
    const result = await Effect.runPromise(
      loadSandboxAuthorityBundleSnapshotV2(
        sourceFor(current.bundleJson, v1HighWater, writes),
        now,
        SANDBOX_ENV_ALLOWLIST,
      ),
    );
    expect(result).toEqual({
      _tag: "Unavailable",
      failure: "HighWaterCorrupt",
    });
    expect(writes.highWater).toEqual([]);
    expect(JSON.parse(writes.audit[0] ?? "{}")).toMatchObject({
      version: 2,
      outcome: "Rejected",
      detail: "HighWaterCorrupt",
    });
  });

  it("keeps a source-ahead interruption state unavailable, then accepts the committed pair", async () => {
    const previous = fixture(2);
    const sourceAhead = fixture(3);
    const beforeCommitWrites = {
      highWater: [] as string[],
      audit: [] as string[],
    };
    const beforeCommit = await Effect.runPromise(
      loadSandboxAuthorityBundleSnapshotV2(
        sourceFor(
          sourceAhead.bundleJson,
          previous.highWaterJson,
          beforeCommitWrites,
        ),
        now,
        SANDBOX_ENV_ALLOWLIST,
      ),
    );
    expect(beforeCommit).toEqual({
      _tag: "Unavailable",
      failure: "HighWaterCommitFailed",
    });
    expect(beforeCommitWrites.highWater).toEqual([]);

    const afterCommit = await Effect.runPromise(
      loadSandboxAuthorityBundleSnapshotV2(
        sourceFor(sourceAhead.bundleJson, sourceAhead.highWaterJson),
        now,
        SANDBOX_ENV_ALLOWLIST,
      ),
    );
    expect(afterCommit._tag).toBe("Available");
  });
});
