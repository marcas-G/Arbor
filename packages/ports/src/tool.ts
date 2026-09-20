import type {
  Actor,
  ArtifactId,
  CanonicalResourceRegion,
  ExecutionId,
  Principal,
  ProjectId,
  ResourceAddress,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect, type Option, type Stream } from "effect";
import type {
  ArtifactError,
  ArtifactMetadataError,
  BlobStoreError,
  ResourceAdmissionError,
  SandboxError,
  ToolInvocationStoreError,
  ToolRuntimeError,
} from "./errors.js";
import type { InvocationRef } from "./execution.js";
import type { TransactionScope } from "./session.js";

export type SideEffectSemantics =
  | "ReadOnly"
  | "Idempotent"
  | "Reconcilable"
  | "NonIdempotent";

export interface ToolDefinition {
  readonly name: string;
  readonly version: string;
  readonly hash: string;
  readonly description: string;
  readonly inputSchemaJson: string;
  readonly resultSchemaJson: string;
  readonly capabilityMetadata: ReadonlyArray<string>;
  readonly sideEffectSemantics: SideEffectSemantics;
  readonly source: "Builtin" | "Project";
}

export interface InvocationAuthority {
  readonly principal: Principal;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly resourceSpaceIds: ReadonlyArray<string>;
  readonly allowedCapabilities: ReadonlyArray<string>;
  readonly controlBasisDigest: string;
  readonly expiresAt: string;
  readonly delegationDepth: number;
}

export interface ToolIntent {
  readonly callRef: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly argumentsJson: string;
  readonly invocationId: ToolInvocationId;
  readonly approvalId: string | null;
}

export interface ToolExecutionContext {
  readonly executionId: ExecutionId;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly projectId: ProjectId;
  readonly actor: Actor;
  readonly authenticatedPrincipal: Principal;
  readonly authority: InvocationAuthority;
  readonly controlBasisDigest: string;
  readonly requestedAt: string;
}

export interface BoundedObservation {
  readonly text: string;
  readonly truncated: boolean;
}

export type CanonicalToolObservation =
  | {
      readonly _tag: "Success";
      readonly observation: BoundedObservation;
      readonly resultRef: string | null;
    }
  | {
      readonly _tag: "ExpectedFailure";
      readonly observation: BoundedObservation;
    }
  | { readonly _tag: "Denied"; readonly reason: string }
  | { readonly _tag: "Interrupted" }
  | {
      readonly _tag: "OutcomeUnknown";
      readonly reconciliationRefs: ReadonlyArray<InvocationRef>;
    }
  | { readonly _tag: "RuntimeFailure"; readonly cause: string };

export type ToolInvocationSettlement =
  | { readonly _tag: "Success" }
  | { readonly _tag: "ExpectedFailure" }
  | { readonly _tag: "Interrupted" }
  | {
      readonly _tag: "OutcomeUnknown";
      readonly reconciliationRefs: ReadonlyArray<InvocationRef>;
    }
  | { readonly _tag: "RuntimeFailure"; readonly cause: string };

export interface ToolRuntimePortService {
  readonly invoke: (
    intent: ToolIntent,
    context: ToolExecutionContext,
  ) => Effect.Effect<CanonicalToolObservation, ToolRuntimeError>;
}

export class ToolRuntimePort extends Context.Service<
  ToolRuntimePort,
  ToolRuntimePortService
>()("arbor/ToolRuntimePort") {}

export interface ToolDefinitionStoreService {
  readonly definition: (
    name: string,
    version: string,
  ) => Effect.Effect<Option.Option<ToolDefinition>>;
  readonly all: () => Effect.Effect<ReadonlyArray<ToolDefinition>>;
}

export class ToolDefinitionStore extends Context.Service<
  ToolDefinitionStore,
  ToolDefinitionStoreService
>()("arbor/ToolDefinitionStore") {}

export interface SandboxHandle {
  readonly handleId: string;
  readonly rootPath: string;
  readonly writableRegions: ReadonlyArray<CanonicalResourceRegion>;
}

export interface SandboxPortService {
  readonly open: (input: {
    readonly executionId: ExecutionId;
    readonly workspaceId: WorkspaceId;
    readonly regions: ReadonlyArray<CanonicalResourceRegion>;
  }) => Effect.Effect<SandboxHandle, SandboxError>;
  readonly close: (handle: SandboxHandle) => Effect.Effect<void, SandboxError>;
}

export class SandboxPort extends Context.Service<
  SandboxPort,
  SandboxPortService
>()("arbor/SandboxPort") {}

export type AdmissionResult =
  | { readonly _tag: "Admitted" }
  | { readonly _tag: "Denied"; readonly reason: string };

export interface ResourceAdmissionService {
  readonly admit: (input: {
    readonly workspaceId: WorkspaceId;
    readonly regions: ReadonlyArray<CanonicalResourceRegion>;
    readonly write: boolean;
  }) => Effect.Effect<
    AdmissionResult,
    ResourceAdmissionError,
    TransactionScope
  >;
}

export class ResourceAdmission extends Context.Service<
  ResourceAdmission,
  ResourceAdmissionService
>()("arbor/ResourceAdmission") {}

export interface InvocationApproval {
  readonly approvalId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly actionDigest: string;
  readonly targetResourceSpaceIds: ReadonlyArray<string>;
  readonly controlBasisDigest: string;
  readonly expiresAt: string;
  readonly consumedBy: ToolInvocationId | null;
}

export interface ToolInvocationIntent {
  readonly invocationId: ToolInvocationId;
  readonly executionId: ExecutionId;
  readonly workspaceId: WorkspaceId;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly sideEffectSemantics: SideEffectSemantics;
  readonly argumentsJson: string;
  readonly resolvedRegions: ReadonlyArray<CanonicalResourceRegion>;
  readonly approvalId: string | null;
  readonly intentAt: string;
}

export interface ToolInvocationRecord extends ToolInvocationIntent {
  readonly settledAt: string | null;
  readonly settlement: ToolInvocationSettlement | null;
  readonly resultRef: string | null;
}

export interface ToolInvocationStoreService {
  readonly recordIntent: (
    invocation: ToolInvocationIntent,
  ) => Effect.Effect<void, ToolInvocationStoreError, TransactionScope>;
  readonly settle: (
    invocationId: ToolInvocationId,
    settlement: ToolInvocationSettlement,
    resultRef: string | null,
    settledAt: string,
  ) => Effect.Effect<void, ToolInvocationStoreError, TransactionScope>;
  readonly consumeApproval: (
    approvalId: string,
    invocationId: ToolInvocationId,
  ) => Effect.Effect<boolean, ToolInvocationStoreError, TransactionScope>;
  readonly findApproval: (
    approvalId: string,
  ) => Effect.Effect<
    Option.Option<InvocationApproval>,
    ToolInvocationStoreError,
    TransactionScope
  >;
  readonly findUnsettled: (
    executionId: ExecutionId,
  ) => Effect.Effect<
    ReadonlyArray<ToolInvocationRecord>,
    ToolInvocationStoreError,
    TransactionScope
  >;
}

export class ToolInvocationStore extends Context.Service<
  ToolInvocationStore,
  ToolInvocationStoreService
>()("arbor/ToolInvocationStore") {}

export type BlobRef = string;

export interface BlobStorePortService {
  readonly put: (bytes: Uint8Array) => Effect.Effect<BlobRef, BlobStoreError>;
  readonly get: (ref: BlobRef) => Effect.Effect<Uint8Array, BlobStoreError>;
  readonly stream: (ref: BlobRef) => Stream.Stream<Uint8Array, BlobStoreError>;
}

export class BlobStorePort extends Context.Service<
  BlobStorePort,
  BlobStorePortService
>()("arbor/BlobStorePort") {}

export interface Artifact {
  readonly artifactId: ArtifactId;
  readonly kind: string;
  readonly blobRef: BlobRef;
  readonly byteSize: number;
  readonly contentHash: string;
  readonly invocationId: ToolInvocationId | null;
  readonly executionId: ExecutionId | null;
  readonly createdAt: string;
}

export interface ArtifactMetadataRepositoryService {
  readonly insert: (
    artifact: Artifact,
  ) => Effect.Effect<void, ArtifactMetadataError, TransactionScope>;
  readonly findById: (
    artifactId: ArtifactId,
  ) => Effect.Effect<
    Option.Option<Artifact>,
    ArtifactMetadataError,
    TransactionScope
  >;
}

export class ArtifactMetadataRepository extends Context.Service<
  ArtifactMetadataRepository,
  ArtifactMetadataRepositoryService
>()("arbor/ArtifactMetadataRepository") {}

export interface ArtifactServiceService {
  readonly store: (
    bytes: Uint8Array,
    kind: string,
    producedBy: {
      readonly invocationId?: ToolInvocationId;
      readonly executionId?: ExecutionId;
    },
    createdAt: string,
  ) => Effect.Effect<Artifact, ArtifactError, TransactionScope>;
  readonly load: (
    artifactId: ArtifactId,
  ) => Effect.Effect<
    Option.Option<Uint8Array>,
    ArtifactError,
    TransactionScope
  >;
}

export class ArtifactService extends Context.Service<
  ArtifactService,
  ArtifactServiceService
>()("arbor/ArtifactService") {}

export type { ResourceAddress };
