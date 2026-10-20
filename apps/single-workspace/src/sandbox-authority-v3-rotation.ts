import { createHash } from "node:crypto";
import {
  decodeCanonicalSandboxAuthorityBundleV3,
  decodeCanonicalSandboxAuthorityHighWaterV3,
  decodeCanonicalWindowsNativeOperatorTrustSetV1,
  decodeSandboxProviderQualificationRegistryV1,
  encodeSandboxAuthorityBundleV3,
  encodeSandboxAuthorityHighWaterV3,
  encodeSandboxProviderQualificationRegistryV1,
  type SandboxAuthorityBundleV3,
} from "@arbor/domain";
import {
  SANDBOX_ENV_ALLOWLIST,
  SandboxAuthorityProvisioningStore,
} from "@arbor/ports";
import { Effect } from "effect";
import { loadSandboxAuthorityBundleSnapshotV3 } from "./sandbox-authority-bundle-v3.js";

const hash = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const hashBytes = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export type SandboxAuthorityV3RotationFailure =
  | "CurrentV3Unavailable"
  | "TrustSetRevisionInvalid"
  | "RegistryRevisionInvalid"
  | "CapabilityRevisionInvalid"
  | "RevisionOverflow"
  | "ForensicPreservationFailed"
  | "SourceWriteFailed"
  | "SourceVerificationFailed"
  | "HighWaterCommitFailed"
  | "PairVerificationFailed";

/** Operator-only V3 rotation/revocation. It can demote or replace Windows
 * rows but cannot create Supported; that requires independent D4–D6 review. */
export const rotateSandboxAuthorityV3Trust = (input: {
  readonly trustSetCanonicalJson: string;
  readonly providerRegistryCanonicalJson: string;
  readonly allowedEnvironmentNames?: ReadonlyArray<string>;
  readonly atStage?: (
    stage: "AfterV3SourceDurableBeforeHighWater" | "AfterV3HighWaterDurable",
  ) => Effect.Effect<void>;
}): Effect.Effect<
  SandboxAuthorityBundleV3,
  SandboxAuthorityV3RotationFailure,
  SandboxAuthorityProvisioningStore
> =>
  Effect.gen(function* () {
    const store = yield* SandboxAuthorityProvisioningStore;
    const fail = (reason: SandboxAuthorityV3RotationFailure) =>
      Effect.fail(reason);
    if (store.readSandboxAuthorityAuditForensic === undefined)
      return yield* fail("ForensicPreservationFailed");
    const read = () =>
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
    const before = yield* read();
    if (before.source === undefined || before.highWater === undefined)
      return yield* fail("CurrentV3Unavailable");
    const current = yield* loadSandboxAuthorityBundleSnapshotV3(
      store,
      new Date().toISOString(),
      input.allowedEnvironmentNames ?? SANDBOX_ENV_ALLOWLIST,
    );
    if (current._tag !== "Available")
      return yield* fail("CurrentV3Unavailable");
    const afterLoad = yield* read();
    if (
      afterLoad.source?.canonicalJson !== before.source.canonicalJson ||
      afterLoad.highWater !== before.highWater
    )
      return yield* fail("CurrentV3Unavailable");
    const auditBefore = yield* Effect.match(
      store.readSandboxAuthorityAuditForensic(),
      { onFailure: () => undefined, onSuccess: (value) => value },
    );
    if (auditBefore === undefined)
      return yield* fail("ForensicPreservationFailed");
    const trust = decodeCanonicalWindowsNativeOperatorTrustSetV1(
      input.trustSetCanonicalJson,
      hashBytes,
    );
    const previous = current.snapshot.bundle;
    if (
      trust === undefined ||
      trust.sourceIdentity !== previous.sourceIdentity ||
      trust.revision <= previous.windowsOperatorTrustSetRevision ||
      hash(input.trustSetCanonicalJson) ===
        previous.windowsOperatorTrustSetDigest
    )
      return yield* fail("TrustSetRevisionInvalid");
    let rawRegistry: unknown;
    try {
      rawRegistry = JSON.parse(input.providerRegistryCanonicalJson);
    } catch {
      return yield* fail("RegistryRevisionInvalid");
    }
    const registry = decodeSandboxProviderQualificationRegistryV1(rawRegistry);
    if (
      registry === undefined ||
      encodeSandboxProviderQualificationRegistryV1(registry) !==
        input.providerRegistryCanonicalJson ||
      registry.revision <= previous.providerRegistryRevision ||
      registry.entries.some(
        (row) => row.osFamily === "Windows" && row.status === "Supported",
      )
    )
      return yield* fail("RegistryRevisionInvalid");
    const oldWindowsRows = previous.providerRegistry.entries.filter(
      (row) => row.osFamily === "Windows",
    );
    for (const row of registry.entries.filter(
      (entry) => entry.osFamily === "Windows",
    )) {
      const priorMax = oldWindowsRows
        .filter((old) => old.providerId === row.providerId)
        .reduce((highest, old) => Math.max(highest, old.capabilityRevision), 0);
      // Revision advance binds the provider's rotated trust epoch, even if
      // the operator also changes version, OS build, tuple or rule set.
      if (priorMax > 0 && row.capabilityRevision <= priorMax)
        return yield* fail("CapabilityRevisionInvalid");
    }
    if (previous.bundleRevision >= Number.MAX_SAFE_INTEGER)
      return yield* fail("RevisionOverflow");
    const bundle: SandboxAuthorityBundleV3 = {
      ...previous,
      bundleRevision: previous.bundleRevision + 1,
      providerRegistryRevision: registry.revision,
      providerRegistryDigest: hash(input.providerRegistryCanonicalJson),
      providerRegistry: registry,
      windowsOperatorTrustSetRevision: trust.revision,
      windowsOperatorTrustSetDigest: hash(input.trustSetCanonicalJson),
      windowsOperatorTrustSet: trust,
    };
    const bundleJson = encodeSandboxAuthorityBundleV3(bundle);
    const decoded = decodeCanonicalSandboxAuthorityBundleV3(
      bundleJson,
      input.allowedEnvironmentNames ?? SANDBOX_ENV_ALLOWLIST,
      hash,
      hashBytes,
    );
    if (decoded === undefined) return yield* fail("SourceVerificationFailed");
    const evidence = [
      {
        id: `v3-bundle-${hash(before.source.canonicalJson)}`,
        bytes: before.source.canonicalJson,
      },
      {
        id: `v3-high-water-${hash(before.highWater)}`,
        bytes: before.highWater,
      },
      { id: `v3-audit-${hash(auditBefore)}`, bytes: auditBefore },
    ];
    for (const item of evidence) {
      const saved = yield* Effect.match(
        store.preserveForensicEvidence({
          evidenceId: item.id,
          exactBytes: item.bytes,
        }),
        { onFailure: () => false, onSuccess: Boolean },
      );
      const readback = saved
        ? yield* Effect.match(store.readForensicEvidence(item.id), {
            onFailure: () => undefined,
            onSuccess: (value) => value,
          })
        : undefined;
      if (readback !== item.bytes)
        return yield* fail("ForensicPreservationFailed");
    }
    const auditAtWrite = yield* Effect.match(
      store.readSandboxAuthorityAuditForensic(),
      { onFailure: () => undefined, onSuccess: (value) => value },
    );
    if (auditAtWrite !== auditBefore)
      return yield* fail("CurrentV3Unavailable");
    const written = yield* Effect.match(
      store.writeSandboxAuthorityBundleAtomically(bundleJson),
      {
        onFailure: () => false,
        onSuccess: Boolean,
      },
    );
    if (!written) return yield* fail("SourceWriteFailed");
    const mid = yield* read();
    if (
      mid.source?.canonicalJson !== bundleJson ||
      mid.highWater !== before.highWater
    )
      return yield* fail("SourceVerificationFailed");
    if (input.atStage !== undefined)
      yield* input.atStage("AfterV3SourceDurableBeforeHighWater");
    const highWaterJson = encodeSandboxAuthorityHighWaterV3({
      version: 3,
      sourceIdentity: bundle.sourceIdentity,
      bundleRevision: bundle.bundleRevision,
      bundleDigest: decoded.bundleDigest,
      issuerConfigRevision: bundle.issuerConfigRevision,
      issuerConfigDigest: bundle.issuerConfigDigest,
      operatorConfigRevision: bundle.operatorConfigRevision,
      operatorConfigDigest: bundle.operatorConfigDigest,
      providerRegistryRevision: bundle.providerRegistryRevision,
      providerRegistryDigest: bundle.providerRegistryDigest,
      windowsOperatorTrustSetRevision: bundle.windowsOperatorTrustSetRevision,
      windowsOperatorTrustSetDigest: bundle.windowsOperatorTrustSetDigest,
    });
    if (decodeCanonicalSandboxAuthorityHighWaterV3(highWaterJson) === undefined)
      return yield* fail("PairVerificationFailed");
    const committed = yield* Effect.match(
      store.commitSandboxAuthorityHighWater(highWaterJson),
      { onFailure: () => false, onSuccess: Boolean },
    );
    if (!committed) return yield* fail("HighWaterCommitFailed");
    if (input.atStage !== undefined)
      yield* input.atStage("AfterV3HighWaterDurable");
    const final = yield* read();
    if (
      final.source?.canonicalJson !== bundleJson ||
      final.highWater !== highWaterJson
    )
      return yield* fail("PairVerificationFailed");
    return bundle;
  });
