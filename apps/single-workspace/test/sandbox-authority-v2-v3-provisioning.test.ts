import { createHash } from "node:crypto";
import {
  encodeSandboxAuthorityBundleV2,
  encodeSandboxAuthorityHighWaterV2,
  encodeSandboxOperatorPolicyConfigV1,
  Principal,
  parse,
} from "@arbor/domain";
import {
  SandboxAuthorityProvisioningStore,
  type SandboxAuthorityProvisioningStoreService,
} from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { loadSandboxAuthorityBundleSnapshotCurrent } from "../src/sandbox-authority-bundle.js";
import { provisionSandboxAuthorityV2ToV3 } from "../src/sandbox-authority-v2-v3-provisioning.js";

const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const trust =
  '{"version":1,"revision":1,"sourceIdentity":"host:test","providerId":"windows-restricted-appcontainer-job","keys":[{"keyId":"operator-2026-a","algorithm":"Ed25519","publicKeySpkiDerBase64":"MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=","publicKeySpkiSha256":"06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9","validFrom":"2026-10-20T00:00:00.000Z","validUntil":"2027-10-20T00:00:00.000Z","status":"Active"}],"revokedKeyIds":[]}';

const makeStore = () => {
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
  const bundle = {
    version: 2 as const,
    sourceIdentity: "host:test",
    bundleRevision: 2,
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
  };
  const originalSource = encodeSandboxAuthorityBundleV2(bundle);
  const originalHighWater = encodeSandboxAuthorityHighWaterV2({
    version: 2,
    sourceIdentity: bundle.sourceIdentity,
    bundleRevision: bundle.bundleRevision,
    bundleDigest: hash(originalSource),
    issuerConfigRevision: bundle.issuerConfigRevision,
    issuerConfigDigest: bundle.issuerConfigDigest,
    operatorConfigRevision: bundle.operatorConfigRevision,
    operatorConfigDigest: bundle.operatorConfigDigest,
    providerRegistryRevision: bundle.providerRegistryRevision,
    providerRegistryDigest: bundle.providerRegistryDigest,
  });
  const originalAudit = '{"version":2,"outcome":"Loaded"}\n';
  const state = {
    source: originalSource,
    highWater: originalHighWater,
    audit: originalAudit,
    forensic: new Map<string, string>(),
  };
  const store: SandboxAuthorityProvisioningStoreService = {
    readVerifiedSandboxAuthorityBundle: () =>
      Effect.sync(() => ({
        sourceIdentity: "host:test",
        canonicalJson: state.source,
      })),
    readSandboxAuthorityHighWater: () => Effect.sync(() => state.highWater),
    commitSandboxAuthorityHighWater: (value) =>
      Effect.sync(() => {
        state.highWater = value;
        return true;
      }),
    appendSandboxAuthorityAudit: (value) =>
      Effect.sync(() => {
        state.audit += `${value}\n`;
        return true;
      }),
    readSandboxAuthorityAuditForensic: () => Effect.sync(() => state.audit),
    writeSandboxAuthorityBundleAtomically: (value) =>
      Effect.sync(() => {
        state.source = value;
        return true;
      }),
    preserveForensicEvidence: ({ evidenceId, exactBytes }) =>
      Effect.sync(() => {
        if (state.forensic.has(evidenceId)) return false;
        state.forensic.set(evidenceId, exactBytes);
        return true;
      }),
    readForensicEvidence: (id) => Effect.sync(() => state.forensic.get(id)),
  };
  return { state, store, originalSource, originalHighWater, originalAudit };
};

describe("Windows D2 operator-only V2 to V3 source-first cutover", () => {
  it("preserves exact V2 bytes and fails closed between source and high-water", async () => {
    const fixture = makeStore();
    let between: unknown;
    const result = await Effect.runPromise(
      provisionSandboxAuthorityV2ToV3({
        trustSetCanonicalJson: trust,
        atStage: (stage) =>
          Effect.gen(function* () {
            if (stage === "AfterV3SourceDurableBeforeHighWater")
              between = yield* loadSandboxAuthorityBundleSnapshotCurrent(
                fixture.store,
                "2026-10-20T00:00:00.000Z",
                [],
              );
          }),
      }).pipe(
        Effect.provideService(SandboxAuthorityProvisioningStore, fixture.store),
      ),
    );
    expect(between).toEqual({
      _tag: "Unavailable",
      failure: "HighWaterCorrupt",
    });
    expect(fixture.state.forensic.get(result.preservedV2BundleEvidenceId)).toBe(
      fixture.originalSource,
    );
    expect(
      fixture.state.forensic.get(result.preservedV2HighWaterEvidenceId),
    ).toBe(fixture.originalHighWater);
    expect(fixture.state.forensic.get(result.preservedV2AuditEvidenceId)).toBe(
      fixture.originalAudit,
    );
    const current = await Effect.runPromise(
      loadSandboxAuthorityBundleSnapshotCurrent(
        fixture.store,
        "2026-10-20T00:00:00.000Z",
        [],
      ),
    );
    expect(current._tag).toBe("Available");
    if (current._tag === "Available")
      expect(current.snapshot.bundle.version).toBe(3);
  });

  it("requires audit preservation and never mutates source without it", async () => {
    const fixture = makeStore();
    const { readSandboxAuthorityAuditForensic: _ignored, ...withoutAudit } =
      fixture.store;
    const result = await Effect.runPromise(
      provisionSandboxAuthorityV2ToV3({ trustSetCanonicalJson: trust }).pipe(
        Effect.provideService(SandboxAuthorityProvisioningStore, withoutAudit),
        Effect.match({
          onFailure: (reason) => reason,
          onSuccess: () => "Succeeded",
        }),
      ),
    );
    expect(result).toBe("V2AuditUnavailable");
    expect(fixture.state.source).toBe(fixture.originalSource);
    expect(fixture.state.highWater).toBe(fixture.originalHighWater);
  });
});
