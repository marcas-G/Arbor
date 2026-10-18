import type {
  Actor,
  ArtifactId,
  CanonicalResourceRegion,
  NoEffectDenialCode as DomainNoEffectDenialCode,
  ExecutionEpisodeBinding,
  ExecutionId,
  LeaseGeneration,
  Principal,
  ProjectId,
  ProviderTurnId,
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
import type {
  SandboxProcessPolicy,
  SandboxProviderUnavailableOutcome,
} from "./sandbox-process.js";
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
  /** Persistence source snapshot used by the fenced pre-effect gate. This is
   * an implementation token, not additional authority. */
  readonly sourceRevision?: string;
}

export const invocationAuthoritySourceRevisionOf = (input: {
  readonly workspacePolicyRevision: number;
  readonly activeGrants: ReadonlyArray<{
    readonly permissionGrantId: string;
    readonly revision: number | null;
  }>;
  readonly verifierId: string | null;
}): string =>
  JSON.stringify({
    workspacePolicyRevision: input.workspacePolicyRevision,
    activeGrants: [...input.activeGrants]
      .sort((left, right) =>
        left.permissionGrantId.localeCompare(right.permissionGrantId),
      )
      .map((grant) => [grant.permissionGrantId, grant.revision]),
    verifierId: input.verifierId,
  });

export interface ToolIntent {
  readonly callRef: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly argumentsJson: string;
  readonly invocationId: ToolInvocationId;
  readonly approvalId: string | null;
}

/** Runtime-owned active ExecutionOrigin lease holder used to fence every
 * worker-originated durable ToolInvocation write. */
export interface ToolExecutionFence {
  readonly executionId: ExecutionId;
  readonly workerId: string;
  readonly workerIncarnationId: string;
  readonly fencingGeneration: LeaseGeneration;
}

/** Trusted source tuple captured from the persisted P3 AgentLoopStep and its
 * exact ProviderTurn/LogicalAction dispatch. P4 must not reconstruct it from
 * model output, Session text, or current Work state. */
export interface RecoveryBindingSourceIdentity {
  readonly executionId: ExecutionId;
  readonly providerTurnId: ProviderTurnId;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly logicalActionId: string;
  readonly actionIndex: number;
  readonly callRef: string;
}

export interface RecoveryBindingPolicyRevisions {
  readonly workspacePolicyRevision: number;
  readonly projectPolicyRevision: number;
}

export interface ToolExecutionContext {
  readonly executionId: ExecutionId;
  readonly executionEpisodeBinding?: ExecutionEpisodeBinding;
  /** Set only by P9 from the exact durable decision; absence fails closed. */
  readonly sandboxProcessPolicy?: SandboxProcessPolicy;
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly projectId: ProjectId;
  readonly actor: Actor;
  readonly authenticatedPrincipal: Principal;
  /** Legacy/test injection only. Production resolves authority after exact
   * resource resolution through ToolAuthorityResolver. */
  readonly authority?: InvocationAuthority;
  readonly controlBasisDigest: string;
  /** Present only for a source-verified P3 ActionCall. RecoveryBindingV1
   * claims fail closed when this tuple is absent or conflicts with the
   * invocation/context identity. */
  readonly recoveryBindingIdentity?: RecoveryBindingSourceIdentity;
  /** Policy revisions from the same P3-prepared ControlBasis whose digest is
   * `controlBasisDigest`; required when P39 V1 binding is enabled. */
  readonly recoveryBindingPolicyRevisions?: RecoveryBindingPolicyRevisions;
  /** Exact P3 source identity for durable replay-failure escalation. */
  readonly providerTurnId?: string;
  readonly logicalActionId?: string;
  readonly delegationDepth?: number;
  /** P2 authoritative Worker holder used only for P4 durable settlement.
   * Production ExecutionOrigin callers always provide the complete triple. */
  readonly executionFence: ToolExecutionFence;
  /** Runtime-sourced Executable approval handoff. Model decoders never
   * populate this field; P3 reconstructs it from the current Step/action. */
  readonly executableApproval?: {
    readonly approvalId: string;
    readonly expectedRevision: number;
    readonly state: import("./executable-approval.js").ExecutableApprovalState;
    readonly binding: import("./executable-approval.js").ExecutableApprovalBinding;
  };
  readonly requestedAt: string;
}

/** A trusted authority resolver may reject a request for policy reasons.
 * P4 projects this as a normal Denied observation; infrastructure failures
 * remain ToolAuthorityResolutionError and are surfaced as operational errors. */
export interface ToolAuthorityDenied {
  readonly _tag: "ToolAuthorityDenied";
}

export interface ToolAuthorityResolutionFailure {
  readonly _tag: "ToolAuthorityResolutionError";
  readonly cause: unknown;
}

export type ToolAuthorityResolutionError =
  | ToolAuthorityDenied
  | ToolAuthorityResolutionFailure;

export interface ToolAuthorityResolverService {
  readonly resolve: (input: {
    readonly intent: ToolIntent;
    readonly definition: ToolDefinition;
    readonly context: ToolExecutionContext;
    readonly regions: ReadonlyArray<CanonicalResourceRegion>;
    readonly now: string;
  }) => Effect.Effect<InvocationAuthority, ToolAuthorityResolutionError>;
}

export class ToolAuthorityResolver extends Context.Service<
  ToolAuthorityResolver,
  ToolAuthorityResolverService
>()("arbor/ToolAuthorityResolver") {}

export interface BoundedObservation {
  readonly text: string;
  readonly truncated: boolean;
}

export type NoEffectDenialCode = DomainNoEffectDenialCode;

export type ToolEffectAdmissionResult =
  | { readonly _tag: "Admitted" }
  | { readonly _tag: "ExecutionStopping" }
  | {
      readonly _tag: "Denied";
      readonly reasonCode: NoEffectDenialCode;
    };

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
  | {
      readonly _tag: "Denied";
      readonly reasonCode: NoEffectDenialCode;
      readonly reason: string;
    }
  | {
      /** Nonterminal P4 handoff. No ToolInvocation row is written. The
       * Application binds P3 identity and persists the approval + Inbox. */
      readonly _tag: "ApprovalRequired";
      readonly authority: InvocationAuthority;
      readonly targetResourceSpaceIds: ReadonlyArray<string>;
      readonly actionDigest: string;
      readonly requestedCapabilities: ReadonlyArray<string>;
      readonly sideEffectSemantics: SideEffectSemantics;
      readonly controlBasisDigest: string;
    }
  | { readonly _tag: "Interrupted" }
  | {
      readonly _tag: "OutcomeUnknown";
      readonly reconciliationRefs: ReadonlyArray<InvocationRef>;
    }
  | { readonly _tag: "RuntimeFailure"; readonly cause: string }
  | SandboxProviderUnavailableOutcome
  | {
      readonly _tag: "ReconciledNoEffect";
      readonly reasonCode:
        | "AuthoritySnapshotChanged"
        | "ResourceSnapshotChanged"
        | "ApprovalNoLongerAuthorized"
        | "StopRequested"
        | "ReplayLimitReached";
      readonly reconciliationFactRef: string;
      readonly observation: BoundedObservation;
      readonly resultRef: string;
    };

export type ToolInvocationSettlement =
  | { readonly _tag: "Success" }
  | { readonly _tag: "ExpectedFailure" }
  | { readonly _tag: "Denied"; readonly reasonCode: NoEffectDenialCode }
  | { readonly _tag: "Interrupted" }
  | {
      readonly _tag: "OutcomeUnknown";
      readonly reconciliationRefs: ReadonlyArray<InvocationRef>;
    }
  | { readonly _tag: "RuntimeFailure"; readonly cause: string }
  | {
      readonly _tag: "ReconciledNoEffect";
      readonly reasonCode:
        | "AuthoritySnapshotChanged"
        | "ResourceSnapshotChanged"
        | "ApprovalNoLongerAuthorized"
        | "StopRequested"
        | "ReplayLimitReached";
      readonly reconciliationFactRef: string;
    };

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

export type SandboxMountAccess = "ReadOnly" | "ReadWrite";

export interface SandboxMountBinding {
  readonly ref: string;
  readonly address: Extract<
    ResourceAddress,
    { readonly _tag: "FileTree" | "GitWorktree" }
  >;
  readonly region: CanonicalResourceRegion;
  readonly access: SandboxMountAccess;
}

export interface SandboxOpenedMount {
  readonly ref: string;
  readonly rootPath: string;
  readonly region: CanonicalResourceRegion;
  readonly access: SandboxMountAccess;
}

export interface SandboxHandle {
  readonly handleId: string;
  readonly rootPath: string;
  /** @deprecated Compatibility for pre-EWB test/adapters. Production handles
   * always carry exact mounts. */
  readonly mounts?: ReadonlyArray<SandboxOpenedMount>;
  readonly writableRegions: ReadonlyArray<CanonicalResourceRegion>;
}

export interface SandboxPortService {
  readonly open: (input: {
    readonly executionId: ExecutionId;
    readonly workspaceId: WorkspaceId;
    readonly mounts?: ReadonlyArray<SandboxMountBinding>;
    /** @deprecated Pre-EWB adapter compatibility only. */
    readonly regions?: ReadonlyArray<CanonicalResourceRegion>;
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
    readonly resolvedBoundaryRegions: ReadonlyArray<CanonicalResourceRegion>;
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
  readonly effectAdmissionState:
    | "NotAdmitted"
    | "MayHaveStarted"
    | "LegacyUnknown";
  readonly settledAt: string | null;
  readonly settlement: ToolInvocationSettlement | null;
  readonly resultRef: string | null;
}

export interface ToolInvocationStoreService {
  readonly recordIntent: (
    invocation: ToolInvocationIntent,
    executionFence: ToolExecutionFence,
    fenceNow?: string,
  ) => Effect.Effect<
    "Recorded" | "ExecutionStopping",
    ToolInvocationStoreError,
    TransactionScope
  >;
  readonly settle: (
    invocationId: ToolInvocationId,
    settlement: ToolInvocationSettlement,
    resultRef: string | null,
    settledAt: string,
    executionFence: ToolExecutionFence,
    fenceNow?: string,
  ) => Effect.Effect<boolean, ToolInvocationStoreError, TransactionScope>;
  /** P4 legacy InvocationApproval route only. If a unified action_approvals
   * ledger exists, this operation must fail closed: P32 terminalized all
   * unprovable old approvals, and active P38 approvals are consumed only
   * through ExecutableApprovalStore's exact runtime binding. */
  readonly consumeApproval: (
    approvalId: string,
    invocationId: ToolInvocationId,
    executionFence: ToolExecutionFence,
    fenceNow?: string,
  ) => Effect.Effect<
    boolean | "ExecutionStopping",
    ToolInvocationStoreError,
    TransactionScope
  >;
  readonly recordNoEffectDenial: (
    invocation: ToolInvocationIntent,
    reasonCode: NoEffectDenialCode,
    settledAt: string,
    executionFence: ToolExecutionFence,
    fenceNow?: string,
  ) => Effect.Effect<
    ToolInvocationRecord | "ExecutionStopping",
    ToolInvocationStoreError,
    TransactionScope
  >;
  readonly recordNoEffectInterruption: (
    invocationId: ToolInvocationId,
    settledAt: string,
    executionFence: ToolExecutionFence,
    fenceNow?: string,
  ) => Effect.Effect<boolean, ToolInvocationStoreError, TransactionScope>;
  readonly admitEffect: (
    invocationId: ToolInvocationId,
    currentAuthority: InvocationAuthority,
    now: string,
    executionFence: ToolExecutionFence,
  ) => Effect.Effect<
    ToolEffectAdmissionResult,
    ToolInvocationStoreError,
    TransactionScope
  >;
  /** Resolves a legacy P4 InvocationApproval only. A unified ledger may expose
   * exact P32 P4 migration history for same-invocation replay/expiry handling;
   * current binding-proven P38 Executable rows are not representable here. */
  readonly findApproval: (
    approvalId: string,
  ) => Effect.Effect<
    Option.Option<InvocationApproval>,
    ToolInvocationStoreError,
    TransactionScope
  >;
  readonly findById: (
    invocationId: ToolInvocationId,
  ) => Effect.Effect<
    Option.Option<ToolInvocationRecord>,
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
