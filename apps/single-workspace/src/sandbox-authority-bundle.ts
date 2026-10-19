import { createHash } from "node:crypto";
import type {
  SandboxAuthorityAuditRecordV2,
  SandboxAuthorityBundleSnapshotV1,
  SandboxAuthorityBundleSnapshotV2,
  SandboxAuthorityBundleV1,
  SandboxAuthorityBundleV2,
  SandboxAuthorityHighWaterV1,
  SandboxAuthorityLoadErrorV1,
  SandboxPolicyGrantIssuerConfigSnapshotV1,
  SandboxProviderQualificationEntryV1,
  SandboxProviderQualificationRegistryV1,
} from "@arbor/domain";
import {
  decodeCanonicalSandboxAuthorityBundleV2,
  decodeCanonicalSandboxAuthorityHighWaterV2,
  decodeSandboxPolicyGrantIssuerConfigV1,
  encodeSandboxAuthorityAuditRecordV2,
} from "@arbor/domain";
import {
  Clock,
  SANDBOX_ENV_ALLOWLIST,
  type TrustedHostConfigurationSourceService,
} from "@arbor/ports";
import { Context, Effect, Layer } from "effect";

const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");
const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};
const isDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const isRevision = (value: unknown, positive = false): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= (positive ? 1 : 0);
const exactKeys = (
  value: Record<string, unknown>,
  keys: ReadonlyArray<string>,
) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const canonicalId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 128 &&
  value === value.trim() &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);

const utf8Compare = (left: string, right: string): number => {
  const a = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const b = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
};

const issuerConfigJson = (config: {
  readonly version: 1;
  readonly revision: number;
  readonly issuers: ReadonlyArray<string>;
}): string =>
  `{"version":1,"revision":${config.revision},"issuers":${JSON.stringify(config.issuers)}}`;

const decodeRegistry = (
  value: unknown,
): SandboxProviderQualificationRegistryV1 | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const registry = value as Record<string, unknown>;
  if (
    !exactKeys(registry, ["version", "revision", "entries"]) ||
    registry.version !== 1 ||
    !isRevision(registry.revision, true) ||
    !Array.isArray(registry.entries)
  )
    return undefined;
  const entries: SandboxProviderQualificationEntryV1[] = [];
  let priorTuple: ReadonlyArray<string | number> | undefined;
  for (const rawEntry of registry.entries) {
    if (
      typeof rawEntry !== "object" ||
      rawEntry === null ||
      Array.isArray(rawEntry)
    )
      return undefined;
    const entry = rawEntry as Record<string, unknown>;
    if (
      !exactKeys(entry, [
        "providerId",
        "providerVersion",
        "capabilityRevision",
        "osFamily",
        "osBuild",
        "tuple",
        "status",
        "qualificationEvidenceRef",
      ])
    )
      return undefined;
    if (
      !canonicalId(entry.providerId) ||
      !canonicalId(entry.providerVersion) ||
      !isRevision(entry.capabilityRevision, true) ||
      !["Linux", "macOS", "Windows"].includes(String(entry.osFamily)) ||
      !canonicalId(entry.osBuild) ||
      !["Experimental", "Unavailable", "Supported"].includes(
        String(entry.status),
      )
    )
      return undefined;
    const tupleRaw = entry.tuple;
    if (
      typeof tupleRaw !== "object" ||
      tupleRaw === null ||
      Array.isArray(tupleRaw)
    )
      return undefined;
    const tuple = tupleRaw as Record<string, unknown>;
    if (
      !exactKeys(tuple, [
        "profile",
        "networkMode",
        "networkPolicyCodecVersion",
        "enforcementRuleSetDigest",
      ]) ||
      !["ReadOnly", "WorkspaceWrite"].includes(String(tuple.profile)) ||
      !["Disabled", "Restricted", "Enabled"].includes(
        String(tuple.networkMode),
      ) ||
      tuple.networkPolicyCodecVersion !== 1 ||
      !isDigest(tuple.enforcementRuleSetDigest)
    )
      return undefined;
    const evidence = entry.qualificationEvidenceRef;
    if (
      evidence !== null &&
      (typeof evidence !== "string" ||
        !/^blob:sha256:[0-9a-f]{64}$/u.test(evidence))
    )
      return undefined;
    if (entry.status === "Supported" && evidence === null) return undefined;
    const normalized: SandboxProviderQualificationEntryV1 = {
      providerId: entry.providerId,
      providerVersion: entry.providerVersion,
      capabilityRevision: entry.capabilityRevision,
      osFamily:
        entry.osFamily as SandboxProviderQualificationEntryV1["osFamily"],
      osBuild: entry.osBuild,
      tuple: {
        profile:
          tuple.profile as SandboxProviderQualificationEntryV1["tuple"]["profile"],
        networkMode:
          tuple.networkMode as SandboxProviderQualificationEntryV1["tuple"]["networkMode"],
        networkPolicyCodecVersion: 1,
        enforcementRuleSetDigest: tuple.enforcementRuleSetDigest,
      },
      status: entry.status as SandboxProviderQualificationEntryV1["status"],
      qualificationEvidenceRef: evidence as string | null,
    };
    const currentTuple = [
      normalized.providerId,
      normalized.providerVersion,
      normalized.capabilityRevision,
      normalized.osFamily,
      normalized.osBuild,
      normalized.tuple.profile,
      normalized.tuple.networkMode,
      normalized.tuple.networkPolicyCodecVersion,
      normalized.tuple.enforcementRuleSetDigest,
    ] as const;
    if (priorTuple !== undefined) {
      let ordering = 0;
      for (let index = 0; index < currentTuple.length; index += 1) {
        const previous = priorTuple[index];
        const current = currentTuple[index];
        ordering =
          typeof previous === "number" && typeof current === "number"
            ? previous - current
            : utf8Compare(String(previous), String(current));
        if (ordering !== 0) break;
      }
      if (ordering <= 0) return undefined;
    }
    priorTuple = currentTuple;
    entries.push(normalized);
  }
  return { version: 1, revision: registry.revision, entries };
};

const registryJson = (
  registry: SandboxProviderQualificationRegistryV1,
): string =>
  `{"version":1,"revision":${registry.revision},"entries":[${registry.entries
    .map(
      (entry) =>
        `{"providerId":${JSON.stringify(entry.providerId)},"providerVersion":${JSON.stringify(entry.providerVersion)},"capabilityRevision":${entry.capabilityRevision},"osFamily":${JSON.stringify(entry.osFamily)},"osBuild":${JSON.stringify(entry.osBuild)},"tuple":{"profile":${JSON.stringify(entry.tuple.profile)},"networkMode":${JSON.stringify(entry.tuple.networkMode)},"networkPolicyCodecVersion":1,"enforcementRuleSetDigest":${JSON.stringify(entry.tuple.enforcementRuleSetDigest)}},"status":${JSON.stringify(entry.status)},"qualificationEvidenceRef":${JSON.stringify(entry.qualificationEvidenceRef)}}`,
    )
    .join(",")}]}`;

const decodeBundle = (
  json: string,
):
  | {
      readonly bundle: SandboxAuthorityBundleV1;
      readonly bundleDigest: string;
    }
  | undefined => {
  try {
    const raw: unknown = JSON.parse(json);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return undefined;
    const value = raw as Record<string, unknown>;
    if (
      !exactKeys(value, [
        "version",
        "sourceIdentity",
        "bundleRevision",
        "issuerConfigRevision",
        "issuerConfigDigest",
        "issuerConfig",
        "providerRegistryRevision",
        "providerRegistryDigest",
        "providerRegistry",
      ]) ||
      value.version !== 1 ||
      !canonicalId(value.sourceIdentity) ||
      !isRevision(value.bundleRevision, true) ||
      !isRevision(value.issuerConfigRevision, true) ||
      !isRevision(value.providerRegistryRevision, true) ||
      !isDigest(value.issuerConfigDigest) ||
      !isDigest(value.providerRegistryDigest)
    )
      return undefined;
    const issuerConfig = decodeSandboxPolicyGrantIssuerConfigV1(
      value.issuerConfig,
    );
    const providerRegistry = decodeRegistry(value.providerRegistry);
    if (
      issuerConfig === undefined ||
      providerRegistry === undefined ||
      issuerConfig.revision !== value.issuerConfigRevision ||
      providerRegistry.revision !== value.providerRegistryRevision
    )
      return undefined;
    const issuerJson = issuerConfigJson(issuerConfig);
    const registryCanonicalJson = registryJson(providerRegistry);
    if (
      digest(issuerJson) !== value.issuerConfigDigest ||
      digest(registryCanonicalJson) !== value.providerRegistryDigest
    )
      return undefined;
    const bundle: SandboxAuthorityBundleV1 = {
      version: 1,
      sourceIdentity: value.sourceIdentity,
      bundleRevision: value.bundleRevision,
      issuerConfigRevision: value.issuerConfigRevision,
      issuerConfigDigest: value.issuerConfigDigest,
      issuerConfig,
      providerRegistryRevision: value.providerRegistryRevision,
      providerRegistryDigest: value.providerRegistryDigest,
      providerRegistry,
    };
    const canonicalJson = `{"version":1,"sourceIdentity":${JSON.stringify(bundle.sourceIdentity)},"bundleRevision":${bundle.bundleRevision},"issuerConfigRevision":${bundle.issuerConfigRevision},"issuerConfigDigest":${JSON.stringify(bundle.issuerConfigDigest)},"issuerConfig":${issuerJson},"providerRegistryRevision":${bundle.providerRegistryRevision},"providerRegistryDigest":${JSON.stringify(bundle.providerRegistryDigest)},"providerRegistry":${registryCanonicalJson}}`;
    if (canonicalJson !== json) return undefined;
    return { bundle, bundleDigest: digest(canonicalJson) };
  } catch {
    return undefined;
  }
};

const highWaterJson = (value: SandboxAuthorityHighWaterV1): string =>
  `{"version":1,"sourceIdentity":${JSON.stringify(value.sourceIdentity)},"bundleRevision":${value.bundleRevision},"bundleDigest":${JSON.stringify(value.bundleDigest)},"issuerConfigRevision":${value.issuerConfigRevision},"issuerConfigDigest":${JSON.stringify(value.issuerConfigDigest)},"providerRegistryRevision":${value.providerRegistryRevision},"providerRegistryDigest":${JSON.stringify(value.providerRegistryDigest)}}`;

const decodeHighWater = (
  json: string,
): SandboxAuthorityHighWaterV1 | undefined => {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return undefined;
    const row = value as Record<string, unknown>;
    if (
      !exactKeys(row, [
        "version",
        "sourceIdentity",
        "bundleRevision",
        "bundleDigest",
        "issuerConfigRevision",
        "issuerConfigDigest",
        "providerRegistryRevision",
        "providerRegistryDigest",
      ]) ||
      row.version !== 1 ||
      !canonicalId(row.sourceIdentity) ||
      !isRevision(row.bundleRevision, true) ||
      !isRevision(row.issuerConfigRevision, true) ||
      !isRevision(row.providerRegistryRevision, true) ||
      !isDigest(row.bundleDigest) ||
      !isDigest(row.issuerConfigDigest) ||
      !isDigest(row.providerRegistryDigest)
    )
      return undefined;
    const decoded = row as unknown as SandboxAuthorityHighWaterV1;
    return highWaterJson(decoded) === json ? decoded : undefined;
  } catch {
    return undefined;
  }
};

export type SandboxAuthoritySnapshotV1ForensicLoadResult =
  | {
      readonly _tag: "Available";
      readonly snapshot: SandboxAuthorityBundleSnapshotV1;
    }
  | {
      readonly _tag: "Unavailable";
      readonly failure: SandboxAuthorityLoadErrorV1;
    };

export type SandboxAuthorityForensicReadPort = Pick<
  TrustedHostConfigurationSourceService,
  "readVerifiedSandboxAuthorityBundle" | "readSandboxAuthorityHighWater"
>;

export class SandboxAuthoritySnapshot extends Context.Service<
  SandboxAuthoritySnapshot,
  SandboxAuthoritySnapshotV2LoadResult
>()("arbor/SandboxAuthoritySnapshot") {}

/** V1 decoder retained solely for immutable forensic inspection/tests. It is
 * not wired to SandboxAuthoritySnapshot or any authorization consumer. The
 * source is deliberately narrowed to a read-only port; this path never audits,
 * advances, or commits high-water state. */
export const loadSandboxAuthorityBundleSnapshotV1Forensic = (
  source: SandboxAuthorityForensicReadPort | undefined,
): Effect.Effect<SandboxAuthoritySnapshotV1ForensicLoadResult> =>
  Effect.gen(function* () {
    const reject = (failure: SandboxAuthorityLoadErrorV1) =>
      Effect.succeed({ _tag: "Unavailable" as const, failure });
    if (source === undefined) return yield* reject("SourceMissing");
    const rawBundle = yield* Effect.match(
      source.readVerifiedSandboxAuthorityBundle(),
      {
        onFailure: (failure) => ({ _tag: "Error" as const, failure }),
        onSuccess: (verified) => ({ _tag: "Value" as const, verified }),
      },
    );
    if (rawBundle._tag === "Error") return yield* reject(rawBundle.failure);
    if (rawBundle.verified === undefined) return yield* reject("SourceMissing");
    if (!canonicalId(rawBundle.verified.sourceIdentity))
      return yield* reject("SourceIdentityInvalid");
    const loaded = decodeBundle(rawBundle.verified.canonicalJson);
    if (loaded === undefined) return yield* reject("BundleMalformed");
    if (loaded.bundle.sourceIdentity !== rawBundle.verified.sourceIdentity)
      return yield* reject("SourceIdentityInvalid");
    const rawHighWater = yield* Effect.match(
      source.readSandboxAuthorityHighWater(),
      {
        onFailure: (failure) => ({ _tag: "Error" as const, failure }),
        onSuccess: (canonicalJson) => ({
          _tag: "Value" as const,
          canonicalJson,
        }),
      },
    );
    if (rawHighWater._tag === "Error")
      return yield* reject(rawHighWater.failure);
    if (rawHighWater.canonicalJson === undefined)
      return yield* reject("HighWaterMissing");
    const highWater = decodeHighWater(rawHighWater.canonicalJson);
    if (highWater === undefined) return yield* reject("HighWaterCorrupt");
    const bundle = loaded.bundle;
    if (highWater.sourceIdentity !== bundle.sourceIdentity)
      return yield* reject("SourceReenrollmentRequired");
    if (
      bundle.bundleRevision < highWater.bundleRevision ||
      bundle.issuerConfigRevision < highWater.issuerConfigRevision ||
      bundle.providerRegistryRevision < highWater.providerRegistryRevision
    )
      return yield* reject("RevisionRollback");
    if (
      (bundle.bundleRevision === highWater.bundleRevision &&
        loaded.bundleDigest !== highWater.bundleDigest) ||
      (bundle.issuerConfigRevision === highWater.issuerConfigRevision &&
        bundle.issuerConfigDigest !== highWater.issuerConfigDigest) ||
      (bundle.providerRegistryRevision === highWater.providerRegistryRevision &&
        bundle.providerRegistryDigest !== highWater.providerRegistryDigest)
    )
      return yield* reject("RevisionReuseMismatch");
    if (
      bundle.bundleRevision > highWater.bundleRevision ||
      bundle.issuerConfigRevision > highWater.issuerConfigRevision ||
      bundle.providerRegistryRevision > highWater.providerRegistryRevision
    )
      return yield* reject("HighWaterCommitFailed");
    const snapshot: SandboxAuthorityBundleSnapshotV1 = Object.freeze({
      bundle: Object.freeze(bundle),
      bundleDigest: loaded.bundleDigest,
      canonicalJson: rawBundle.verified.canonicalJson,
      issuerConfigSnapshot: Object.freeze({
        config: Object.freeze({
          ...bundle.issuerConfig,
          issuers: Object.freeze([...bundle.issuerConfig.issuers]),
        }),
        configDigest: bundle.issuerConfigDigest,
        authorityBundleRevision: bundle.bundleRevision,
        authorityBundleDigest: loaded.bundleDigest,
        providerRegistryRevision: bundle.providerRegistryRevision,
        providerRegistryDigest: bundle.providerRegistryDigest,
        providerRegistry: Object.freeze(bundle.providerRegistry),
      }),
    });
    return { _tag: "Available", snapshot };
  });

export const SandboxAuthoritySnapshotLive = (
  source: TrustedHostConfigurationSourceService | undefined,
): Layer.Layer<SandboxAuthoritySnapshot, never, Clock> =>
  Layer.effect(
    SandboxAuthoritySnapshot,
    Effect.gen(function* () {
      const clock = yield* Clock;
      const now = yield* clock.now();
      return yield* loadSandboxAuthorityBundleSnapshotV2(
        source,
        now,
        SANDBOX_ENV_ALLOWLIST,
      );
    }),
  );

export const sandboxIssuerSnapshotOf = (
  result: SandboxAuthoritySnapshotV2LoadResult,
): SandboxPolicyGrantIssuerConfigSnapshotV1 | undefined =>
  result._tag === "Available"
    ? {
        config: result.snapshot.bundle.issuerConfig,
        configDigest: result.snapshot.bundle.issuerConfigDigest,
        authorityBundleRevision: result.snapshot.bundle.bundleRevision,
        authorityBundleDigest: result.snapshot.bundleDigest,
        providerRegistryRevision:
          result.snapshot.bundle.providerRegistryRevision,
        providerRegistryDigest: result.snapshot.bundle.providerRegistryDigest,
        providerRegistry: result.snapshot.bundle.providerRegistry,
      }
    : undefined;

export type SandboxAuthoritySnapshotV2LoadResult =
  | {
      readonly _tag: "Available";
      readonly snapshot: SandboxAuthorityBundleSnapshotV2;
    }
  | {
      readonly _tag: "Unavailable";
      readonly failure: SandboxAuthorityLoadErrorV1;
    };

export class SandboxAuthoritySnapshotV2 extends Context.Service<
  SandboxAuthoritySnapshotV2,
  SandboxAuthoritySnapshotV2LoadResult
>()("arbor/SandboxAuthoritySnapshotV2") {}

const auditRecordV2 = (
  now: string,
  outcome: SandboxAuthorityAuditRecordV2["outcome"],
  detail: SandboxAuthorityLoadErrorV1 | null,
  bundle?: SandboxAuthorityBundleV2,
  bundleDigest?: string,
): SandboxAuthorityAuditRecordV2 => ({
  version: 2,
  outcome,
  detail,
  sourceIdentity: bundle?.sourceIdentity ?? null,
  bundleRevision: bundle?.bundleRevision ?? null,
  bundleDigest: bundleDigest ?? null,
  issuerConfigRevision: bundle?.issuerConfigRevision ?? null,
  issuerConfigDigest: bundle?.issuerConfigDigest ?? null,
  operatorConfigRevision: bundle?.operatorConfigRevision ?? null,
  operatorConfigDigest: bundle?.operatorConfigDigest ?? null,
  providerRegistryRevision: bundle?.providerRegistryRevision ?? null,
  providerRegistryDigest: bundle?.providerRegistryDigest ?? null,
  occurredAt: now,
});

/** Loads only the currently active V2 authority pair. This is intentionally
 * read-only: V1→V2 provisioning/preservation is an offline operation. A V1
 * high-water, a source-ahead pair, or any non-exact tuple is unavailable and
 * can never cause a fallback to the V1 authority loader. */
export const loadSandboxAuthorityBundleSnapshotV2 = (
  source: TrustedHostConfigurationSourceService | undefined,
  now: string,
  allowedEnvironmentNames: ReadonlyArray<string>,
): Effect.Effect<SandboxAuthoritySnapshotV2LoadResult> =>
  Effect.gen(function* () {
    const record = (
      outcome: SandboxAuthorityAuditRecordV2["outcome"],
      detail: SandboxAuthorityLoadErrorV1 | null,
      bundle?: SandboxAuthorityBundleV2,
      bundleDigest?: string,
    ) =>
      source === undefined
        ? Effect.succeed(false)
        : Effect.map(
            Effect.match(
              source.appendSandboxAuthorityAudit(
                encodeSandboxAuthorityAuditRecordV2(
                  auditRecordV2(now, outcome, detail, bundle, bundleDigest),
                ),
              ),
              {
                onFailure: () => false,
                onSuccess: (stored) => stored,
              },
            ),
            Boolean,
          );
    const reject = (
      failure: SandboxAuthorityLoadErrorV1,
      bundle?: SandboxAuthorityBundleV2,
      bundleDigest?: string,
    ) =>
      Effect.gen(function* () {
        yield* record("Rejected", failure, bundle, bundleDigest);
        return { _tag: "Unavailable" as const, failure };
      });
    if (source === undefined) return yield* reject("SourceMissing");
    if (
      !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u.test(
        now,
      ) ||
      !Number.isFinite(Date.parse(now)) ||
      new Date(Date.parse(now)).toISOString() !== now
    )
      return yield* reject("CanonicalEncodingInvalid");
    const rawSource = yield* Effect.match(
      source.readVerifiedSandboxAuthorityBundle(),
      {
        onFailure: (failure) => ({ _tag: "Error" as const, failure }),
        onSuccess: (verified) => ({ _tag: "Value" as const, verified }),
      },
    );
    if (rawSource._tag === "Error") return yield* reject(rawSource.failure);
    if (rawSource.verified === undefined) return yield* reject("SourceMissing");
    const decoded = decodeCanonicalSandboxAuthorityBundleV2(
      rawSource.verified.canonicalJson,
      allowedEnvironmentNames,
      digest,
    );
    if (decoded === undefined) return yield* reject("BundleMalformed");
    const { bundle, bundleDigest } = decoded;
    if (
      !canonicalId(rawSource.verified.sourceIdentity) ||
      rawSource.verified.sourceIdentity !== bundle.sourceIdentity
    )
      return yield* reject("SourceIdentityInvalid", bundle, bundleDigest);
    const rawHighWater = yield* Effect.match(
      source.readSandboxAuthorityHighWater(),
      {
        onFailure: (failure) => ({ _tag: "Error" as const, failure }),
        onSuccess: (canonicalJson) => ({
          _tag: "Value" as const,
          canonicalJson,
        }),
      },
    );
    if (rawHighWater._tag === "Error")
      return yield* reject(rawHighWater.failure, bundle, bundleDigest);
    if (rawHighWater.canonicalJson === undefined)
      return yield* reject("HighWaterMissing", bundle, bundleDigest);
    const highWater = decodeCanonicalSandboxAuthorityHighWaterV2(
      rawHighWater.canonicalJson,
    );
    if (highWater === undefined)
      return yield* reject("HighWaterCorrupt", bundle, bundleDigest);
    if (highWater.sourceIdentity !== bundle.sourceIdentity)
      return yield* reject("SourceReenrollmentRequired", bundle, bundleDigest);
    const mismatch = (
      bundleRevision: number,
      highWaterRevision: number,
      bundleValue: string,
      highWaterValue: string,
    ): SandboxAuthorityLoadErrorV1 | undefined => {
      if (bundleRevision < highWaterRevision) return "RevisionRollback";
      if (
        bundleRevision === highWaterRevision &&
        bundleValue !== highWaterValue
      )
        return "RevisionReuseMismatch";
      if (bundleRevision > highWaterRevision) return "HighWaterCommitFailed";
      return undefined;
    };
    const mismatchFailure =
      mismatch(
        bundle.bundleRevision,
        highWater.bundleRevision,
        bundleDigest,
        highWater.bundleDigest,
      ) ??
      mismatch(
        bundle.issuerConfigRevision,
        highWater.issuerConfigRevision,
        bundle.issuerConfigDigest,
        highWater.issuerConfigDigest,
      ) ??
      mismatch(
        bundle.operatorConfigRevision,
        highWater.operatorConfigRevision,
        bundle.operatorConfigDigest,
        highWater.operatorConfigDigest,
      ) ??
      mismatch(
        bundle.providerRegistryRevision,
        highWater.providerRegistryRevision,
        bundle.providerRegistryDigest,
        highWater.providerRegistryDigest,
      );
    if (
      mismatchFailure !== undefined ||
      highWater.bundleDigest !== bundleDigest ||
      highWater.issuerConfigDigest !== bundle.issuerConfigDigest ||
      highWater.operatorConfigDigest !== bundle.operatorConfigDigest ||
      highWater.providerRegistryDigest !== bundle.providerRegistryDigest
    )
      return yield* reject(
        mismatchFailure ?? "RevisionReuseMismatch",
        bundle,
        bundleDigest,
      );
    const snapshot: SandboxAuthorityBundleSnapshotV2 = Object.freeze({
      bundle: deepFreeze(bundle),
      bundleDigest,
      canonicalJson: decoded.canonicalJson,
    });
    const audited = yield* record("Loaded", null, bundle, bundleDigest);
    if (!audited)
      return { _tag: "Unavailable" as const, failure: "SourceUnreadable" };
    return { _tag: "Available" as const, snapshot };
  });

export const SandboxAuthoritySnapshotV2Live = (
  source: TrustedHostConfigurationSourceService | undefined,
  allowedEnvironmentNames: ReadonlyArray<string>,
): Layer.Layer<SandboxAuthoritySnapshotV2, never, Clock> =>
  Layer.effect(
    SandboxAuthoritySnapshotV2,
    Effect.gen(function* () {
      const clock = yield* Clock;
      const now = yield* clock.now();
      return yield* loadSandboxAuthorityBundleSnapshotV2(
        source,
        now,
        allowedEnvironmentNames,
      );
    }),
  );
