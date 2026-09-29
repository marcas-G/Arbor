import type { Layer } from "effect";
import type {
  ModelCapability,
  ProviderExecutionPolicyOverrides,
  ProviderPort,
  ProviderRuntimeExecutionPolicy,
  SecretRef,
} from "./provider.js";
import {
  DEFAULT_PROVIDER_EXECUTION_POLICY,
  resolveProviderExecutionPolicy,
} from "./provider-policy.js";

/**
 * P16 `01` Provider Extension Architecture — frozen contracts
 * (Gate A FROZEN; Gate B implementation authorized 2026-09-29 with the two
 * acceptance clarifications merged into `02`).
 *
 * Six concepts formalize existing shapes; nothing here supersedes P3 `01`,
 * P12 `12`, or DID §6A.8/§6A.9/§7.5. Profiles/deployments/registries are
 * pure data (INV-P16-7); the only function field is ProtocolAdapter.layerFor.
 */

export type ProtocolAdapterId = string;
/** Frozen legacy values; new families register additional `provider-<family>` ids. */
export type ProviderProtocolFamily =
  | "openai-chat-completions-sse"
  | "in-process-deterministic"
  | (string & {});

export interface ProviderProfile {
  readonly protocolFamily: ProviderProtocolFamily;
  readonly authMode:
    | { readonly _tag: "BearerSecret" }
    | { readonly _tag: "None" };
  readonly capabilityFlags: {
    /** Declares cache-token reporting. P16: declarative only — extraction is
     * out of scope (scope guard 3); stock adapters declare false. */
    readonly reportsCacheTokens: boolean;
    /** Declares ContinuationState/checkpoint production. P16: declarative
     * only; stock adapters declare false. */
    readonly supportsContinuation: boolean;
    /** Streams TextDelta (conformance A1 applies when true). */
    readonly streamsDeltas: boolean;
  };
  readonly failureTaxonomy: "phase1-v2";
}

export interface AdapterDeploymentBinding {
  /** Base URL; omitted by network-free (in-process deterministic) families. */
  readonly endpoint?: string;
  /** Wire model name override (e.g. modelRef "model-openai" -> "deepseek-chat"). */
  readonly wireModelName?: string;
  /** Credential reference; raw secrets resolve only at the execution boundary
   * (INV-P16-8, P12 `03` no-leak). */
  readonly secretRef?: SecretRef;
  readonly extraHeaders?: ReadonlyArray<Record<string, string>>;
  /** Conformance-test injection point; absent in production. */
  readonly transportOverride?: unknown;
}

export interface ProtocolAdapter {
  readonly adapterId: ProtocolAdapterId;
  /** Protocol behavior declaration (P16 `01` §3); registry enforces uniqueness. */
  readonly profile: ProviderProfile;
  /** Composition-Root-only Layer factory. Same adapter may serve multiple
   * deployments (different endpoints/credentials) with identical behavior
   * semantics (guaranteed by the conformance suite). */
  readonly layerFor: (
    binding: AdapterDeploymentBinding,
  ) => Layer.Layer<ProviderPort>;
}

export interface ModelProfile {
  readonly modelRef: string;
  readonly adapterId: ProtocolAdapterId;
  readonly capability: ModelCapability;
  /** Usage cost only (P12 `04`); never authority. */
  readonly priceSheetVersion?: string;
  /** Optional declared deployment ids (qualification evidence lookup). */
  readonly knownDeployments?: ReadonlyArray<string>;
}

export interface ModelCatalog {
  readonly entries: ReadonlyArray<ModelProfile>;
  readonly defaultModelRef: string;
}

export interface ModelDeployment {
  /** Stable identity bound to qualification evidence. `dep-<family>-<site>`. */
  readonly deploymentId: string;
  readonly modelRef: string;
  readonly endpoint?: string;
  readonly wireModelName?: string;
  readonly secretRef?: SecretRef;
  readonly executionPolicyOverrides?: ProviderExecutionPolicyOverrides;
  readonly extraHeaders?: ReadonlyArray<Record<string, string>>;
}

export interface ResolvedModelBinding {
  readonly deployment: ModelDeployment;
  readonly adapter: ProtocolAdapter;
  readonly capability: ModelCapability;
  /** Final policy: defaults ⊕ deployment overrides. */
  readonly executionPolicy: ProviderRuntimeExecutionPolicy;
}

export type ResolveModelBindingError =
  | { readonly _tag: "UnknownModelRef"; readonly modelRef: string }
  | { readonly _tag: "UnknownAdapter"; readonly adapterId: string }
  | {
      readonly _tag: "DeploymentIncomplete";
      readonly deploymentId: string;
      readonly missing: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "AdapterModelMismatch";
      readonly modelRef: string;
      readonly adapterId: string;
      readonly catalogAdapterId: string;
    };

export interface ProviderRegistry {
  /** Static closed list; constructed at the Composition Root. */
  readonly adapters: ReadonlyArray<ProtocolAdapter>;
  readonly find: (adapterId: ProtocolAdapterId) => ProtocolAdapter | undefined;
}

/** Duplicate adapterId throws at construction (fail-fast). */
export const makeProviderRegistry = (
  adapters: ReadonlyArray<ProtocolAdapter>,
): ProviderRegistry => {
  const seen = new Set<string>();
  for (const adapter of adapters) {
    if (seen.has(adapter.adapterId)) {
      throw new Error(
        `provider registry: duplicate adapterId "${adapter.adapterId}"`,
      );
    }
    seen.add(adapter.adapterId);
  }
  return {
    adapters,
    find: (adapterId) =>
      adapters.find((adapter) => adapter.adapterId === adapterId),
  };
};

/**
 * Deterministic deployment resolution (P16 `01` §5). Any failure is the typed
 * `ResolveModelBindingError` — never a silent fallback (SD §6.2, INV-P16-4).
 */
export const resolveModelBinding = (
  registry: ProviderRegistry,
  catalog: ModelCatalog,
  deployment: ModelDeployment,
): ResolvedModelBinding | ResolveModelBindingError => {
  const entry = catalog.entries.find(
    (candidate) => candidate.modelRef === deployment.modelRef,
  );
  if (entry === undefined) {
    return { _tag: "UnknownModelRef", modelRef: deployment.modelRef };
  }
  const adapter = registry.find(entry.adapterId);
  if (adapter === undefined) {
    return { _tag: "UnknownAdapter", adapterId: entry.adapterId };
  }
  if (adapter.adapterId !== entry.adapterId) {
    return {
      _tag: "AdapterModelMismatch",
      modelRef: deployment.modelRef,
      adapterId: adapter.adapterId,
      catalogAdapterId: entry.adapterId,
    };
  }
  const missing: string[] = [];
  if (
    adapter.profile.protocolFamily !== "in-process-deterministic" &&
    (deployment.endpoint === undefined || deployment.endpoint.length === 0)
  ) {
    missing.push("endpoint");
  }
  if (
    adapter.profile.authMode._tag === "BearerSecret" &&
    deployment.secretRef === undefined
  ) {
    missing.push("secretRef");
  }
  if (missing.length > 0) {
    return {
      _tag: "DeploymentIncomplete",
      deploymentId: deployment.deploymentId,
      missing,
    };
  }
  const executionPolicy = resolveProviderExecutionPolicy({
    systemDefault: DEFAULT_PROVIDER_EXECUTION_POLICY,
    ...(deployment.executionPolicyOverrides === undefined
      ? {}
      : { modelDeploymentOverride: deployment.executionPolicyOverrides }),
  });
  return {
    deployment,
    adapter,
    capability: { ...entry.capability, providerRef: entry.adapterId },
    executionPolicy,
  };
};

/**
 * Deterministic fingerprint of a ResolvedModelBinding's stable identity
 * fields (P16 `01` §7, Gate B acceptance clarification 2). Any identity or
 * capability change changes the fingerprint and invalidates qualification
 * evidence. SHA-256 over canonical JSON (sorted keys).
 */
export const resolvedModelBindingFingerprint = (
  binding: ResolvedModelBinding,
): string => {
  const canonical = {
    adapterId: binding.adapter.adapterId,
    authMode: binding.adapter.profile.authMode._tag,
    capability: {
      contextWindow: binding.capability.contextWindow,
      outputCeiling: binding.capability.outputCeiling,
      toolProtocol: binding.capability.toolProtocol,
      capabilities: binding.capability.capabilities ?? [],
    },
    deploymentId: binding.deployment.deploymentId,
    endpoint: binding.deployment.endpoint ?? "",
    executionPolicy: {
      connectTimeoutMs: binding.executionPolicy.connectTimeoutMs,
      firstEventTimeoutMs: binding.executionPolicy.firstEventTimeoutMs,
      maxAttempts: binding.executionPolicy.maxAttempts,
      retryBackoffMs: binding.executionPolicy.retryBackoffMs,
      streamIdleTimeoutMs: binding.executionPolicy.streamIdleTimeoutMs,
      turnTimeoutMs: binding.executionPolicy.turnTimeoutMs,
    },
    failureTaxonomy: binding.adapter.profile.failureTaxonomy,
    modelRef: binding.deployment.modelRef,
    protocolFamily: binding.adapter.profile.protocolFamily,
    wireModelName:
      binding.deployment.wireModelName ?? binding.deployment.modelRef,
  };
  const json = canonicalJson(canonical);
  // FNV-1a 64-bit, same hash family as compiledRequestHash provenance
  // (model-context) — deterministic over a small structured domain. (01 §7
  // notes SHA-256; implementation note recorded in the Gate B report: ports
  // stays environment-neutral, no node:crypto import.)
  return fnv1a64Hex(json);
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
};

const fnv1a64Hex = (text: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `p16fp_${hash.toString(16).padStart(16, "0")}`;
};

export interface CapabilityQualification {
  readonly deploymentId: string;
  readonly adapterId: ProtocolAdapterId;
  readonly modelRef: string;
  /** Gate B acceptance clarification 2: binds the exact ResolvedModelBinding. */
  readonly bindingFingerprint: string;
  /** Full identity/version record — enough to decide whether evidence still
   * applies; any change changes the fingerprint and invalidates it. */
  readonly identity: {
    readonly adapterId: ProtocolAdapterId;
    readonly adapterVersion?: string;
    readonly providerSite: string;
    readonly wireModelName: string;
    readonly modelRevision?: string;
    readonly serverBuildId?: string;
    readonly parserProfile?: string;
    readonly protocolFamily: ProviderProtocolFamily;
    readonly failureTaxonomy: string;
  };
  /** Declared capability snapshot at qualification time (comparison only,
   * never written back — INV-P16-10). */
  readonly declaredCapability: ModelCapability;
  /** Capability actually observed by the evidence. */
  readonly qualifiedCapability: ModelCapability;
  readonly evidenceDir: string;
  readonly stableRuns: number;
  readonly conformanceRun: string;
  readonly qualifiedAt: string;
}
