import type {
  AgentBinding,
  ContextEpochNumber,
  ExecutionId,
  ProviderTurnId,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";

export type { ContextEpochNumber, ExecutionId, ProviderTurnId, SessionId };

import { Context, type Effect, type Stream } from "effect";
import type {
  ModelCapabilityError,
  ProviderFailure,
  SkillRegistryError,
} from "./errors.js";
import type { TransactionScope } from "./session.js";

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
  readonly secretRef: string;
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

export interface ToolCatalogPortService {
  readonly definitions: () => Effect.Effect<ReadonlyArray<ToolDefinitionRef>>;
}

export class ToolCatalogPort extends Context.Service<
  ToolCatalogPort,
  ToolCatalogPortService
>()("arbor/ToolCatalogPort") {}

export interface SecretStorePortService {
  readonly resolve: (secretRef: string) => Effect.Effect<string>;
}

export class SecretStorePort extends Context.Service<
  SecretStorePort,
  SecretStorePortService
>()("arbor/SecretStorePort") {}
