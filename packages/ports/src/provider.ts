import type {
  AgentBinding,
  ContextEpochNumber,
  ExecutionId,
  ProjectId,
  ProviderTurnId,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";

export type {
  ContextEpochNumber,
  ExecutionId,
  ProjectId,
  ProviderTurnId,
  SessionId,
};

import { Context, type Effect, type Stream } from "effect";
import type {
  ModelCapabilityError,
  ProviderFailure,
  SkillRegistryError,
} from "./errors.js";
import type {
  TransactionOperationalFailure,
  TransactionScope,
} from "./session.js";
import type { SideEffectSemantics } from "./tool.js";

export interface PortableInstruction {
  readonly slotId: string;
  readonly authorityRole: string;
  readonly text: string;
}

export interface PortableMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly text: string;
}

export interface PortableToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly schemaJson: string;
}

export interface CacheHint {
  readonly cacheClass: "Stable" | "SemiStable" | "TurnDynamic";
}

export interface PortableModelRequest {
  readonly modelRef: string;
  readonly instructions: ReadonlyArray<PortableInstruction>;
  readonly messages: ReadonlyArray<PortableMessage>;
  readonly toolDefinitions: ReadonlyArray<PortableToolDefinition>;
  readonly outputContractRef: string;
  readonly budget: { readonly maxOutputTokens: number };
  readonly cacheHints: ReadonlyArray<CacheHint>;
}

export interface ProviderExecutionContext {
  readonly providerTurnId: ProviderTurnId;
  readonly attemptNo: number;
  readonly secretRef?: SecretRef;
  /** Resolved credential (P12 `03` §1/§3): produced by ProviderRuntime at the
   * execution boundary and consumed by the transport adapter. Never persisted,
   * never logged, redacted by default under serialization. */
  readonly secretMaterial?: SecretMaterial;
  readonly timeoutMs: number;
  readonly cancellationRef: string;
}

export type ProviderFinishReason =
  | "Stop"
  | "MaxOutputTokens"
  | "ToolCall"
  | "ContentFilter";

export type ProviderFailureKind =
  | "RateLimited"
  | "ProviderUnavailable"
  | "AuthenticationFailed"
  | "RequestRejected"
  | "StreamInterrupted"
  | "ProtocolViolation";

/** TR-4 (P12 `12` §5): `ProviderFailureKind` is a CLOSED union. It is
 * exhaustively consumed (retry-disposition mapping, P3 `06` §2), so
 * add/remove/rename is a MAJOR SPI change (`PluginSdkApiVersion`). An adapter
 * that observes a provider-specific class with no frozen tag normalizes it to
 * `ProtocolViolation` (terminal) at the adapter boundary. */
export const PROVIDER_FAILURE_KINDS = [
  "RateLimited",
  "ProviderUnavailable",
  "AuthenticationFailed",
  "RequestRejected",
  "StreamInterrupted",
  "ProtocolViolation",
] as const;

/** Exhaustive by construction: a new `ProviderFailureKind` member fails
 * compilation until its disposition is declared (closed-union enforcement). */
const PROVIDER_FAILURE_DISPOSITION: Record<
  ProviderFailureKind,
  "retryable" | "terminal"
> = {
  RateLimited: "retryable",
  ProviderUnavailable: "retryable",
  AuthenticationFailed: "terminal",
  RequestRejected: "terminal",
  StreamInterrupted: "retryable",
  ProtocolViolation: "terminal",
};

export const providerFailureDisposition = (
  kind: ProviderFailureKind,
): "retryable" | "terminal" => PROVIDER_FAILURE_DISPOSITION[kind];

export type CanonicalProviderEvent =
  | {
      readonly _tag: "TurnStarted";
      readonly providerTurnId: ProviderTurnId;
      readonly attemptNo: number;
      readonly modelRef: string;
    }
  | { readonly _tag: "TextDelta"; readonly text: string }
  | { readonly _tag: "ReasoningDelta"; readonly text: string }
  | {
      readonly _tag: "ToolCallProposed";
      readonly callRef: string;
      readonly toolName: string;
      readonly argumentsJson: string;
    }
  | {
      readonly _tag: "UsageReported";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
    }
  | { readonly _tag: "ContinuationState"; readonly stateRef: string }
  | {
      readonly _tag: "TurnCompleted";
      readonly finishReason: ProviderFinishReason;
    }
  | { readonly _tag: "TurnFailed"; readonly failureKind: ProviderFailureKind };

export interface ProviderPortService {
  readonly runTurn: (input: {
    readonly request: PortableModelRequest;
    readonly context: ProviderExecutionContext;
  }) => Stream.Stream<CanonicalProviderEvent, ProviderFailure>;
}

export class ProviderPort extends Context.Service<
  ProviderPort,
  ProviderPortService
>()("arbor/ProviderPort") {}

export interface ProviderRunInput {
  readonly providerTurnId: ProviderTurnId;
  readonly executionId: ExecutionId;
  readonly sessionId: SessionId;
  readonly contextEpoch: ContextEpochNumber;
  readonly modelRef: string;
  readonly outputContractRef: string;
  readonly manifestId: string;
  readonly request: PortableModelRequest;
  readonly secretRef?: SecretRef;
  readonly timeoutMs: number;
  readonly cancellationRef: string;
}

/** P12 `08` §7 D1 (B-4): the successful result of one logical `ProviderTurn`.
 * `attemptNo` is the Turn-local ordinal of the transport attempt that produced
 * `events` (0 = first attempt). Provider retry never creates a new
 * `ProviderTurn` (DID §6A.9), so this ordinal is the only channel through
 * which the caller observes real provider retries. */
export interface ProviderRunResult {
  readonly events: ReadonlyArray<CanonicalProviderEvent>;
  readonly attemptNo: number;
}

export interface ProviderRuntimeService {
  readonly runTurn: (
    input: ProviderRunInput,
  ) => Effect.Effect<
    ProviderRunResult,
    ProviderFailure | TransactionOperationalFailure | SecretStoreError
  >;
}

export class ProviderRuntime extends Context.Service<
  ProviderRuntime,
  ProviderRuntimeService
>()("arbor/ProviderRuntime") {}

export interface ProviderTurnRecord {
  readonly providerTurnId: ProviderTurnId;
  readonly executionId: ExecutionId;
  readonly sessionId: SessionId;
  readonly contextEpoch: ContextEpochNumber;
  readonly modelRef: string;
  readonly outputContractRef: string;
  readonly manifestId: string;
}

export interface ProviderAttemptOutcome {
  readonly _tag: "Success" | "RetryableFailure" | "TerminalFailure";
  readonly providerErrorKind?: string;
}

/** P9 `04` §2.2 read face: a dangling ProviderTurn (`settled_at IS NULL`)
 * plus its append-only attempt history, for the unsettled-Turn recovery
 * decision table. */
export interface ProviderAttemptSummary {
  readonly attemptNo: number;
  readonly outcome: "Success" | "RetryableFailure" | "TerminalFailure";
  readonly providerErrorKind: string | null;
}

export interface UnsettledProviderTurn {
  readonly turn: ProviderTurnRecord;
  readonly attempts: ReadonlyArray<ProviderAttemptSummary>;
}

export interface ProviderTurnStoreService {
  readonly startTurn: (
    record: ProviderTurnRecord,
    startedAt: string,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  readonly recordAttempt: (
    providerTurnId: ProviderTurnId,
    attemptNo: number,
    outcome: ProviderAttemptOutcome,
    startedAt: string,
    settledAt: string,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  readonly settleTurn: (
    providerTurnId: ProviderTurnId,
    finishReason: string,
    usageJson: string,
    settledAt: string,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  /** P9 `04` §2.2: enumerate dangling turns of a project (Turn intent +
   * Manifest persisted before the request, so every dangling Turn is
   * visible) together with their recorded attempts. */
  readonly findUnsettledByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<UnsettledProviderTurn>,
    ProviderFailure,
    TransactionScope
  >;
  /** P9 `04` §2.2 case 2: mark a dangling Turn settled failed (driver
   * Turn-failure semantics, P3 `06` §2) when the retry bound is exhausted
   * or the failure class is terminal. No-op if already settled. */
  readonly failTurn: (
    providerTurnId: ProviderTurnId,
    settledAt: string,
  ) => Effect.Effect<void, ProviderFailure, TransactionScope>;
  /** P10-007 read-only extension (observe-only, invariant 45): settled
   * provider turns with their usage_json and executing workspace — the
   * Usage aggregation source. Never feeds budget or any mutation. */
  readonly listUsageByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<ProviderTurnUsageRow>,
    ProviderFailure,
    TransactionScope
  >;
}

/** P10-007: one settled-or-unsettled provider_turns usage fact, workspace
 * attributed (usage_json raw; parsing belongs to the projection). */
export interface ProviderTurnUsageRow {
  readonly workspaceId: import("@arbor/domain").WorkspaceId;
  readonly usageJson: string | null;
  readonly settledAt: string | null;
}

export class ProviderTurnStore extends Context.Service<
  ProviderTurnStore,
  ProviderTurnStoreService
>()("arbor/ProviderTurnStore") {}

export interface ModelCapability {
  readonly modelRef: string;
  readonly family: string;
  readonly contextWindow: number;
  readonly outputCeiling: number;
  readonly toolProtocol: string;
  /** P12 `12` §5 (TR-4, additive/MINOR): optional capability tags used by the
   * deterministic model-catalog selection. Absent = no declared tags. */
  readonly capabilities?: ReadonlyArray<string>;
  /** P12 `12` §3/§5: usage cost provenance only, never authority. */
  readonly priceSheetVersion?: string;
}

export interface ModelCapabilityPortService {
  readonly resolve: (input: {
    readonly binding: AgentBinding;
    readonly cognitiveMode: string;
    readonly requiredCapabilities: ReadonlyArray<string>;
  }) => Effect.Effect<ModelCapability, ModelCapabilityError>;
}

export class ModelCapabilityPort extends Context.Service<
  ModelCapabilityPort,
  ModelCapabilityPortService
>()("arbor/ModelCapabilityPort") {}

export interface InformationTrustMetadata {
  readonly provenanceKind:
    | "CanonicalInternal"
    | "AuthenticatedHuman"
    | "AuthenticatedAgent"
    | "ToolObservation"
    | "ExternalRetrieved"
    | "ImportedArtifact"
    | "ModelDerived";
  readonly instructionCapability:
    | "CanonicalInstruction"
    | "InstructionCandidate"
    | "DataOnly";
  readonly epistemicStatus:
    | "Established"
    | "Supported"
    | "Unverified"
    | "Conflicting"
    | "Derived";
}

export interface SkillRef {
  readonly skillId: string;
  readonly revision: number;
  readonly hash: string;
  readonly provenance: InformationTrustMetadata;
  readonly disclosureTier: "Summary" | "Body";
}

export interface LoadedSkill {
  readonly skillRef: SkillRef;
  readonly content: string;
}

export interface SkillRegistryService {
  readonly available: (
    binding: AgentBinding,
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<SkillRef>, SkillRegistryError>;
  readonly load: (
    skillId: string,
    tier: "Summary" | "Body",
  ) => Effect.Effect<LoadedSkill, SkillRegistryError>;
}

export class SkillRegistry extends Context.Service<
  SkillRegistry,
  SkillRegistryService
>()("arbor/SkillRegistry") {}

/** DID §7.7 port catalog (ModelContext package, §10.4.1): the declared
 * session-entry source surface. Frozen catalog surface — reserved for the
 * ModelContext context-assembly boundary; no production Layer provisions it
 * yet, so it is retained as a declared (not silently deleted) port. */
export interface AgentContextSourcePortService {
  readonly sessionEntryRefs: (
    sessionId: SessionId,
    epoch: ContextEpochNumber,
  ) => Effect.Effect<ReadonlyArray<string>>;
}

export class AgentContextSourcePort extends Context.Service<
  AgentContextSourcePort,
  AgentContextSourcePortService
>()("arbor/AgentContextSourcePort") {}

/** DID §7.7 port catalog (ModelContext package, §10.4.1): the declared
 * knowledge-retrieval surface. Frozen catalog surface — reserved for the
 * ModelContext context-assembly boundary; no production Layer provisions it
 * yet, so it is retained as a declared (not silently deleted) port. */
export interface KnowledgeQueryPortService {
  readonly retrieve: (input: {
    readonly query: string;
    readonly workspaceId: WorkspaceId;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<{ readonly ref: string; readonly text: string }>
  >;
}

export class KnowledgeQueryPort extends Context.Service<
  KnowledgeQueryPort,
  KnowledgeQueryPortService
>()("arbor/KnowledgeQueryPort") {}

export interface ToolDefinitionRef {
  readonly name: string;
  readonly version: string;
  readonly hash: string;
}

/** P12 `07` §2 (DID v1.14 G3, §7.6): the model-facing projection of a
 * `ToolDefinition` resolved by Model Context through `ToolCatalogPort`.
 * `schemaJson := ToolDefinition.inputSchemaJson`; `capabilityMetadata` and
 * `sideEffectSemantics` are model-facing metadata (DID §7.6) and are
 * projected. Only `resultSchemaJson` and `source` are not model-facing. */
export interface ModelFacingToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly schemaJson: string;
  readonly version: string;
  readonly hash: string;
  readonly capabilityMetadata: ReadonlyArray<string>;
  readonly sideEffectSemantics: SideEffectSemantics;
}

/** P12 `07` §2: `resolveForModel` never fabricates a placeholder; an
 * unregistered ref fails with this typed error and is absent from
 * `visibleRefs`. */
export type ToolCatalogError = {
  readonly _tag: "ToolNotRegistered";
  readonly ref: ToolDefinitionRef;
};

export interface ToolCatalogPortService {
  /** Refs eligible for model-facing exposure (catalogued, not turn-filtered).
   * Renamed inherited `definitions()` surface; retains the inherited `Effect`
   * channel (P12 `07` §2, TR-11). */
  readonly visibleRefs: () => Effect.Effect<ReadonlyArray<ToolDefinitionRef>>;
  /** Model-facing projection for exactly one visible ref; an unregistered ref
   * fails with typed `ToolNotRegistered` (never a placeholder). */
  readonly resolveForModel: (
    ref: ToolDefinitionRef,
  ) => Effect.Effect<ModelFacingToolDefinition, ToolCatalogError>;
}

export class ToolCatalogPort extends Context.Service<
  ToolCatalogPort,
  ToolCatalogPortService
>()("arbor/ToolCatalogPort") {}

declare const SecretRefBrand: unique symbol;

/** Opaque secret reference (P12 `03` §1; P3 `01` §9 / P3 `00` F1): the only
 * secret-related value allowed in Project Policy, Agent bindings, or
 * EnvironmentRef. It is a reference, never material. */
export type SecretRef = string & { readonly [SecretRefBrand]: "SecretRef" };

export const secretRef = (value: string): SecretRef => value as SecretRef;

/** Opaque resolved credential (P12 `03` §1): produced only at the execution
 * boundary and consumed immediately. It is not a string; the raw value is
 * reachable only through `reveal()` and is redacted by default under
 * `JSON.stringify` / `String()` so it can never leak through serialization. */
export class SecretMaterial {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static of(value: string): SecretMaterial {
    return new SecretMaterial(value);
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "[REDACTED]";
  }
}

/** Typed secret failures (P12 `03` §2): missing / inaccessible / expired must
 * never be silently substituted. */
export type SecretStoreError =
  | { readonly _tag: "SecretNotFound"; readonly secretRef: SecretRef }
  | {
      readonly _tag: "SecretInaccessible";
      readonly secretRef: SecretRef;
      readonly reason: string;
    }
  | { readonly _tag: "SecretExpired"; readonly secretRef: SecretRef };

export interface SecretStorePortService {
  readonly resolve: (
    secretRef: SecretRef,
  ) => Effect.Effect<SecretMaterial, SecretStoreError>;
}

export class SecretStorePort extends Context.Service<
  SecretStorePort,
  SecretStorePortService
>()("arbor/SecretStorePort") {}
