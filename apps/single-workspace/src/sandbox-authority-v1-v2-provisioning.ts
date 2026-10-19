import {
  decodeCanonicalSandboxAuthorityBundleV2,
  decodeCanonicalSandboxAuthorityHighWaterV2,
  decodeSandboxOperatorPolicyConfigV1,
  encodeSandboxAuthorityBundleV2,
  encodeSandboxAuthorityHighWaterV2,
  encodeSandboxOperatorPolicyConfigV1,
  type SandboxAuthorityBundleV2,
  type SandboxAuthorityHighWaterV2,
  type SandboxAuthorityLoadErrorV1,
} from "@arbor/domain";
import {
  SANDBOX_ENV_ALLOWLIST,
  SandboxAuthorityProvisioningStore,
  type SandboxAuthorityProvisioningStoreService,
  sha256Hex,
} from "@arbor/ports";
import { Effect } from "effect";
import { loadSandboxAuthorityBundleSnapshotV1Forensic } from "./sandbox-authority-bundle.js";

export type SandboxAuthorityProvisioningFailure =
  | {
      readonly _tag: "SandboxAuthorityV1ForensicSourceUnavailable";
      readonly cause: SandboxAuthorityLoadErrorV1 | "SourceMissing";
    }
  | {
      readonly _tag: "SandboxAuthorityV1EvidencePreservationFailed";
      readonly evidence: "Bundle" | "HighWater";
    }
  | { readonly _tag: "SandboxAuthorityV2OperatorConfigInvalid" }
  | { readonly _tag: "SandboxAuthorityV2RevisionOverflow" }
  | { readonly _tag: "SandboxAuthorityV2SourceWriteFailed" }
  | { readonly _tag: "SandboxAuthorityV2SourceVerificationFailed" }
  | { readonly _tag: "SandboxAuthorityV2HighWaterCommitFailed" }
  | { readonly _tag: "SandboxAuthorityV2PairVerificationFailed" };

export type SandboxAuthorityProvisioningStage =
  | "AfterV2SourceDurableBeforeHighWater"
  | "AfterV2HighWaterDurable";

export interface SandboxAuthorityProvisioningQualificationProbe {
  readonly atStage?: (
    stage: SandboxAuthorityProvisioningStage,
  ) => Effect.Effect<void>;
}

export interface SandboxAuthorityProvisioningResultV1 {
  readonly sourceIdentity: string;
  readonly preservedV1BundleEvidenceId: string;
  readonly preservedV1HighWaterEvidenceId: string;
  readonly v2Bundle: SandboxAuthorityBundleV2;
  readonly v2BundleDigest: string;
  readonly v2BundleCanonicalJson: string;
  readonly v2HighWater: SandboxAuthorityHighWaterV2;
  readonly v2HighWaterCanonicalJson: string;
}

type EmptyFailureTag =
  | "SandboxAuthorityV2OperatorConfigInvalid"
  | "SandboxAuthorityV2RevisionOverflow"
  | "SandboxAuthorityV2SourceWriteFailed"
  | "SandboxAuthorityV2SourceVerificationFailed"
  | "SandboxAuthorityV2HighWaterCommitFailed"
  | "SandboxAuthorityV2PairVerificationFailed";
const failure = <T extends EmptyFailureTag>(
  _tag: T,
): Extract<SandboxAuthorityProvisioningFailure, { readonly _tag: T }> =>
  ({ _tag }) as Extract<
    SandboxAuthorityProvisioningFailure,
    { readonly _tag: T }
  >;

const exactV2BundleAtSource = (
  store: SandboxAuthorityProvisioningStoreService,
  expectedCanonicalJson: string,
  expectedSourceIdentity: string,
  allowedEnvironmentNames: ReadonlyArray<string>,
): Effect.Effect<boolean> =>
  Effect.match(store.readVerifiedSandboxAuthorityBundle(), {
    onFailure: () => false,
    onSuccess: (source) => {
      if (
        source === undefined ||
        source.sourceIdentity !== expectedSourceIdentity ||
        source.canonicalJson !== expectedCanonicalJson
      )
        return false;
      return (
        decodeCanonicalSandboxAuthorityBundleV2(
          source.canonicalJson,
          allowedEnvironmentNames,
          sha256Hex,
        ) !== undefined
      );
    },
  });

/** One-shot operator-only offline transition. This service is intentionally
 * absent from production composition/daemon wiring. The injected store owns
 * OS-protected source/high-water locations, atomic replacement and durable
 * create-only forensic evidence. */
export const provisionSandboxAuthorityV1ToV2 = (input: {
  readonly operatorConfig: unknown;
  readonly allowedEnvironmentNames?: ReadonlyArray<string>;
  readonly qualificationProbe?: SandboxAuthorityProvisioningQualificationProbe;
}): Effect.Effect<
  SandboxAuthorityProvisioningResultV1,
  SandboxAuthorityProvisioningFailure,
  SandboxAuthorityProvisioningStore
> =>
  Effect.gen(function* () {
    const store = yield* SandboxAuthorityProvisioningStore;
    const allowedEnvironmentNames =
      input.allowedEnvironmentNames ?? SANDBOX_ENV_ALLOWLIST;
    const sourceBefore = yield* store.readVerifiedSandboxAuthorityBundle().pipe(
      Effect.mapError(
        (cause) =>
          ({
            _tag: "SandboxAuthorityV1ForensicSourceUnavailable",
            cause,
          }) as const,
      ),
    );
    const highWaterBefore = yield* store.readSandboxAuthorityHighWater().pipe(
      Effect.mapError(
        (cause) =>
          ({
            _tag: "SandboxAuthorityV1ForensicSourceUnavailable",
            cause,
          }) as const,
      ),
    );
    if (sourceBefore === undefined || highWaterBefore === undefined)
      return yield* Effect.fail({
        _tag: "SandboxAuthorityV1ForensicSourceUnavailable" as const,
        cause: "SourceMissing" as const,
      });
    const v1 = yield* loadSandboxAuthorityBundleSnapshotV1Forensic(store).pipe(
      Effect.mapError(
        (cause) =>
          ({
            _tag: "SandboxAuthorityV1ForensicSourceUnavailable",
            cause,
          }) as const,
      ),
    );
    if (v1._tag !== "Available")
      return yield* Effect.fail({
        _tag: "SandboxAuthorityV1ForensicSourceUnavailable" as const,
        cause: v1.failure,
      });

    // Verify the exact raw pair used around the forensic loader stayed stable.
    const rawSource = yield* store.readVerifiedSandboxAuthorityBundle().pipe(
      Effect.mapError(
        (cause) =>
          ({
            _tag: "SandboxAuthorityV1ForensicSourceUnavailable",
            cause,
          }) as const,
      ),
    );
    const rawHighWater = yield* store.readSandboxAuthorityHighWater().pipe(
      Effect.mapError(
        (cause) =>
          ({
            _tag: "SandboxAuthorityV1ForensicSourceUnavailable",
            cause,
          }) as const,
      ),
    );
    if (
      rawSource === undefined ||
      rawHighWater === undefined ||
      rawSource.sourceIdentity !== v1.snapshot.bundle.sourceIdentity ||
      rawSource.canonicalJson !== v1.snapshot.canonicalJson ||
      rawSource.sourceIdentity !== sourceBefore.sourceIdentity ||
      rawSource.canonicalJson !== sourceBefore.canonicalJson ||
      rawHighWater !== highWaterBefore
    )
      return yield* Effect.fail({
        _tag: "SandboxAuthorityV1ForensicSourceUnavailable" as const,
        cause: "SourceMissing" as const,
      });

    const operatorConfig = decodeSandboxOperatorPolicyConfigV1(
      input.operatorConfig,
      allowedEnvironmentNames,
    );
    if (operatorConfig === undefined)
      return yield* Effect.fail(
        failure("SandboxAuthorityV2OperatorConfigInvalid"),
      );

    const previousRevision = v1.snapshot.bundle.bundleRevision;
    if (previousRevision >= Number.MAX_SAFE_INTEGER)
      return yield* Effect.fail(failure("SandboxAuthorityV2RevisionOverflow"));
    const bundle: SandboxAuthorityBundleV2 = {
      version: 2,
      sourceIdentity: v1.snapshot.bundle.sourceIdentity,
      bundleRevision: previousRevision + 1,
      issuerConfigRevision: v1.snapshot.bundle.issuerConfigRevision,
      issuerConfigDigest: v1.snapshot.bundle.issuerConfigDigest,
      issuerConfig: v1.snapshot.bundle.issuerConfig,
      operatorConfigRevision: operatorConfig.revision,
      operatorConfigDigest: sha256Hex(
        encodeSandboxOperatorPolicyConfigV1(operatorConfig),
      ),
      operatorConfig,
      providerRegistryRevision: v1.snapshot.bundle.providerRegistryRevision,
      providerRegistryDigest: v1.snapshot.bundle.providerRegistryDigest,
      providerRegistry: v1.snapshot.bundle.providerRegistry,
    };
    const canonicalJson = encodeSandboxAuthorityBundleV2(bundle);
    const decoded = decodeCanonicalSandboxAuthorityBundleV2(
      canonicalJson,
      allowedEnvironmentNames,
      sha256Hex,
    );
    if (
      decoded === undefined ||
      decoded.bundle.sourceIdentity !== bundle.sourceIdentity ||
      decoded.bundle.bundleRevision <= previousRevision ||
      decoded.bundle.issuerConfigDigest !==
        v1.snapshot.bundle.issuerConfigDigest ||
      decoded.bundle.providerRegistryDigest !==
        v1.snapshot.bundle.providerRegistryDigest
    )
      return yield* Effect.fail(
        failure("SandboxAuthorityV2SourceVerificationFailed"),
      );

    const bundleEvidenceId = `v1-bundle-${sha256Hex(rawSource.canonicalJson)}`;
    const highWaterEvidenceId = `v1-high-water-${sha256Hex(rawHighWater)}`;
    const preserve = (evidenceId: string, exactBytes: string) =>
      Effect.gen(function* () {
        const stored = yield* Effect.match(
          store.preserveForensicEvidence({ evidenceId, exactBytes }),
          {
            onFailure: () => false,
            onSuccess: Boolean,
          },
        );
        if (!stored) return false;
        const readback = yield* Effect.match(
          store.readForensicEvidence(evidenceId),
          {
            onFailure: () => undefined,
            onSuccess: (value) => value,
          },
        );
        return readback === exactBytes;
      });
    if (!(yield* preserve(bundleEvidenceId, rawSource.canonicalJson)))
      return yield* Effect.fail({
        _tag: "SandboxAuthorityV1EvidencePreservationFailed" as const,
        evidence: "Bundle" as const,
      });
    if (!(yield* preserve(highWaterEvidenceId, rawHighWater)))
      return yield* Effect.fail({
        _tag: "SandboxAuthorityV1EvidencePreservationFailed" as const,
        evidence: "HighWater" as const,
      });

    const sourceWritten = yield* Effect.match(
      store.writeSandboxAuthorityBundleAtomically(canonicalJson),
      {
        onFailure: () => false,
        onSuccess: Boolean,
      },
    );
    if (!sourceWritten)
      return yield* Effect.fail(failure("SandboxAuthorityV2SourceWriteFailed"));
    if (
      !(yield* exactV2BundleAtSource(
        store,
        canonicalJson,
        bundle.sourceIdentity,
        allowedEnvironmentNames,
      ))
    )
      return yield* Effect.fail(
        failure("SandboxAuthorityV2SourceVerificationFailed"),
      );
    if (input.qualificationProbe?.atStage !== undefined)
      yield* input.qualificationProbe.atStage(
        "AfterV2SourceDurableBeforeHighWater",
      );

    const v2HighWater: SandboxAuthorityHighWaterV2 = {
      version: 2,
      sourceIdentity: bundle.sourceIdentity,
      bundleRevision: bundle.bundleRevision,
      bundleDigest: decoded.bundleDigest,
      issuerConfigRevision: bundle.issuerConfigRevision,
      issuerConfigDigest: bundle.issuerConfigDigest,
      operatorConfigRevision: bundle.operatorConfigRevision,
      operatorConfigDigest: bundle.operatorConfigDigest,
      providerRegistryRevision: bundle.providerRegistryRevision,
      providerRegistryDigest: bundle.providerRegistryDigest,
    };
    const v2HighWaterCanonicalJson =
      encodeSandboxAuthorityHighWaterV2(v2HighWater);
    if (
      decodeCanonicalSandboxAuthorityHighWaterV2(v2HighWaterCanonicalJson) ===
      undefined
    )
      return yield* Effect.fail(
        failure("SandboxAuthorityV2PairVerificationFailed"),
      );
    const highWaterCommitted = yield* Effect.match(
      store.commitSandboxAuthorityHighWater(v2HighWaterCanonicalJson),
      {
        onFailure: () => false,
        onSuccess: Boolean,
      },
    );
    if (!highWaterCommitted)
      return yield* Effect.fail(
        failure("SandboxAuthorityV2HighWaterCommitFailed"),
      );
    if (input.qualificationProbe?.atStage !== undefined)
      yield* input.qualificationProbe.atStage("AfterV2HighWaterDurable");

    const activeHighWater = yield* Effect.match(
      store.readSandboxAuthorityHighWater(),
      {
        onFailure: () => undefined,
        onSuccess: (value) => value,
      },
    );
    if (
      activeHighWater !== v2HighWaterCanonicalJson ||
      !(yield* exactV2BundleAtSource(
        store,
        canonicalJson,
        bundle.sourceIdentity,
        allowedEnvironmentNames,
      ))
    )
      return yield* Effect.fail(
        failure("SandboxAuthorityV2PairVerificationFailed"),
      );
    return {
      sourceIdentity: bundle.sourceIdentity,
      preservedV1BundleEvidenceId: bundleEvidenceId,
      preservedV1HighWaterEvidenceId: highWaterEvidenceId,
      v2Bundle: bundle,
      v2BundleDigest: decoded.bundleDigest,
      v2BundleCanonicalJson: canonicalJson,
      v2HighWater,
      v2HighWaterCanonicalJson,
    } satisfies SandboxAuthorityProvisioningResultV1;
  });

/** Explicit command facade; callers must supply both the offline mode switch
 * and the dedicated provisioning store port. Nothing in daemon composition
 * imports or constructs this function. */
export const runSandboxAuthorityProvisioningCli = (input: {
  readonly offlineV1ToV2: boolean;
  readonly operatorConfig: unknown;
  readonly allowedEnvironmentNames?: ReadonlyArray<string>;
}) =>
  input.offlineV1ToV2
    ? provisionSandboxAuthorityV1ToV2(input)
    : Effect.fail(failure("SandboxAuthorityV2OperatorConfigInvalid"));
