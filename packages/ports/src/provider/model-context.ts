import type { AgentBinding, ContextEpochNumber, SessionId, WorkspaceId } from "@arbor/domain";
import { Context, type Effect } from "effect";
import type { ModelCapabilityError, SkillRegistryError } from "../errors.js";
import type { SideEffectSemantics } from "../tool.js";
import type { PortableRequestCompatibility } from "./portable-request.js";

export interface ModelCapability {
  readonly modelRef: string;
  readonly family: string;
  /** Composition-selected provider adapter identity for audit manifests. */
  readonly providerRef?: string;
  readonly contextWindow: number;
  readonly outputCeiling: number;
  readonly toolProtocol: string;
  /** SCRC-001: provider/model request surface. Absent means legacy
   * Message-only Inference compatibility. */
  readonly portableRequestCompatibility?: PortableRequestCompatibility;
  /** Full deployment/model/protocol identity used by provider-native opaque
   * continuation/compaction. Introduced as metadata here; SCRC-007 enforces
   * native checkpoint reuse. */
  readonly bindingFingerprint?: string;
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

/** Data-only, model-facing schema projected from Agent Runtime's control
 * registry. Model Context may compile it but never interprets the action. */
export interface ModelFacingControlToolDefinition {
  /** Stable Runtime identity. It is used for registration, authorization,
   * manifests and replay; it is never sent to the model as a function name. */
  readonly stableId: string;
  /** Model-facing function name for newly compiled turns. */
  readonly name: string;
  readonly description: string;
  readonly schemaJson: string;
  readonly version: string;
  readonly hash: string;
  readonly requiredCapability: string;
  /** Historical model names retained solely to replay a manifest created
   * before a model-facing rename. They are never advertised to a new turn. */
  readonly legacyNames?: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
    readonly hash: string;
  }>;
}

/** Data-only control-tool catalog projected into Model Context by the app
 * composition root. Its definitions are model-facing data, not handlers. */
export interface ControlToolCatalogPortService {
  readonly visibleDefinitions: () => Effect.Effect<
    ReadonlyArray<ModelFacingControlToolDefinition>
  >;
}

export class ControlToolCatalogPort extends Context.Service<
  ControlToolCatalogPort,
  ControlToolCatalogPortService
>()("arbor/ControlToolCatalogPort") {}

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
