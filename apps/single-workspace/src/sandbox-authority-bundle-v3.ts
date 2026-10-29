import { createHash } from "node:crypto";
import {
  decodeCanonicalSandboxAuthorityBundleV3,
  decodeCanonicalSandboxAuthorityHighWaterV3,
  decodeCanonicalWindowsNativeOperatorTrustSetV1,
  type SandboxAuthorityBundleSnapshotV3,
  type SandboxAuthorityLoadErrorV1,
} from "@arbor/domain";
import type { TrustedHostConfigurationSourceService } from "@arbor/ports";
import { Effect } from "effect";

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const sha256Bytes = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const canonicalTime = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;
const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

export type SandboxAuthoritySnapshotV3LoadResult =
  | {
      readonly _tag: "Available";
      readonly snapshot: SandboxAuthorityBundleSnapshotV3;
    }
  | {
      readonly _tag: "Unavailable";
      readonly failure: SandboxAuthorityLoadErrorV1;
    };

/** Current V3 load never accepts a V2 high-water and never writes either
 * protected record. The source port owns ACL/reparse checks. */
export const loadSandboxAuthorityBundleSnapshotV3 = (
  source: TrustedHostConfigurationSourceService | undefined,
  now: string,
  allowedEnvironmentNames: ReadonlyArray<string>,
  initialSource?: {
    readonly sourceIdentity: string;
    readonly canonicalJson: string;
  },
): Effect.Effect<SandboxAuthoritySnapshotV3LoadResult> =>
  Effect.gen(function* () {
    const audit = (
      failure: SandboxAuthorityLoadErrorV1 | null,
      snapshot?: SandboxAuthorityBundleSnapshotV3,
    ) =>
      source === undefined
        ? Effect.succeed(false)
        : Effect.match(
            source.appendSandboxAuthorityAudit(
              JSON.stringify({
                version: 3,
                outcome: failure === null ? "Loaded" : "Rejected",
                detail: failure,
                sourceIdentity: snapshot?.bundle.sourceIdentity ?? null,
                bundleRevision: snapshot?.bundle.bundleRevision ?? null,
                bundleDigest: snapshot?.bundleDigest ?? null,
                windowsOperatorTrustSetRevision:
                  snapshot?.bundle.windowsOperatorTrustSetRevision ?? null,
                windowsOperatorTrustSetDigest:
                  snapshot?.bundle.windowsOperatorTrustSetDigest ?? null,
                occurredAt: now,
              }),
            ),
            { onFailure: () => false, onSuccess: Boolean },
          );
    const reject = (failure: SandboxAuthorityLoadErrorV1) =>
      Effect.gen(function* () {
        yield* audit(failure);
        return { _tag: "Unavailable" as const, failure };
      });
    if (source === undefined) return yield* reject("SourceMissing");
    if (!canonicalTime(now)) return yield* reject("TrustCurrentnessMismatch");
    const readSource = () =>
      Effect.match(source.readVerifiedSandboxAuthorityBundle(), {
        onFailure: () => undefined,
        onSuccess: (value) => value,
      });
    const rawSource = initialSource ?? (yield* readSource());
    if (rawSource === undefined) return yield* reject("SourceUnreadable");
    const decoded = decodeCanonicalSandboxAuthorityBundleV3(
      rawSource.canonicalJson,
      allowedEnvironmentNames,
      sha256,
      sha256Bytes,
    );
    if (decoded === undefined) {
      // Classify only the accepted V3 trust child; every branch remains
      // unavailable and exposes no raw key, path or decoder exception.
      try {
        const parsed: unknown = JSON.parse(rawSource.canonicalJson);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          const row = parsed as Record<string, unknown>;
          const trustJson = JSON.stringify(row.windowsOperatorTrustSet);
          const trust = decodeCanonicalWindowsNativeOperatorTrustSetV1(
            trustJson,
            sha256Bytes,
          );
          if (trust === undefined) return yield* reject("TrustSetMalformed");
          if (sha256(trustJson) !== row.windowsOperatorTrustSetDigest)
            return yield* reject("TrustSetDigestMismatch");
        }
      } catch {
        // The closed V3 bundle decoder remains the authority, not this
        // best-effort sanitized failure classifier.
      }
      return yield* reject("BundleMalformed");
    }
    const { bundle, bundleDigest } = decoded;
    if (rawSource.sourceIdentity !== bundle.sourceIdentity)
      return yield* reject("SourceIdentityInvalid");
    const highWaterRead = yield* Effect.match(
      source.readSandboxAuthorityHighWater(),
      { onFailure: () => undefined, onSuccess: (value) => value },
    );
    if (highWaterRead === undefined) return yield* reject("HighWaterMissing");
    const highWater = decodeCanonicalSandboxAuthorityHighWaterV3(highWaterRead);
    if (highWater === undefined) return yield* reject("HighWaterCorrupt");
    if (highWater.sourceIdentity !== bundle.sourceIdentity)
      return yield* reject("SourceReenrollmentRequired");
    const pairs = [
      [
        bundle.bundleRevision,
        bundleDigest,
        highWater.bundleRevision,
        highWater.bundleDigest,
      ],
      [
        bundle.issuerConfigRevision,
        bundle.issuerConfigDigest,
        highWater.issuerConfigRevision,
        highWater.issuerConfigDigest,
      ],
      [
        bundle.operatorConfigRevision,
        bundle.operatorConfigDigest,
        highWater.operatorConfigRevision,
        highWater.operatorConfigDigest,
      ],
      [
        bundle.providerRegistryRevision,
        bundle.providerRegistryDigest,
        highWater.providerRegistryRevision,
        highWater.providerRegistryDigest,
      ],
      [
        bundle.windowsOperatorTrustSetRevision,
        bundle.windowsOperatorTrustSetDigest,
        highWater.windowsOperatorTrustSetRevision,
        highWater.windowsOperatorTrustSetDigest,
      ],
    ] as const;
    for (const [
      currentRevision,
      currentDigest,
      durableRevision,
      durableDigest,
    ] of pairs) {
      if (currentRevision < durableRevision)
        return yield* reject("RevisionRollback");
      if (currentRevision > durableRevision)
        return yield* reject("HighWaterCommitFailed");
      if (currentDigest !== durableDigest)
        return yield* reject("RevisionReuseMismatch");
    }
    // A changed source/high-water during the load is not a current snapshot.
    const finalSource = yield* readSource();
    const finalHighWater = yield* Effect.match(
      source.readSandboxAuthorityHighWater(),
      { onFailure: () => undefined, onSuccess: (value) => value },
    );
    if (
      finalSource?.sourceIdentity !== rawSource.sourceIdentity ||
      finalSource.canonicalJson !== rawSource.canonicalJson ||
      finalHighWater !== highWaterRead
    )
      return yield* reject("TrustCurrentnessMismatch");
    const snapshot: SandboxAuthorityBundleSnapshotV3 = Object.freeze({
      bundle: deepFreeze(bundle),
      bundleDigest,
      canonicalJson: decoded.canonicalJson,
    });
    if (!(yield* audit(null, snapshot)))
      return {
        _tag: "Unavailable" as const,
        failure: "SourceUnreadable" as const,
      };
    return { _tag: "Available" as const, snapshot };
  });
