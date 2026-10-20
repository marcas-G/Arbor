import { createHash } from "node:crypto";
import {
  decodeCanonicalSandboxAuthorityBundleV3,
  decodeCanonicalSandboxAuthorityHighWaterV2,
  decodeCanonicalSandboxAuthorityHighWaterV3,
  decodeCanonicalWindowsNativeOperatorTrustSetV1,
  decodeSandboxProviderQualificationRegistryV1,
  encodeSandboxAuthorityBundleV3,
  encodeSandboxAuthorityHighWaterV3,
  encodeSandboxProviderQualificationRegistryV1,
  type SandboxAuthorityBundleV3,
  type SandboxAuthorityHighWaterV3,
} from "@arbor/domain";
import {
  SANDBOX_ENV_ALLOWLIST,
  SandboxAuthorityProvisioningStore,
  type SandboxAuthorityProvisioningStoreService,
} from "@arbor/ports";
import { Effect } from "effect";
import { loadSandboxAuthorityBundleSnapshotV2 } from "./sandbox-authority-bundle.js";

const hash = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const hashBytes = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export type SandboxAuthorityV3ProvisioningFailure =
  | "V2SourceUnavailable"
  | "V2AuditUnavailable"
  | "V2PairDrifted"
  | "TrustSetInvalid"
  | "RegistryDowngradeRequired"
  | "RevisionOverflow"
  | "ForensicPreservationFailed"
  | "V3SourceWriteFailed"
  | "V3SourceVerificationFailed"
  | "V3HighWaterCommitFailed"
  | "V3PairVerificationFailed";

export interface SandboxAuthorityV3ProvisioningResult {
  readonly bundle: SandboxAuthorityBundleV3;
  readonly bundleCanonicalJson: string;
  readonly highWater: SandboxAuthorityHighWaterV3;
  readonly highWaterCanonicalJson: string;
  readonly preservedV2BundleEvidenceId: string;
  readonly preservedV2HighWaterEvidenceId: string;
  readonly preservedV2AuditEvidenceId: string;
}

export type SandboxAuthorityV3ProvisioningStage =
  | "AfterV3SourceDurableBeforeHighWater"
  | "AfterV3HighWaterDurable";

const fail = (reason: SandboxAuthorityV3ProvisioningFailure) =>
  Effect.fail(reason);
const stableRead = (store: SandboxAuthorityProvisioningStoreService) =>
  Effect.gen(function* () {
    const source = yield* Effect.match(
      store.readVerifiedSandboxAuthorityBundle(),
      {
        onFailure: () => undefined,
        onSuccess: (value) => value,
      },
    );
    const highWater = yield* Effect.match(
      store.readSandboxAuthorityHighWater(),
      {
        onFailure: () => undefined,
        onSuccess: (value) => value,
      },
    );
    return { source, highWater };
  });

/** Operator-only offline source-first cutover. No daemon composition imports
 * or constructs this function. The injected store must prove protected audit
 * access; lacking that seam is a closed failure, not an evidence omission. */
export const provisionSandboxAuthorityV2ToV3 = (input: {
  readonly trustSetCanonicalJson: string;
  readonly providerRegistryCanonicalJson?: string;
  readonly allowedEnvironmentNames?: ReadonlyArray<string>;
  readonly atStage?: (
    stage: SandboxAuthorityV3ProvisioningStage,
  ) => Effect.Effect<void>;
}): Effect.Effect<
  SandboxAuthorityV3ProvisioningResult,
  SandboxAuthorityV3ProvisioningFailure,
  SandboxAuthorityProvisioningStore
> =>
  Effect.gen(function* () {
    const store = yield* SandboxAuthorityProvisioningStore;
    const allowedEnvironmentNames =
      input.allowedEnvironmentNames ?? SANDBOX_ENV_ALLOWLIST;
    if (store.readSandboxAuthorityAuditForensic === undefined)
      return yield* fail("V2AuditUnavailable");
    const before = yield* stableRead(store);
    if (before.source === undefined || before.highWater === undefined)
      return yield* fail("V2SourceUnavailable");
    const auditBefore = yield* Effect.match(
      store.readSandboxAuthorityAuditForensic(),
      {
        onFailure: () => undefined,
        onSuccess: (value) => value,
      },
    );
    if (auditBefore === undefined) return yield* fail("V2AuditUnavailable");
    const loaded = yield* loadSandboxAuthorityBundleSnapshotV2(
      store,
      new Date().toISOString(),
      allowedEnvironmentNames,
    );
    if (loaded._tag !== "Available") return yield* fail("V2SourceUnavailable");
    const after = yield* stableRead(store);
    if (
      after.source?.sourceIdentity !== before.source.sourceIdentity ||
      after.source.canonicalJson !== before.source.canonicalJson ||
      after.highWater !== before.highWater
    )
      return yield* fail("V2PairDrifted");
    const oldHighWater = decodeCanonicalSandboxAuthorityHighWaterV2(
      before.highWater,
    );
    if (
      oldHighWater === undefined ||
      oldHighWater.bundleDigest !== loaded.snapshot.bundleDigest
    )
      return yield* fail("V2SourceUnavailable");
    const previous = loaded.snapshot.bundle;
    const trust = decodeCanonicalWindowsNativeOperatorTrustSetV1(
      input.trustSetCanonicalJson,
      hashBytes,
    );
    if (trust === undefined || trust.sourceIdentity !== previous.sourceIdentity)
      return yield* fail("TrustSetInvalid");
    let registry = previous.providerRegistry;
    let registryDigest = previous.providerRegistryDigest;
    if (input.providerRegistryCanonicalJson !== undefined) {
      let raw: unknown;
      try {
        raw = JSON.parse(input.providerRegistryCanonicalJson);
      } catch {
        return yield* fail("RegistryDowngradeRequired");
      }
      const decoded = decodeSandboxProviderQualificationRegistryV1(raw);
      if (
        decoded === undefined ||
        encodeSandboxProviderQualificationRegistryV1(decoded) !==
          input.providerRegistryCanonicalJson ||
        decoded.revision <= previous.providerRegistryRevision
      )
        return yield* fail("RegistryDowngradeRequired");
      registry = decoded;
      registryDigest = hash(input.providerRegistryCanonicalJson);
    }
    // D2 cannot create or carry a Windows Supported row, signed or otherwise.
    if (
      registry.entries.some(
        (row) => row.osFamily === "Windows" && row.status === "Supported",
      )
    )
      return yield* fail("RegistryDowngradeRequired");
    if (previous.bundleRevision >= Number.MAX_SAFE_INTEGER)
      return yield* fail("RevisionOverflow");
    const bundle: SandboxAuthorityBundleV3 = {
      ...previous,
      version: 3,
      bundleRevision: previous.bundleRevision + 1,
      providerRegistryRevision: registry.revision,
      providerRegistryDigest: registryDigest,
      providerRegistry: registry,
      windowsOperatorTrustSetRevision: trust.revision,
      windowsOperatorTrustSetDigest: hash(input.trustSetCanonicalJson),
      windowsOperatorTrustSet: trust,
    };
    const bundleCanonicalJson = encodeSandboxAuthorityBundleV3(bundle);
    const decodedV3 = decodeCanonicalSandboxAuthorityBundleV3(
      bundleCanonicalJson,
      allowedEnvironmentNames,
      hash,
      hashBytes,
    );
    if (decodedV3 === undefined)
      return yield* fail("V3SourceVerificationFailed");
    const evidence = [
      {
        id: `v2-bundle-${hash(before.source.canonicalJson)}`,
        bytes: before.source.canonicalJson,
      },
      {
        id: `v2-high-water-${hash(before.highWater)}`,
        bytes: before.highWater,
      },
      { id: `v2-audit-${hash(auditBefore)}`, bytes: auditBefore },
    ] as const;
    for (const item of evidence) {
      const stored = yield* Effect.match(
        store.preserveForensicEvidence({
          evidenceId: item.id,
          exactBytes: item.bytes,
        }),
        { onFailure: () => false, onSuccess: Boolean },
      );
      const readback = stored
        ? yield* Effect.match(store.readForensicEvidence(item.id), {
            onFailure: () => undefined,
            onSuccess: (value) => value,
          })
        : undefined;
      if (readback !== item.bytes)
        return yield* fail("ForensicPreservationFailed");
    }
    const written = yield* Effect.match(
      store.writeSandboxAuthorityBundleAtomically(bundleCanonicalJson),
      { onFailure: () => false, onSuccess: Boolean },
    );
    if (!written) return yield* fail("V3SourceWriteFailed");
    const sourceAfterWrite = yield* stableRead(store);
    if (
      sourceAfterWrite.source?.canonicalJson !== bundleCanonicalJson ||
      sourceAfterWrite.source.sourceIdentity !== bundle.sourceIdentity ||
      sourceAfterWrite.highWater !== before.highWater
    )
      return yield* fail("V3SourceVerificationFailed");
    if (input.atStage !== undefined)
      yield* input.atStage("AfterV3SourceDurableBeforeHighWater");
    const highWater: SandboxAuthorityHighWaterV3 = {
      version: 3,
      sourceIdentity: bundle.sourceIdentity,
      bundleRevision: bundle.bundleRevision,
      bundleDigest: decodedV3.bundleDigest,
      issuerConfigRevision: bundle.issuerConfigRevision,
      issuerConfigDigest: bundle.issuerConfigDigest,
      operatorConfigRevision: bundle.operatorConfigRevision,
      operatorConfigDigest: bundle.operatorConfigDigest,
      providerRegistryRevision: bundle.providerRegistryRevision,
      providerRegistryDigest: bundle.providerRegistryDigest,
      windowsOperatorTrustSetRevision: bundle.windowsOperatorTrustSetRevision,
      windowsOperatorTrustSetDigest: bundle.windowsOperatorTrustSetDigest,
    };
    const highWaterCanonicalJson = encodeSandboxAuthorityHighWaterV3(highWater);
    if (
      decodeCanonicalSandboxAuthorityHighWaterV3(highWaterCanonicalJson) ===
      undefined
    )
      return yield* fail("V3PairVerificationFailed");
    const committed = yield* Effect.match(
      store.commitSandboxAuthorityHighWater(highWaterCanonicalJson),
      { onFailure: () => false, onSuccess: Boolean },
    );
    if (!committed) return yield* fail("V3HighWaterCommitFailed");
    if (input.atStage !== undefined)
      yield* input.atStage("AfterV3HighWaterDurable");
    const final = yield* stableRead(store);
    if (
      final.source?.canonicalJson !== bundleCanonicalJson ||
      final.source.sourceIdentity !== bundle.sourceIdentity ||
      final.highWater !== highWaterCanonicalJson
    )
      return yield* fail("V3PairVerificationFailed");
    return {
      bundle,
      bundleCanonicalJson,
      highWater,
      highWaterCanonicalJson,
      preservedV2BundleEvidenceId: evidence[0].id,
      preservedV2HighWaterEvidenceId: evidence[1].id,
      preservedV2AuditEvidenceId: evidence[2].id,
    };
  });
