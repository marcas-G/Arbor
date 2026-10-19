import { createHash } from "node:crypto";
import type {
  SandboxAuthorityAuditRecordV1,
  SandboxAuthorityBundleSnapshotV1,
  SandboxAuthorityBundleV1,
  SandboxAuthorityHighWaterV1,
  SandboxAuthorityLoadErrorV1,
  SandboxPolicyGrantIssuerConfigSnapshotV1,
  SandboxProviderQualificationEntryV1,
  SandboxProviderQualificationRegistryV1,
} from "@arbor/domain";
import { decodeSandboxPolicyGrantIssuerConfigV1 } from "@arbor/domain";
import {
  Clock,
  type TrustedHostConfigurationSourceService,
} from "@arbor/ports";
import { Context, Effect, Layer } from "effect";

const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");
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

export type SandboxAuthoritySnapshotLoadResult =
  | {
      readonly _tag: "Available";
      readonly snapshot: SandboxAuthorityBundleSnapshotV1;
    }
  | {
      readonly _tag: "Unavailable";
      readonly failure: SandboxAuthorityLoadErrorV1;
    };

export class SandboxAuthoritySnapshot extends Context.Service<
  SandboxAuthoritySnapshot,
  SandboxAuthoritySnapshotLoadResult
>()("arbor/SandboxAuthoritySnapshot") {}

const auditRecord = (
  now: string,
  outcome: SandboxAuthorityAuditRecordV1["outcome"],
  detail: SandboxAuthorityLoadErrorV1 | null,
  loaded?: ReturnType<typeof decodeBundle>,
): SandboxAuthorityAuditRecordV1 => ({
  version: 1,
  outcome,
  detail,
  sourceIdentity: loaded?.bundle.sourceIdentity ?? null,
  bundleRevision: loaded?.bundle.bundleRevision ?? null,
  bundleDigest: loaded?.bundleDigest ?? null,
  issuerConfigRevision: loaded?.bundle.issuerConfigRevision ?? null,
  issuerConfigDigest: loaded?.bundle.issuerConfigDigest ?? null,
  providerRegistryRevision: loaded?.bundle.providerRegistryRevision ?? null,
  providerRegistryDigest: loaded?.bundle.providerRegistryDigest ?? null,
  occurredAt: now,
});

const recordAudit = (
  source: TrustedHostConfigurationSourceService | undefined,
  record: SandboxAuthorityAuditRecordV1,
): Effect.Effect<boolean> =>
  source === undefined
    ? Effect.succeed(false)
    : Effect.map(
        Effect.match(
          source.appendSandboxAuthorityAudit(JSON.stringify(record)),
          {
            onFailure: () => false,
            onSuccess: (ok) => ok,
          },
        ),
        Boolean,
      );

export const loadSandboxAuthorityBundleSnapshot = (
  source: TrustedHostConfigurationSourceService | undefined,
  now: string,
): Effect.Effect<SandboxAuthoritySnapshotLoadResult> =>
  Effect.gen(function* () {
    const reject = (
      failure: SandboxAuthorityLoadErrorV1,
      loaded?: ReturnType<typeof decodeBundle>,
    ) =>
      Effect.gen(function* () {
        yield* recordAudit(
          source,
          auditRecord(now, "Rejected", failure, loaded),
        );
        return { _tag: "Unavailable" as const, failure };
      });
    if (source === undefined) return yield* reject("SourceMissing");
    if (
      !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u.test(
        now,
      )
    ) {
      return yield* reject("CanonicalEncodingInvalid");
    }
    const rawBundle = yield* Effect.match(
      source.readVerifiedSandboxAuthorityBundle(),
      {
        onFailure: (failure) => ({ _tag: "Error" as const, failure }),
        onSuccess: (verified) => ({
          _tag: "Value" as const,
          verifiedSourceIdentity: verified?.sourceIdentity,
          canonicalJson: verified?.canonicalJson,
        }),
      },
    );
    if (rawBundle._tag === "Error") return yield* reject(rawBundle.failure);
    if (rawBundle.canonicalJson === undefined)
      return yield* reject("SourceMissing");
    if (!canonicalId(rawBundle.verifiedSourceIdentity))
      return yield* reject("SourceIdentityInvalid");
    const loaded = decodeBundle(rawBundle.canonicalJson);
    if (loaded === undefined) return yield* reject("BundleMalformed");
    if (loaded.bundle.sourceIdentity !== rawBundle.verifiedSourceIdentity)
      return yield* reject("SourceIdentityInvalid", loaded);
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
      return yield* reject(rawHighWater.failure, loaded);
    if (rawHighWater.canonicalJson === undefined)
      return yield* reject("HighWaterMissing", loaded);
    const highWater = decodeHighWater(rawHighWater.canonicalJson);
    if (highWater === undefined)
      return yield* reject("HighWaterCorrupt", loaded);
    const bundle = loaded.bundle;
    if (highWater.sourceIdentity !== bundle.sourceIdentity)
      return yield* reject("SourceReenrollmentRequired", loaded);
    if (
      bundle.bundleRevision < highWater.bundleRevision ||
      bundle.issuerConfigRevision < highWater.issuerConfigRevision ||
      bundle.providerRegistryRevision < highWater.providerRegistryRevision
    )
      return yield* reject("RevisionRollback", loaded);
    if (
      (bundle.bundleRevision === highWater.bundleRevision &&
        loaded.bundleDigest !== highWater.bundleDigest) ||
      (bundle.issuerConfigRevision === highWater.issuerConfigRevision &&
        bundle.issuerConfigDigest !== highWater.issuerConfigDigest) ||
      (bundle.providerRegistryRevision === highWater.providerRegistryRevision &&
        bundle.providerRegistryDigest !== highWater.providerRegistryDigest)
    )
      return yield* reject("RevisionReuseMismatch", loaded);
    const advanced =
      loaded.bundleDigest !== highWater.bundleDigest ||
      bundle.issuerConfigDigest !== highWater.issuerConfigDigest ||
      bundle.providerRegistryDigest !== highWater.providerRegistryDigest ||
      bundle.bundleRevision !== highWater.bundleRevision ||
      bundle.issuerConfigRevision !== highWater.issuerConfigRevision ||
      bundle.providerRegistryRevision !== highWater.providerRegistryRevision;
    if (advanced) {
      if (bundle.bundleRevision <= highWater.bundleRevision)
        return yield* reject("RevisionReuseMismatch", loaded);
      const next: SandboxAuthorityHighWaterV1 = {
        version: 1,
        sourceIdentity: bundle.sourceIdentity,
        bundleRevision: bundle.bundleRevision,
        bundleDigest: loaded.bundleDigest,
        issuerConfigRevision: bundle.issuerConfigRevision,
        issuerConfigDigest: bundle.issuerConfigDigest,
        providerRegistryRevision: bundle.providerRegistryRevision,
        providerRegistryDigest: bundle.providerRegistryDigest,
      };
      const committed = yield* Effect.match(
        source.commitSandboxAuthorityHighWater(highWaterJson(next)),
        { onFailure: () => false, onSuccess: (success) => success },
      );
      if (!committed) return yield* reject("HighWaterCommitFailed", loaded);
    }
    const snapshot: SandboxAuthorityBundleSnapshotV1 = Object.freeze({
      bundle: Object.freeze(bundle),
      bundleDigest: loaded.bundleDigest,
      canonicalJson: rawBundle.canonicalJson,
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
    const auditStored = yield* recordAudit(
      source,
      auditRecord(now, advanced ? "HighWaterAdvanced" : "Loaded", null, loaded),
    );
    if (!auditStored)
      return { _tag: "Unavailable", failure: "SourceUnreadable" };
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
      return yield* loadSandboxAuthorityBundleSnapshot(source, now);
    }),
  );

export const sandboxIssuerSnapshotOf = (
  result: SandboxAuthoritySnapshotLoadResult,
): SandboxPolicyGrantIssuerConfigSnapshotV1 | undefined =>
  result._tag === "Available"
    ? result.snapshot.issuerConfigSnapshot
    : undefined;
