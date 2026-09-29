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
 * evidence. SHA-256 (per the frozen contract) over canonical JSON (sorted
 * keys), implemented in pure TypeScript so `ports` stays environment-neutral
 * — no node:crypto import, no host hash dependency.
 */
export const resolvedModelBindingFingerprint = (
  binding: ResolvedModelBinding,
): string => `p16fp_${sha256Hex(resolvedModelBindingCanonicalJson(binding))}`;

/** Canonical (sorted-key, stable-stringified) identity JSON of a binding —
 * exported so audits and tests can recompute the fingerprint independently
 * and compare against a reference SHA-256 implementation. */
export const resolvedModelBindingCanonicalJson = (
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
  return canonicalJson(canonical);
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

// ---------------------------------------------------------------------------
// Pure TypeScript SHA-256 (FIPS 180-4). Synchronous, dependency-free, and
// environment-neutral: the same digest on Node, browsers, and workers.
// ---------------------------------------------------------------------------

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

const rotr = (value: number, bits: number): number =>
  (value >>> bits) | (value << (32 - bits));

export const sha256Hex = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLength >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      w[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const a15 = w[index - 15] ?? 0;
      const a2 = w[index - 2] ?? 0;
      const a16 = w[index - 16] ?? 0;
      const a7 = w[index - 7] ?? 0;
      const s0 = rotr(a15, 7) ^ rotr(a15, 18) ^ (a15 >>> 3);
      const s1 = rotr(a2, 17) ^ rotr(a2, 19) ^ (a2 >>> 10);
      w[index] = (a16 + s0 + a7 + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 =
        (h + s1 + ch + (SHA256_K[index] ?? 0) + (w[index] ?? 0)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
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
