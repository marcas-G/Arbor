import type {
  CanonicalResourceRegion,
  ResourceAddress,
  Workspace,
} from "@arbor/domain";
import {
  ArtifactId,
  decodeExecutionEpisodeBinding,
  decodeNetworkPolicyV1,
  decodeSandboxProviderId,
  encodeExecutionEpisodeBinding,
  encodeNetworkPolicyV1,
  parse,
  resolveSandboxProvider,
} from "@arbor/domain";
import {
  ArtifactService,
  approvalTargetDigestV1,
  type BoundedObservation,
  type CanonicalToolObservation,
  Clock,
  canonicalArgumentsDigestV1,
  canonicalizeRecoveryBindingV1,
  EnvironmentRevisionStore,
  type ExecutableApprovalConsumptionReceipt,
  type ExecutableApprovalRecord,
  ExecutableApprovalStore,
  executableApprovalBindingMatches,
  type LeaseFencingRejected,
  type NoEffectDenialCode,
  P39RecoveryEvidenceStore,
  ProjectEnvironmentPort,
  type RecoveryBindingV1,
  ResourceAdmission,
  reconciliationFactId,
  recoveryBindingV1Digest,
  type SandboxHandle,
  SandboxPort,
  SandboxProcessPort,
  type SandboxProcessRunner,
  type SandboxProviderUnavailableOutcome,
  type SelectedP39RecoveryEvidence,
  ToolAuthorityResolver,
  type ToolDefinition,
  ToolDefinitionStore,
  type ToolExecutionContext,
  type ToolIntent,
  type ToolInvocationIntent,
  type ToolInvocationSettlement,
  ToolInvocationStore,
  ToolObservationEvidenceStore,
  ToolObservationReplayAttentionFactStore,
  type ToolObservationReplayFailureCode,
  ToolReconciliationFactStore,
  ToolReconciliationPort,
  type ToolReconciliationProfile,
  ToolReconciliationProfileRegistry,
  type ToolReconciliationRequest,
  type ToolReconciliationResult,
  type ToolRuntimeError,
  ToolRuntimePort,
  TransactionPort,
  targetResourceIdentityDigestV1,
  toolDefinitionIdentityDigestV1,
  validateToolReconciliationResult,
  verifyRecoveryBindingV1,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { actionDigestOf, matchApproval } from "./approval.js";
import { checkInvocationAuthority } from "./authority.js";
import { validateToolInput } from "./validation.js";

export interface ToolExecutionResult {
  readonly settlement: ToolInvocationSettlement;
  readonly observation: BoundedObservation;
  readonly resultRef: string | null;
  readonly sandboxProviderUnavailable?: SandboxProviderUnavailableOutcome;
}

export interface ToolExecutor {
  readonly name: string;
  readonly write: boolean;
  readonly processCapability?: "SandboxProcess";
  readonly requiresApproval: (intent: ToolIntent) => boolean;
  readonly execute: (input: {
    readonly intent: ToolIntent;
    readonly definition: ToolDefinition;
    readonly context: ToolExecutionContext;
    readonly sandbox: SandboxHandle;
    readonly regions: ReadonlyArray<CanonicalResourceRegion>;
    readonly runProcess?: SandboxProcessRunner;
  }) => Effect.Effect<ToolExecutionResult, ToolRuntimeError>;
}

export interface ToolRuntimeQualificationEvent {
  readonly boundary:
    | "AH7AfterToolIntentCommit"
    | "AH7BeforeEffectAdmission"
    | "AH7AfterEffectAdmissionCommit"
    | "AH7AfterToolEffectBeforeSettlement"
    | "AH7BeforeToolSettlementTransaction"
    | "AH7BeforeToolSettlementCommit"
    | "AH7AfterToolSettlementCommit"
    | "AH7BeforeReconciliationFactCommit"
    | "AH7AfterReconciliationFactCommit"
    | "AH7ReconciliationResultFenceRejected"
    | "AH7ToolSettlementFenceRejected"
    | "AH7AfterEffectAuthorityResolvedBeforeAdmission"
    | "P38StopInvocationLookup"
    | "P38StopEffectAdmissionResult"
    | "P38P39ClaimBeforeTransaction";
  readonly executionId: string;
  readonly invocationId: string;
  readonly callRef: string;
  readonly approvalId?: string | null;
  readonly logicalActionId?: string | undefined;
  readonly inputHash?: string;
  readonly toolName?: string;
  readonly toolVersion?: string;
  readonly fencingGeneration?: number;
  readonly priorFound?: boolean;
  readonly priorIdentityMatches?: boolean;
  readonly priorEffectAdmissionState?: string | null;
  readonly priorSettlementKind?: string | null;
  readonly admissionResult?: string;
  readonly admissionDenialReason?: string;
  readonly outcomeTag?: "NotOccurred" | "Occurred" | "StillUnknown";
  readonly attemptNo?: 0 | 1;
  readonly factId?: string;
}

export type ToolRuntimeQualificationProbe = (
  event: ToolRuntimeQualificationEvent,
) => Promise<void>;

const bounded = (text: string, limit = 2000): BoundedObservation => ({
  text: text.length > limit ? text.slice(0, limit) : text,
  truncated: text.length > limit,
});

const requestedMountRefs = (argumentsJson: string): ReadonlyArray<string> => {
  try {
    const parsed = JSON.parse(argumentsJson) as {
      target?: { readonly mount?: unknown };
      cwd?: { readonly mount?: unknown };
    };
    return [parsed.target?.mount, parsed.cwd?.mount].filter(
      (value): value is string => typeof value === "string",
    );
  } catch {
    return [];
  }
};

const legacyResourceArguments = (
  argumentsJson: string,
): ReadonlyArray<ResourceAddress> => {
  try {
    const parsed = JSON.parse(argumentsJson) as {
      path?: ResourceAddress;
      cwd?: ResourceAddress;
    };
    return [parsed.path, parsed.cwd].filter(
      (value): value is ResourceAddress => value !== undefined,
    );
  } catch {
    return [];
  }
};

type FilesystemAddress = Extract<
  ResourceAddress,
  { readonly _tag: "FileTree" | "GitWorktree" }
>;

const primaryFilesystemAddress = (
  addresses: ReadonlyArray<ResourceAddress>,
): FilesystemAddress | undefined => {
  const candidates = addresses.filter(
    (address): address is FilesystemAddress =>
      address._tag === "GitWorktree" || address._tag === "FileTree",
  );
  const paths = new Set(
    candidates.map((address) =>
      address.path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase(),
    ),
  );
  if (paths.size !== 1) return undefined;
  return (
    candidates.find((address) => address._tag === "GitWorktree") ??
    candidates[0]
  );
};

const denialReason = (reasonCode: NoEffectDenialCode): string => {
  switch (reasonCode) {
    case "InvocationAuthorityDenied":
      return "tool authority denied";
    case "ApprovalRequired":
      return "approval required";
    case "ApprovalRejected":
      return "approval rejected";
    case "ApprovalNotFound":
      return "approval not found";
    case "ApprovalMismatch":
      return "approval does not match this invocation";
    case "ApprovalExpired":
      return "approval expired";
    case "ApprovalConsumedByOtherInvocation":
      return "approval was consumed by another invocation";
    case "ResourceResolutionDenied":
      return "tool resource could not be resolved";
    case "ResourceAdmissionDenied":
      return "tool resource admission denied";
    case "ApprovalNoLongerAuthorized":
      return "approval is no longer authorized";
  }
};

/** Preserve an already-committed human Reject across later replay. Expiry is
 * a transition from Pending/Approved, never a reinterpretation of Rejected. */
export const executableApprovalTerminalDenial = (
  approval: Pick<ExecutableApprovalRecord, "state" | "expiresAt">,
  now: string,
): "ApprovalRejected" | "ApprovalExpired" | null => {
  if (approval.state === "Rejected") return "ApprovalRejected";
  if (approval.state === "Expired" || approval.expiresAt <= now) {
    return "ApprovalExpired";
  }
  return null;
};

export const recoveryBindingIdentityMatches = (input: {
  readonly identity: ToolExecutionContext["recoveryBindingIdentity"];
  readonly executionId: ToolExecutionContext["executionId"];
  readonly invocationId: ToolIntent["invocationId"];
  readonly callRef: ToolIntent["callRef"];
  readonly approvalBinding?: import("@arbor/ports").ExecutableApprovalBinding;
}): boolean => {
  const identity = input.identity;
  if (
    identity === undefined ||
    identity.executionId !== input.executionId ||
    identity.callRef !== input.callRef ||
    !Number.isSafeInteger(identity.logicalStepNo) ||
    identity.logicalStepNo < 0 ||
    !Number.isSafeInteger(identity.repairAttempt) ||
    identity.repairAttempt < 0 ||
    !Number.isSafeInteger(identity.actionIndex) ||
    identity.actionIndex < 0 ||
    identity.logicalActionId.trim().length === 0 ||
    String(identity.providerTurnId).trim().length === 0
  ) {
    return false;
  }
  const approval = input.approvalBinding;
  return (
    approval === undefined ||
    (approval.executionId === identity.executionId &&
      approval.logicalStepNo === identity.logicalStepNo &&
      approval.repairAttempt === identity.repairAttempt &&
      approval.logicalActionId === identity.logicalActionId &&
      approval.actionIndex === identity.actionIndex &&
      approval.callRef === identity.callRef &&
      approval.toolInvocationId === input.invocationId)
  );
};

const permissionGrantRevisionsFromSource = (
  sourceRevision: string | undefined,
): {
  readonly workspacePolicyRevision: number | null;
  readonly permissionGrantRevisions: ReadonlyArray<
    readonly [string, number | null]
  >;
} | null => {
  if (sourceRevision === undefined) {
    return { workspacePolicyRevision: null, permissionGrantRevisions: [] };
  }
  try {
    const value = JSON.parse(sourceRevision) as {
      readonly workspacePolicyRevision?: unknown;
      readonly activeGrants?: unknown;
      readonly verifierId?: unknown;
    };
    if (
      typeof value !== "object" ||
      value === null ||
      !Number.isSafeInteger(value.workspacePolicyRevision) ||
      (value.workspacePolicyRevision as number) < 0 ||
      !Array.isArray(value.activeGrants) ||
      !(value.verifierId === null || typeof value.verifierId === "string")
    ) {
      return null;
    }
    const revisions: Array<readonly [string, number | null]> = [];
    const seen = new Set<string>();
    for (const item of value.activeGrants) {
      if (
        !Array.isArray(item) ||
        item.length !== 2 ||
        typeof item[0] !== "string" ||
        item[0].length === 0 ||
        seen.has(item[0]) ||
        (item[1] !== null &&
          (!Number.isSafeInteger(item[1]) || (item[1] as number) < 0))
      ) {
        return null;
      }
      revisions.push([item[0], item[1] as number | null]);
      seen.add(item[0]);
    }
    return {
      workspacePolicyRevision: value.workspacePolicyRevision as number,
      permissionGrantRevisions: revisions,
    };
  } catch {
    return null;
  }
};

interface RecoveryApprovalSnapshot {
  readonly approvalId: string;
  readonly subject: string;
  readonly preConsumeRevision: number;
  readonly consumedRevision: number;
  readonly expiresAt: string;
  readonly targetResourceSpaceIds: ReadonlyArray<string>;
  readonly actionDigest: string;
  readonly consumedBy: ToolIntent["invocationId"];
}

const recoveryApprovalSnapshotFromReceipt = (
  receipt: ExecutableApprovalConsumptionReceipt,
): RecoveryApprovalSnapshot => ({
  approvalId: receipt.approvalId,
  subject: receipt.binding.subject,
  preConsumeRevision: receipt.preConsumeRevision,
  consumedRevision: receipt.consumedRevision,
  expiresAt: receipt.expiresAt,
  targetResourceSpaceIds: receipt.binding.targetResourceSpaceIds,
  actionDigest: receipt.binding.actionDigest,
  consumedBy: receipt.consumedBy,
});

const recoveryApprovalSnapshotFromRecord = (
  approval: ExecutableApprovalRecord | undefined,
  invocationId: ToolIntent["invocationId"],
): RecoveryApprovalSnapshot | null => {
  if (
    approval === undefined ||
    approval.state !== "Consumed" ||
    approval.consumedBy !== invocationId ||
    approval.revision <= 0
  ) {
    return null;
  }
  return {
    approvalId: approval.approvalId,
    subject: approval.subject,
    preConsumeRevision: approval.revision - 1,
    consumedRevision: approval.revision,
    expiresAt: approval.expiresAt,
    targetResourceSpaceIds: approval.targetResourceSpaceIds,
    actionDigest: approval.actionDigest,
    consumedBy: invocationId,
  };
};

const makeRecoveryBindingV1 = (input: {
  readonly context: ToolExecutionContext;
  readonly intent: ToolIntent;
  readonly definition: ToolDefinition;
  readonly authority: import("@arbor/ports").InvocationAuthority;
  readonly regions: ReadonlyArray<CanonicalResourceRegion>;
  readonly resourceBoundaryRevision: number;
  readonly environmentRevision: string;
  readonly approval: RecoveryApprovalSnapshot | null;
  readonly profile?: ToolReconciliationProfile;
  readonly effectKey?: string | null;
}): RecoveryBindingV1 => {
  const identity = input.context.recoveryBindingIdentity;
  const policyRevisions = input.context.recoveryBindingPolicyRevisions;
  if (identity === undefined || policyRevisions === undefined) {
    throw new TypeError("trusted RecoveryBinding source identity is missing");
  }
  const authoritySource = permissionGrantRevisionsFromSource(
    input.authority.sourceRevision,
  );
  if (
    authoritySource === null ||
    (authoritySource.workspacePolicyRevision !== null &&
      authoritySource.workspacePolicyRevision !==
        policyRevisions.workspacePolicyRevision)
  ) {
    throw new TypeError("trusted authority source revision is malformed");
  }
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(input.intent.argumentsJson);
  } catch (cause) {
    throw new TypeError("ToolIntent arguments are not canonical JSON", {
      cause,
    });
  }
  const approval = input.approval;
  return {
    bindingVersion: 1,
    digestAlgorithm: "SHA-256",
    executionId: input.context.executionId,
    invocationId: input.intent.invocationId,
    providerTurnId: identity.providerTurnId,
    logicalStepNo: identity.logicalStepNo,
    repairAttempt: identity.repairAttempt,
    logicalActionId: identity.logicalActionId,
    actionIndex: identity.actionIndex,
    callRef: input.intent.callRef,
    toolName: input.intent.toolName,
    toolVersion: input.intent.toolVersion,
    toolDefinitionHash: recoveryBindingToolDefinitionHashV1(input.definition),
    sideEffectSemantics: input.definition.sideEffectSemantics,
    canonicalArgumentsDigest: canonicalArgumentsDigestV1(argumentsValue),
    targetResourceIdentityDigest: targetResourceIdentityDigestV1(input.regions),
    resourceBoundaryRevision: input.resourceBoundaryRevision,
    environmentRevision: input.environmentRevision,
    authoritySourceRevision: input.authority.sourceRevision ?? null,
    principalId: String(input.context.authenticatedPrincipal),
    capability: [...input.definition.capabilityMetadata],
    permissionGrantRevisions: authoritySource.permissionGrantRevisions,
    workspacePolicyRevision: policyRevisions.workspacePolicyRevision,
    projectPolicyRevision: policyRevisions.projectPolicyRevision,
    controlBasisDigest: input.context.controlBasisDigest,
    approvalId: approval?.approvalId ?? null,
    approvalSubject: approval?.subject ?? null,
    approvalPreConsumeRevision: approval?.preConsumeRevision ?? null,
    approvalConsumedRevision: approval?.consumedRevision ?? null,
    approvalExpiresAt: approval?.expiresAt ?? null,
    approvalTargetDigest:
      approval === null
        ? null
        : approvalTargetDigestV1(approval.targetResourceSpaceIds),
    approvalActionDigest: approval?.actionDigest ?? null,
    approvalConsumedBy: approval?.consumedBy ?? null,
    profileId: input.profile?.profileId ?? null,
    profileVersion: input.profile?.profileVersion ?? null,
    profileHash: input.profile?.profileHash ?? null,
    profileProtocol: input.profile?.profileProtocol ?? null,
    effectKey: input.effectKey ?? null,
  };
};

/** P39 projection of a ToolDefinition's stable identity token into the
 * SHA-256-only RecoveryBindingV1 field. */
export const recoveryBindingToolDefinitionHashV1 = (
  definition: ToolDefinition,
): string => toolDefinitionIdentityDigestV1(definition.hash);

const P39_RESOURCE_RESOLUTION_STALE = {
  _tag: "P39ResourceResolutionStale",
} as const;

const denied = (reasonCode: NoEffectDenialCode): CanonicalToolObservation => ({
  _tag: "Denied",
  reasonCode,
  reason: denialReason(reasonCode),
});

const approvalDenialCode = (reason: string): NoEffectDenialCode => {
  if (reason === "approval already consumed") {
    return "ApprovalConsumedByOtherInvocation";
  }
  if (reason === "approval expired") return "ApprovalExpired";
  return "ApprovalMismatch";
};

export const reconciliationRetryDenialReasonCode = (
  reasonCode: NoEffectDenialCode,
): "ApprovalNoLongerAuthorized" | "AuthoritySnapshotChanged" =>
  reasonCode === "ApprovalRequired" ||
  reasonCode === "ApprovalRejected" ||
  reasonCode === "ApprovalNotFound" ||
  reasonCode === "ApprovalMismatch" ||
  reasonCode === "ApprovalExpired" ||
  reasonCode === "ApprovalConsumedByOtherInvocation" ||
  reasonCode === "ApprovalNoLongerAuthorized"
    ? "ApprovalNoLongerAuthorized"
    : "AuthoritySnapshotChanged";

const isLeaseFencingRejected = (
  cause: unknown,
): cause is LeaseFencingRejected =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "LeaseFencingRejected";

const hasCompleteExecutionFence = (fence: unknown): boolean => {
  if (typeof fence !== "object" || fence === null) return false;
  const value = fence as Record<string, unknown>;
  return (
    typeof value.executionId === "string" &&
    value.executionId.length > 0 &&
    typeof value.workerId === "string" &&
    value.workerId.length > 0 &&
    typeof value.workerIncarnationId === "string" &&
    value.workerIncarnationId.length > 0 &&
    typeof value.fencingGeneration === "number" &&
    Number.isInteger(value.fencingGeneration) &&
    value.fencingGeneration >= 0
  );
};

const isP39ResourceResolutionStale = (
  cause: unknown,
): cause is typeof P39_RESOURCE_RESOLUTION_STALE =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === P39_RESOURCE_RESOLUTION_STALE._tag;

const matchesAuthenticatedP39Evidence = (input: {
  readonly selected: SelectedP39RecoveryEvidence;
  readonly intent: ToolIntent;
  readonly context: ToolExecutionContext;
  readonly factId: string;
  readonly expectedOutcome?: "NotOccurred" | "Occurred";
}): boolean => {
  const {
    selected,
    intent,
    context,
    factId,
    expectedOutcome = "NotOccurred",
  } = input;
  const binding = selected.binding.value;
  const sourceIdentity = context.recoveryBindingIdentity;
  const policyRevisions = context.recoveryBindingPolicyRevisions;
  return (
    sourceIdentity !== undefined &&
    policyRevisions !== undefined &&
    binding.executionId === sourceIdentity.executionId &&
    binding.providerTurnId === sourceIdentity.providerTurnId &&
    binding.logicalStepNo === sourceIdentity.logicalStepNo &&
    binding.repairAttempt === sourceIdentity.repairAttempt &&
    binding.logicalActionId === sourceIdentity.logicalActionId &&
    binding.actionIndex === sourceIdentity.actionIndex &&
    binding.callRef === sourceIdentity.callRef &&
    binding.workspacePolicyRevision ===
      policyRevisions.workspacePolicyRevision &&
    binding.projectPolicyRevision === policyRevisions.projectPolicyRevision &&
    sourceIdentity.executionId === context.executionId &&
    sourceIdentity.providerTurnId === context.providerTurnId &&
    sourceIdentity.logicalActionId === context.logicalActionId &&
    sourceIdentity.callRef === intent.callRef &&
    binding.executionId === context.executionId &&
    binding.invocationId === intent.invocationId &&
    binding.callRef === intent.callRef &&
    binding.toolName === intent.toolName &&
    binding.toolVersion === intent.toolVersion &&
    binding.approvalId === intent.approvalId &&
    binding.controlBasisDigest === context.controlBasisDigest &&
    selected.attempt.invocationId === intent.invocationId &&
    selected.attempt.admissionState === "MayHaveStarted" &&
    selected.attempt.admissionSource === "P39Admission" &&
    selected.attempt.admissionTimePrecision === "TransactionTimestamp" &&
    selected.attempt.bindingSha256 === selected.binding.bindingSha256 &&
    selected.fact.factId === factId &&
    selected.fact.invocationId === intent.invocationId &&
    selected.fact.attemptNo === selected.attempt.attemptNo &&
    selected.fact.bindingSha256 === selected.binding.bindingSha256 &&
    selected.fact.profileHash === selected.attempt.profileHash &&
    selected.fact.effectKey === selected.attempt.effectKey &&
    selected.fact.factOrigin === "ProfileReconciliation" &&
    selected.fact.factDisposition === "RecoveryInput" &&
    selected.fact.legacyReason === null &&
    selected.fact.reasonCode === null &&
    selected.fact.outcome === expectedOutcome
  );
};
export const ToolRuntimeLive = (
  executors: ReadonlyArray<ToolExecutor>,
  options: {
    readonly maxDelegationDepth?: number;
    readonly now?: string;
    readonly qualificationProbe?: ToolRuntimeQualificationProbe;
  } = {},
): Layer.Layer<
  ToolRuntimePort,
  never,
  | ToolDefinitionStore
  | SandboxPort
  | ResourceAdmission
  | ToolInvocationStore
  | ProjectEnvironmentPort
  | TransactionPort
  | Clock
> =>
  Layer.effect(
    ToolRuntimePort,
    Effect.gen(function* () {
      const definitions = yield* ToolDefinitionStore;
      const sandbox = yield* SandboxPort;
      const sandboxProcess = yield* Effect.serviceOption(SandboxProcessPort);
      const admission = yield* ResourceAdmission;
      const store = yield* ToolInvocationStore;
      const executableApprovals = yield* Effect.serviceOption(
        ExecutableApprovalStore,
      );
      const tx = yield* TransactionPort;
      const clock = yield* Clock;
      const environment = yield* ProjectEnvironmentPort;
      const workspaces = yield* Effect.serviceOption(WorkspaceRepository);
      const environmentRevisions = yield* Effect.serviceOption(
        EnvironmentRevisionStore,
      );
      const p39Recovery = yield* Effect.serviceOption(P39RecoveryEvidenceStore);
      const authorityResolver = yield* Effect.serviceOption(
        ToolAuthorityResolver,
      );
      const artifactService = yield* Effect.serviceOption(ArtifactService);
      const observationEvidence = yield* Effect.serviceOption(
        ToolObservationEvidenceStore,
      );
      const replayAttentionFacts = yield* Effect.serviceOption(
        ToolObservationReplayAttentionFactStore,
      );
      const p39RecoveryEvidence = yield* Effect.serviceOption(
        P39RecoveryEvidenceStore,
      );
      const reconciliationProfiles = yield* Effect.serviceOption(
        ToolReconciliationProfileRegistry,
      );
      const reconciliationPort = yield* Effect.serviceOption(
        ToolReconciliationPort,
      );
      const reconciliationFacts = yield* Effect.serviceOption(
        ToolReconciliationFactStore,
      );
      const operationalFailure =
        (
          stage: import("@arbor/ports").ToolRuntimeOperationalStage,
          invocationRef: string,
        ) =>
        (cause: unknown): ToolRuntimeError => ({
          _tag: "ToolRuntimeOperationalFailure",
          stage,
          effectDisposition:
            stage === "Executor" || stage === "SettlementJournal"
              ? "OutcomeUncertain"
              : "NotStarted",
          invocationRef,
          cause,
        });

      const runProcessFor =
        (
          context: ToolExecutionContext,
          handle: SandboxHandle,
        ): SandboxProcessRunner =>
        (invocation) =>
          Effect.gen(function* () {
            const policy = context.sandboxProcessPolicy;
            if (policy === undefined) {
              return {
                _tag: "Rejected" as const,
                failureCode: "PolicyMissing",
              };
            }
            const unavailable = (
              failureCode: string,
              probeEvidenceRef: string | null = null,
              providerVersion = policy.providerVersion,
            ): SandboxProviderUnavailableOutcome => ({
              _tag: "SandboxProviderUnavailable",
              projectId: context.projectId,
              workspaceId: context.workspaceId,
              executionId: context.executionId,
              episodeBinding: policy.episodeBinding,
              policyRevision: policy.policyRevision,
              policyDigest: policy.policyDigest,
              profileId: policy.profile,
              providerId: policy.providerId,
              providerVersion,
              probeEvidenceRef,
              failureCode,
            });
            if (
              policy.executionId !== context.executionId ||
              context.executionEpisodeBinding === undefined
            ) {
              return {
                _tag: "Rejected" as const,
                failureCode: "ExecutionBindingMismatch",
              };
            }
            const policyEpisode = decodeExecutionEpisodeBinding(
              policy.episodeBinding,
            );
            const currentEpisode = decodeExecutionEpisodeBinding(
              context.executionEpisodeBinding,
            );
            if (
              policyEpisode === undefined ||
              currentEpisode === undefined ||
              encodeExecutionEpisodeBinding(policyEpisode) !==
                encodeExecutionEpisodeBinding(currentEpisode)
            ) {
              return {
                _tag: "Rejected" as const,
                failureCode: "EpisodeBindingMismatch",
              };
            }
            if (policy.sandboxHandleId !== handle.handleId) {
              return {
                _tag: "Rejected" as const,
                failureCode: "HandleBindingMismatch",
              };
            }

            const networkPolicy = decodeNetworkPolicyV1(policy.networkPolicy);
            if (
              !Number.isSafeInteger(policy.policyRevision) ||
              policy.policyRevision < 1 ||
              !/^[0-9a-f]{64}$/u.test(policy.policyDigest) ||
              decodeSandboxProviderId(policy.providerId) !==
                policy.providerId ||
              policy.providerVersion.trim().length === 0 ||
              policy.capabilityRevision.trim().length === 0 ||
              networkPolicy === undefined ||
              encodeNetworkPolicyV1(networkPolicy) !==
                encodeNetworkPolicyV1(policy.networkPolicy) ||
              !Object.values(policy.limits).every(
                (value) => Number.isSafeInteger(value) && value > 0,
              ) ||
              policy.environmentAllowlist.some(
                (name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name),
              ) ||
              new Set(policy.environmentAllowlist).size !==
                policy.environmentAllowlist.length
            ) {
              return {
                _tag: "Rejected" as const,
                failureCode: "PolicyMissing",
              };
            }

            const actualMounts = (handle.mounts ?? []).map(
              ({ ref, rootPath, access }) => ({ ref, rootPath, access }),
            );
            const policyMounts = policy.admittedMounts.map(
              ({ ref, rootPath, access }) => ({ ref, rootPath, access }),
            );
            const canonicalMounts = (mounts: typeof actualMounts) =>
              JSON.stringify(
                [...mounts].sort((left, right) =>
                  left.ref.localeCompare(right.ref),
                ),
              );
            if (
              actualMounts.length === 0 ||
              canonicalMounts(actualMounts) !== canonicalMounts(policyMounts)
            ) {
              return {
                _tag: "Rejected" as const,
                failureCode: "MountBindingMismatch",
              };
            }

            const requestedTimeoutMs = invocation.requestedTimeoutMs;
            if (
              requestedTimeoutMs !== undefined &&
              (!Number.isSafeInteger(requestedTimeoutMs) ||
                requestedTimeoutMs < 1)
            ) {
              return {
                _tag: "Rejected" as const,
                failureCode: "InvalidTimeout",
              };
            }
            const timeoutMs = Math.min(
              requestedTimeoutMs ?? policy.limits.wallTimeMs,
              policy.limits.wallTimeMs,
            );

            if (!Option.isSome(sandboxProcess)) {
              return unavailable("SandboxProcessPortUnavailable");
            }

            const capabilities = yield* sandboxProcess.value.capabilities();
            const resolved = resolveSandboxProvider(
              {
                providerId: policy.providerId,
                expectedProviderVersion: policy.providerVersion,
                expectedCapabilityRevision: policy.capabilityRevision,
                profile: policy.profile,
                networkPolicy,
                boundary: policy.boundary,
              },
              capabilities,
            );
            if (resolved._tag !== "Available") {
              return unavailable(
                resolved.reason,
                resolved.capability?.probeEvidenceRef ?? null,
                resolved.capability?.providerVersion ?? policy.providerVersion,
              );
            }

            const result = yield* sandboxProcess.value.run({
              ...invocation,
              timeoutMs,
              policy,
              handle,
            });
            if (result._tag === "Unavailable") {
              if (
                result.providerId !== policy.providerId ||
                result.providerVersion !== policy.providerVersion ||
                result.failureCode.trim() !== result.failureCode ||
                result.failureCode.length === 0 ||
                new TextEncoder().encode(result.failureCode).byteLength > 128
              ) {
                return {
                  _tag: "Rejected" as const,
                  failureCode: "ProviderOutcomeMismatch",
                };
              }
              return unavailable(
                result.failureCode,
                result.probeEvidenceRef,
                result.providerVersion,
              );
            }
            return result;
          });

      const replayFailureCode = (
        cause: unknown,
      ): ToolObservationReplayFailureCode | undefined =>
        typeof cause === "object" &&
        cause !== null &&
        "_tag" in cause &&
        cause._tag === "ToolObservationReplayEvidenceFailure" &&
        "failureCode" in cause
          ? (cause.failureCode as ToolObservationReplayFailureCode)
          : undefined;

      const recordReplayFailure = (
        intent: ToolIntent,
        context: ToolExecutionContext,
        failureCode: ToolObservationReplayFailureCode,
        detectedAt: string,
      ): Effect.Effect<never, ToolRuntimeError> =>
        Effect.gen(function* () {
          const fence = context.executionFence;
          if (
            fence === undefined ||
            context.providerTurnId === undefined ||
            context.logicalActionId === undefined ||
            Option.isNone(replayAttentionFacts)
          ) {
            return yield* Effect.fail<ToolRuntimeError>(
              operationalFailure(
                "SettlementJournal",
                String(intent.invocationId),
              )({
                _tag: "ToolObservationReplayEscalationUnavailable",
              }),
            );
          }
          yield* tx
            .transact(
              replayAttentionFacts.value.recordFailure({
                projectId: context.projectId,
                executionId: context.executionId,
                targetWorkspaceId: context.workspaceId,
                logicalActionId: context.logicalActionId,
                providerTurnId: context.providerTurnId,
                callRef: intent.callRef,
                invocationId: intent.invocationId,
                failureCode,
                firstDetectedAt: detectedAt,
                executionFence: fence,
              }),
            )
            .pipe(
              Effect.mapError((cause) =>
                isLeaseFencingRejected(cause)
                  ? cause
                  : operationalFailure(
                      "SettlementJournal",
                      String(intent.invocationId),
                    )(cause),
              ),
            );
          return yield* Effect.fail<ToolRuntimeError>({
            _tag: "ToolObservationRecoveryBlocked",
            executionId: context.executionId,
            logicalActionId: context.logicalActionId,
          });
        });

      const NOT_P39_RECEIPT = { _tag: "NotP39Receipt" } as const;
      type NotP39Receipt = typeof NOT_P39_RECEIPT;

      const decodeRecordedEvidenceResult = (
        intent: ToolIntent,
        context: ToolExecutionContext,
        recorded: {
          readonly invocationId: string;
          readonly executionId: string;
          readonly workspaceId: string;
          readonly toolName: string;
          readonly toolVersion: string;
          readonly sideEffectSemantics: import("@arbor/ports").SideEffectSemantics;
          readonly argumentsJson: string;
          readonly resolvedRegions: ReadonlyArray<CanonicalResourceRegion>;
          readonly approvalId: string | null;
          readonly intentAt: string;
          readonly settlement?: import("@arbor/ports").ToolInvocationRecord["settlement"];
          readonly resultRef?: string | null;
        },
        terminalP39Receipt?: {
          readonly allowMissingSelected?: boolean;
          readonly definition: ToolDefinition;
          readonly profile: ToolReconciliationProfile;
          readonly effectKey: string;
        },
      ): Effect.Effect<
        CanonicalToolObservation | NotP39Receipt,
        ToolRuntimeError
      > =>
        Effect.gen(function* () {
          if (Option.isNone(observationEvidence)) {
            return yield* Effect.fail(
              operationalFailure(
                "SettlementJournal",
                String(intent.invocationId),
              )({
                _tag: "ToolObservationEvidenceStoreUnavailable",
              }),
            );
          }
          const fence = context.executionFence;
          if (fence === undefined) {
            return yield* Effect.fail<ToolRuntimeError>(
              operationalFailure(
                "SettlementJournal",
                String(intent.invocationId),
              )({
                _tag: "ToolObservationEvidenceReplayFenceUnavailable",
              }),
            );
          }
          const invocation = {
            invocationId: recorded.invocationId as ToolIntent["invocationId"],
            executionId:
              recorded.executionId as ToolExecutionContext["executionId"],
            workspaceId:
              recorded.workspaceId as ToolExecutionContext["workspaceId"],
            toolName: recorded.toolName,
            toolVersion: recorded.toolVersion,
            sideEffectSemantics: recorded.sideEffectSemantics,
            argumentsJson: recorded.argumentsJson,
            resolvedRegions: recorded.resolvedRegions,
            approvalId: recorded.approvalId,
            intentAt: recorded.intentAt,
          } as const;
          const read = yield* Effect.match(
            tx.transact(
              Effect.gen(function* () {
                yield* observationEvidence.value.assertCurrentFence(
                  fence,
                  yield* clock.now(),
                );
                const evidence = yield* observationEvidence.value.read(
                  invocation,
                  fence,
                  yield* clock.now(),
                );
                let selected = Option.none<SelectedP39RecoveryEvidence>();
                if (
                  terminalP39Receipt !== undefined ||
                  evidence.observation._tag === "ReconciledNoEffect"
                ) {
                  if (Option.isSome(p39RecoveryEvidence)) {
                    selected = yield* p39RecoveryEvidence.value.findSelected(
                      intent.invocationId,
                    );
                  }
                }
                return { evidence, selected };
              }),
            ),
            {
              onFailure: (cause) => ({ ok: false as const, cause }),
              onSuccess: (value) => ({ ok: true as const, value }),
            },
          );
          if (!read.ok) {
            if (isLeaseFencingRejected(read.cause)) {
              return yield* Effect.fail<ToolRuntimeError>(read.cause);
            }
            const failureCode = replayFailureCode(read.cause);
            if (failureCode !== undefined) {
              return yield* recordReplayFailure(
                intent,
                context,
                failureCode,
                yield* clock.now(),
              );
            }
            if (terminalP39Receipt !== undefined) {
              return yield* recordReplayFailure(
                intent,
                context,
                "SettlementMismatch",
                yield* clock.now(),
              );
            }
            return yield* Effect.fail<ToolRuntimeError>(
              operationalFailure(
                "SettlementJournal",
                String(intent.invocationId),
              )(read.cause),
            );
          }
          const observation = read.value.evidence
            .observation as CanonicalToolObservation;
          const requiresSelectedFact =
            terminalP39Receipt !== undefined ||
            observation._tag === "ReconciledNoEffect";
          if (requiresSelectedFact) {
            if (Option.isNone(p39RecoveryEvidence)) {
              return yield* recordReplayFailure(
                intent,
                context,
                "SettlementMismatch",
                yield* clock.now(),
              );
            }
            const selected = read.value.selected;
            if (Option.isNone(selected)) {
              if (terminalP39Receipt?.allowMissingSelected === true) {
                return NOT_P39_RECEIPT;
              }
              return yield* recordReplayFailure(
                intent,
                context,
                "SettlementMismatch",
                yield* clock.now(),
              );
            }
            const selectedOutcome = selected.value.fact.outcome;
            if (
              selectedOutcome !== "NotOccurred" &&
              selectedOutcome !== "Occurred"
            ) {
              return yield* recordReplayFailure(
                intent,
                context,
                "SettlementMismatch",
                yield* clock.now(),
              );
            }
            const expectedP39Outcome = terminalP39Receipt
              ? selectedOutcome
              : "NotOccurred";
            const factId =
              expectedP39Outcome === "NotOccurred"
                ? observation._tag === "ReconciledNoEffect"
                  ? observation.reconciliationFactRef
                  : ""
                : selected.value.fact.factId;
            if (
              !matchesAuthenticatedP39Evidence({
                selected: selected.value,
                intent,
                context,
                factId,
                expectedOutcome: expectedP39Outcome,
              })
            ) {
              return yield* recordReplayFailure(
                intent,
                context,
                "SettlementMismatch",
                yield* clock.now(),
              );
            }
            if (terminalP39Receipt !== undefined) {
              const selectedEvidence = selected.value;
              const binding = selectedEvidence.binding.value;
              let argumentsDigest: string | null;
              try {
                argumentsDigest = canonicalArgumentsDigestV1(
                  JSON.parse(recorded.argumentsJson),
                );
              } catch {
                argumentsDigest = null;
              }
              const exactReceiptSource =
                binding.sideEffectSemantics === "Reconcilable" &&
                binding.toolName === recorded.toolName &&
                binding.toolVersion === recorded.toolVersion &&
                binding.toolDefinitionHash ===
                  recoveryBindingToolDefinitionHashV1(
                    terminalP39Receipt.definition,
                  ) &&
                binding.canonicalArgumentsDigest === argumentsDigest &&
                binding.targetResourceIdentityDigest ===
                  targetResourceIdentityDigestV1(recorded.resolvedRegions) &&
                binding.approvalId === recorded.approvalId &&
                binding.approvalId === intent.approvalId &&
                (context.executableApproval === undefined ||
                  context.executableApproval.approvalId ===
                    recorded.approvalId) &&
                binding.profileId === terminalP39Receipt.profile.profileId &&
                binding.profileVersion ===
                  terminalP39Receipt.profile.profileVersion &&
                binding.profileHash ===
                  terminalP39Receipt.profile.profileHash &&
                binding.profileProtocol ===
                  terminalP39Receipt.profile.profileProtocol &&
                binding.effectKey === terminalP39Receipt.effectKey &&
                selectedEvidence.attempt.profileId ===
                  terminalP39Receipt.profile.profileId &&
                selectedEvidence.attempt.profileVersion ===
                  terminalP39Receipt.profile.profileVersion &&
                selectedEvidence.attempt.profileHash ===
                  terminalP39Receipt.profile.profileHash &&
                selectedEvidence.attempt.profileProtocol ===
                  terminalP39Receipt.profile.profileProtocol &&
                selectedEvidence.attempt.effectKey ===
                  terminalP39Receipt.effectKey;
              const observationMatchesReceipt =
                expectedP39Outcome === "NotOccurred"
                  ? observation._tag === "ReconciledNoEffect" &&
                    recorded.settlement?._tag === "ReconciledNoEffect" &&
                    observation.reconciliationFactRef ===
                      selectedEvidence.fact.factId &&
                    recorded.settlement.reconciliationFactRef ===
                      selectedEvidence.fact.factId
                  : (observation._tag === "Success" ||
                      observation._tag === "ExpectedFailure") &&
                    recorded.settlement?._tag === observation._tag &&
                    (observation._tag === "Success"
                      ? observation.resultRef ===
                          selectedEvidence.fact.resultRef &&
                        recorded.resultRef === selectedEvidence.fact.resultRef
                      : recorded.resultRef === null &&
                        selectedEvidence.fact.resultRef !== null);
              if (!exactReceiptSource || !observationMatchesReceipt) {
                return yield* recordReplayFailure(
                  intent,
                  context,
                  "SettlementMismatch",
                  yield* clock.now(),
                );
              }
            }
          }
          return observation;
        });

      const decodeRecordedEvidence = (
        intent: ToolIntent,
        context: ToolExecutionContext,
        recorded: Parameters<typeof decodeRecordedEvidenceResult>[2],
      ): Effect.Effect<CanonicalToolObservation, ToolRuntimeError> =>
        decodeRecordedEvidenceResult(intent, context, recorded).pipe(
          Effect.flatMap((result) =>
            result._tag === "NotP39Receipt"
              ? Effect.fail<ToolRuntimeError>(
                  operationalFailure(
                    "SettlementJournal",
                    String(intent.invocationId),
                  )({ _tag: "UnexpectedNotP39Receipt" }),
                )
              : Effect.succeed(result),
          ),
        );

      const findInvocationFenced = (
        invocationId: ToolIntent["invocationId"],
        context: ToolExecutionContext,
        stage: import("@arbor/ports").ToolRuntimeOperationalStage,
      ) =>
        tx
          .transact(
            Effect.gen(function* () {
              if (Option.isSome(observationEvidence)) {
                const fence = context.executionFence;
                if (fence === undefined) {
                  return yield* Effect.fail<ToolRuntimeError>(
                    operationalFailure(
                      stage,
                      String(invocationId),
                    )({
                      _tag: "ToolObservationEvidenceReplayFenceUnavailable",
                    }),
                  );
                }
                yield* observationEvidence.value.assertCurrentFence(
                  fence,
                  yield* clock.now(),
                );
              }
              return yield* store.findById(invocationId);
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              isLeaseFencingRejected(cause) ||
              (typeof cause === "object" &&
                cause !== null &&
                "_tag" in cause &&
                cause._tag === "ToolRuntimeOperationalFailure")
                ? (cause as ToolRuntimeError)
                : operationalFailure(stage, String(invocationId))(cause),
            ),
          );

      const invoke = (
        intent: ToolIntent,
        context: ToolExecutionContext,
        staleRefreshCount = 0,
      ): Effect.Effect<CanonicalToolObservation, ToolRuntimeError> =>
        Effect.gen(function* () {
          const probeReconciliation = (
            boundary:
              | "AH7BeforeReconciliationFactCommit"
              | "AH7AfterReconciliationFactCommit"
              | "AH7ReconciliationResultFenceRejected",
            input: {
              readonly attemptNo: 0 | 1;
              readonly outcomeTag: "NotOccurred" | "Occurred" | "StillUnknown";
              readonly factId?: string;
            },
          ) =>
            options.qualificationProbe === undefined
              ? Effect.void
              : Effect.promise(
                  () =>
                    options.qualificationProbe?.({
                      boundary,
                      executionId: context.executionId,
                      invocationId: intent.invocationId,
                      callRef: intent.callRef,
                      attemptNo: input.attemptNo,
                      outcomeTag: input.outcomeTag,
                      ...(input.factId === undefined
                        ? {}
                        : { factId: input.factId }),
                    }) ?? Promise.resolve(),
                );
          const completeFence = hasCompleteExecutionFence(
            context.executionFence,
          );
          if (
            !completeFence ||
            context.executionFence.executionId !== context.executionId
          ) {
            return yield* Effect.fail<ToolRuntimeError>(
              operationalFailure(
                "IntentJournal",
                String(intent.invocationId),
              )({
                _tag: completeFence
                  ? "ExecutionFenceExecutionMismatch"
                  : "ExecutionFenceUnavailable",
              }),
            );
          }
          const definitionOption = yield* definitions.definition(
            intent.toolName,
            intent.toolVersion,
          );
          if (Option.isNone(definitionOption)) {
            return denied("InvocationAuthorityDenied");
          }
          const definition = definitionOption.value;
          const trustedProfile =
            definition.sideEffectSemantics === "Reconcilable" &&
            Option.isSome(reconciliationProfiles)
              ? reconciliationProfiles.value.resolve({
                  toolName: definition.name,
                  toolVersion: definition.version,
                  toolDefinitionHash: definition.hash,
                })
              : undefined;
          let trustedEffectKey: string | null = null;
          if (trustedProfile !== undefined) {
            try {
              trustedEffectKey = trustedProfile.effectKey({
                invocationId: intent.invocationId,
                argumentsJson: intent.argumentsJson,
              });
            } catch {
              trustedEffectKey = null;
            }
            if (
              typeof trustedEffectKey !== "string" ||
              trustedEffectKey.trim().length === 0
            ) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "RecoveryBinding",
                  String(intent.invocationId),
                )({ _tag: "ReconciliationEffectIdentityUnavailable" }),
              );
            }
          }
          const executor = executors.find(
            (entry) => entry.name === intent.toolName,
          );
          if (executor === undefined) {
            return denied("InvocationAuthorityDenied");
          }
          const p39BindingEnabled = Option.isSome(p39Recovery);
          if (
            p39BindingEnabled &&
            (!recoveryBindingIdentityMatches({
              identity: context.recoveryBindingIdentity,
              executionId: context.executionId,
              invocationId: intent.invocationId,
              callRef: intent.callRef,
              ...(context.executableApproval === undefined
                ? {}
                : { approvalBinding: context.executableApproval.binding }),
            }) ||
              context.recoveryBindingPolicyRevisions === undefined ||
              !Number.isSafeInteger(
                context.recoveryBindingPolicyRevisions.workspacePolicyRevision,
              ) ||
              context.recoveryBindingPolicyRevisions.workspacePolicyRevision <
                0 ||
              !Number.isSafeInteger(
                context.recoveryBindingPolicyRevisions.projectPolicyRevision,
              ) ||
              context.recoveryBindingPolicyRevisions.projectPolicyRevision <
                0 ||
              Option.isNone(environmentRevisions) ||
              Option.isNone(workspaces))
          ) {
            return yield* Effect.fail<ToolRuntimeError>(
              operationalFailure(
                "RecoveryBinding",
                String(intent.invocationId),
              )({ _tag: "RecoveryBindingSourceUnavailable" }),
            );
          }
          const refreshAfterStale = (
            cause: unknown,
          ): Effect.Effect<CanonicalToolObservation, ToolRuntimeError> =>
            staleRefreshCount === 0
              ? invoke(intent, context, staleRefreshCount + 1)
              : Effect.fail<ToolRuntimeError>(
                  operationalFailure(
                    "ResourceResolutionStale",
                    String(intent.invocationId),
                  )(cause),
                );

          const validation = validateToolInput(
            definition.inputSchemaJson,
            intent.argumentsJson,
          );
          if (validation._tag === "Invalid") {
            return {
              _tag: "ExpectedFailure" as const,
              observation: bounded(validation.reason),
            };
          }

          if (p39BindingEnabled && Option.isSome(p39Recovery)) {
            const priorDenial = yield* tx
              .transact(store.findById(intent.invocationId))
              .pipe(
                Effect.mapError(
                  operationalFailure(
                    "IntentJournal",
                    String(intent.invocationId),
                  ),
                ),
              );
            if (
              Option.isSome(priorDenial) &&
              priorDenial.value.settlement?._tag === "Denied" &&
              priorDenial.value.settledAt !== null &&
              priorDenial.value.effectAdmissionState === "NotAdmitted" &&
              priorDenial.value.resultRef === null &&
              priorDenial.value.executionId === context.executionId &&
              priorDenial.value.workspaceId === context.workspaceId &&
              priorDenial.value.toolName === intent.toolName &&
              priorDenial.value.toolVersion === intent.toolVersion &&
              priorDenial.value.sideEffectSemantics ===
                definition.sideEffectSemantics &&
              priorDenial.value.argumentsJson === intent.argumentsJson &&
              priorDenial.value.approvalId ===
                (context.executableApproval?.approvalId ?? intent.approvalId)
            ) {
              const unboundDenial = yield* tx
                .transact(
                  p39Recovery.value.findTerminalUnboundDenial(
                    intent.invocationId,
                  ),
                )
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "RecoveryBinding",
                      String(intent.invocationId),
                    ),
                  ),
                );
              if (Option.isSome(unboundDenial)) {
                return denied(priorDenial.value.settlement.reasonCode);
              }
            }
          }

          const now = options.now ?? (yield* clock.now());
          const persistNoEffectInterruption = (
            invocation: ToolInvocationIntent | undefined,
            settledAt: string,
          ): Effect.Effect<CanonicalToolObservation, ToolRuntimeError> =>
            Effect.gen(function* () {
              const failure = operationalFailure(
                "IntentJournal",
                String(intent.invocationId),
              );
              const current = yield* findInvocationFenced(
                intent.invocationId,
                context,
                "IntentJournal",
              );
              if (Option.isNone(current))
                return { _tag: "Interrupted" as const };
              const currentRecord = current.value;
              if (currentRecord.settlement !== null) {
                if (currentRecord.settlement._tag === "Denied") {
                  return denied(currentRecord.settlement.reasonCode);
                }
                if (currentRecord.settlement._tag === "Interrupted") {
                  return Option.isSome(observationEvidence)
                    ? yield* decodeRecordedEvidence(
                        intent,
                        context,
                        currentRecord,
                      )
                    : { _tag: "Interrupted" as const };
                }
                if (Option.isSome(observationEvidence)) {
                  return yield* decodeRecordedEvidence(
                    intent,
                    context,
                    currentRecord,
                  );
                }
                return {
                  _tag: "OutcomeUnknown" as const,
                  reconciliationRefs: [String(intent.invocationId)],
                };
              }
              if (currentRecord.effectAdmissionState !== "NotAdmitted") {
                return {
                  _tag: "OutcomeUnknown" as const,
                  reconciliationRefs: [String(intent.invocationId)],
                };
              }
              if (
                Option.isSome(observationEvidence) &&
                invocation !== undefined
              ) {
                const winner = yield* tx
                  .transact(
                    observationEvidence.value.settleOrReadWinner({
                      invocation,
                      settlement: { _tag: "Interrupted" },
                      resultRef: null,
                      observation: { _tag: "Interrupted" },
                      settledAt,
                      executionFence: context.executionFence,
                      fenceNow: settledAt,
                    }),
                  )
                  .pipe(Effect.mapError(failure));
                if (winner._tag === "Applied") {
                  return { _tag: "Interrupted" as const };
                }
                if (winner._tag === "ExistingDenied") {
                  return denied(winner.reasonCode);
                }
                const committed = yield* findInvocationFenced(
                  intent.invocationId,
                  context,
                  "IntentJournal",
                );
                if (Option.isSome(committed)) {
                  if (committed.value.settlement?._tag === "Denied") {
                    return denied(committed.value.settlement.reasonCode);
                  }
                  if (committed.value.settlement !== null) {
                    return yield* decodeRecordedEvidence(
                      intent,
                      context,
                      committed.value,
                    );
                  }
                }
                return yield* Effect.fail<ToolRuntimeError>(
                  failure({
                    _tag: "NoEffectInterruptionWinnerMissing",
                  }),
                );
              }
              const interrupted = yield* tx
                .transact(
                  store.recordNoEffectInterruption(
                    intent.invocationId,
                    settledAt,
                    context.executionFence,
                    settledAt,
                  ),
                )
                .pipe(Effect.mapError(failure));
              if (interrupted) return { _tag: "Interrupted" as const };
              const winner = yield* findInvocationFenced(
                intent.invocationId,
                context,
                "IntentJournal",
              );
              if (Option.isNone(winner))
                return { _tag: "Interrupted" as const };
              if (winner.value.settlement?._tag === "Denied") {
                return denied(winner.value.settlement.reasonCode);
              }
              if (
                winner.value.settlement?._tag === "Interrupted" &&
                Option.isNone(observationEvidence)
              ) {
                return { _tag: "Interrupted" as const };
              }
              if (
                winner.value.settlement !== null &&
                Option.isSome(observationEvidence)
              ) {
                return yield* decodeRecordedEvidence(
                  intent,
                  context,
                  winner.value,
                );
              }
              if (winner.value.effectAdmissionState !== "NotAdmitted") {
                return {
                  _tag: "OutcomeUnknown" as const,
                  reconciliationRefs: [String(intent.invocationId)],
                };
              }
              return { _tag: "Interrupted" as const };
            });
          const recordNoEffectDenial = (
            sideEffectSemantics: ToolDefinition["sideEffectSemantics"],
            resolvedRegions: ReadonlyArray<CanonicalResourceRegion>,
            reasonCode: NoEffectDenialCode,
          ) =>
            Effect.gen(function* () {
              const settledAt = yield* clock.now();
              const current = yield* findInvocationFenced(
                intent.invocationId,
                context,
                "IntentJournal",
              );
              if (Option.isSome(current)) {
                const record = current.value;
                const exact =
                  record.executionId === context.executionId &&
                  record.workspaceId === context.workspaceId &&
                  record.toolName === intent.toolName &&
                  record.toolVersion === intent.toolVersion &&
                  record.sideEffectSemantics === sideEffectSemantics &&
                  record.argumentsJson === intent.argumentsJson &&
                  JSON.stringify(record.resolvedRegions) ===
                    JSON.stringify(resolvedRegions) &&
                  record.approvalId === intent.approvalId;
                if (exact && record.settlement !== null) {
                  if (record.settlement._tag === "Denied") {
                    return denied(record.settlement.reasonCode);
                  }
                  if (
                    record.settlement._tag === "Interrupted" &&
                    Option.isNone(observationEvidence)
                  ) {
                    return { _tag: "Interrupted" as const };
                  }
                  if (Option.isSome(observationEvidence)) {
                    return yield* decodeRecordedEvidence(
                      intent,
                      context,
                      record,
                    );
                  }
                  if (
                    record.settlement._tag === "Success" &&
                    record.resultRef !== null &&
                    Option.isSome(artifactService)
                  ) {
                    let artifactId: ArtifactId;
                    try {
                      artifactId = parse(ArtifactId)(record.resultRef);
                    } catch {
                      return {
                        _tag: "OutcomeUnknown" as const,
                        reconciliationRefs: [String(intent.invocationId)],
                      };
                    }
                    const bytes = yield* tx
                      .transact(artifactService.value.load(artifactId))
                      .pipe(
                        Effect.mapError(
                          operationalFailure(
                            "SettlementJournal",
                            String(intent.invocationId),
                          ),
                        ),
                      );
                    if (Option.isSome(bytes)) {
                      return {
                        _tag: "Success" as const,
                        observation: bounded(
                          new TextDecoder().decode(bytes.value),
                        ),
                        resultRef: record.resultRef,
                      };
                    }
                  }
                  return {
                    _tag: "OutcomeUnknown" as const,
                    reconciliationRefs: [String(intent.invocationId)],
                  };
                }
                if (exact && record.effectAdmissionState !== "NotAdmitted") {
                  return {
                    _tag: "OutcomeUnknown" as const,
                    reconciliationRefs: [String(intent.invocationId)],
                  };
                }
              }
              const recorded = yield* tx
                .transact(
                  store.recordNoEffectDenial(
                    {
                      invocationId: intent.invocationId,
                      executionId: context.executionId,
                      workspaceId: context.workspaceId,
                      toolName: intent.toolName,
                      toolVersion: intent.toolVersion,
                      sideEffectSemantics,
                      argumentsJson: intent.argumentsJson,
                      resolvedRegions,
                      approvalId:
                        context.executableApproval?.approvalId ??
                        intent.approvalId,
                      intentAt: now,
                    },
                    reasonCode,
                    settledAt,
                    context.executionFence,
                    settledAt,
                  ),
                )
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "IntentJournal",
                      String(intent.invocationId),
                    ),
                  ),
                );
              if (recorded === "ExecutionStopping") {
                return yield* persistNoEffectInterruption(
                  Option.isSome(current)
                    ? {
                        invocationId: intent.invocationId,
                        executionId: context.executionId,
                        workspaceId: context.workspaceId,
                        toolName: intent.toolName,
                        toolVersion: intent.toolVersion,
                        sideEffectSemantics,
                        argumentsJson: intent.argumentsJson,
                        resolvedRegions,
                        approvalId:
                          context.executableApproval?.approvalId ??
                          intent.approvalId,
                        intentAt: current.value.intentAt,
                      }
                    : undefined,
                  settledAt,
                );
              }
              return denied(
                recorded.settlement?._tag === "Denied"
                  ? recorded.settlement.reasonCode
                  : reasonCode,
              );
            });
          const prior = yield* findInvocationFenced(
            intent.invocationId,
            context,
            "IntentJournal",
          );
          const priorRecord = Option.isSome(prior) ? prior.value : undefined;
          const priorModelIdentityMatches =
            priorRecord !== undefined &&
            priorRecord.invocationId === intent.invocationId &&
            priorRecord.executionId === context.executionId &&
            priorRecord.workspaceId === context.workspaceId &&
            priorRecord.toolName === intent.toolName &&
            priorRecord.toolVersion === intent.toolVersion &&
            priorRecord.sideEffectSemantics ===
              definition.sideEffectSemantics &&
            priorRecord.argumentsJson === intent.argumentsJson &&
            priorRecord.approvalId === intent.approvalId &&
            (context.executableApproval === undefined ||
              context.executableApproval.approvalId === priorRecord.approvalId);
          if (priorRecord !== undefined && !priorModelIdentityMatches) {
            return yield* Effect.fail<ToolRuntimeError>(
              operationalFailure(
                "IntentJournal",
                String(intent.invocationId),
              )({ _tag: "ToolInvocationIdentityConflict" }),
            );
          }
          const terminalP39ReceiptCandidate =
            priorRecord !== undefined &&
            priorModelIdentityMatches &&
            priorRecord.settlement !== null &&
            priorRecord.sideEffectSemantics === "Reconcilable" &&
            priorRecord.effectAdmissionState === "MayHaveStarted" &&
            definition.sideEffectSemantics === "Reconcilable" &&
            trustedProfile !== undefined &&
            trustedEffectKey !== null &&
            Option.isSome(p39Recovery) &&
            Option.isSome(p39RecoveryEvidence) &&
            Option.isSome(observationEvidence) &&
            priorRecord.approvalId === intent.approvalId &&
            (context.executableApproval === undefined ||
              context.executableApproval.approvalId === priorRecord.approvalId);
          if (terminalP39ReceiptCandidate && priorRecord !== undefined) {
            const receipt = yield* decodeRecordedEvidenceResult(
              intent,
              context,
              priorRecord,
              {
                allowMissingSelected: true,
                definition,
                profile: trustedProfile,
                effectKey: trustedEffectKey as string,
              },
            );
            if (receipt._tag !== "NotP39Receipt") return receipt;
          }
          const exactReconcilableReplayCandidate =
            priorModelIdentityMatches &&
            priorRecord.settlement === null &&
            priorRecord.effectAdmissionState === "MayHaveStarted" &&
            priorRecord.sideEffectSemantics === "Reconcilable" &&
            definition.sideEffectSemantics === "Reconcilable" &&
            trustedProfile !== undefined &&
            Option.isSome(p39Recovery) &&
            Option.isSome(reconciliationPort) &&
            Option.isSome(reconciliationFacts) &&
            Option.isSome(observationEvidence);
          let verifiedReplayBinding:
            | import("@arbor/ports").VerifiedRecoveryBindingV1
            | undefined;
          if (exactReconcilableReplayCandidate && priorRecord !== undefined) {
            const identity = context.recoveryBindingIdentity;
            if (Option.isNone(p39Recovery)) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "RecoveryBinding",
                  String(intent.invocationId),
                )({ _tag: "P39RecoveryEvidenceStoreUnavailable" }),
              );
            }
            const stored = yield* tx
              .transact(
                Effect.gen(function* () {
                  yield* observationEvidence.value.assertCurrentFence(
                    context.executionFence,
                    yield* clock.now(),
                  );
                  const binding = yield* p39Recovery.value.findBinding(
                    intent.invocationId,
                  );
                  const attempt = yield* p39Recovery.value.findLatestAttempt(
                    intent.invocationId,
                  );
                  return { binding, attempt };
                }),
              )
              .pipe(
                Effect.mapError(
                  operationalFailure(
                    "RecoveryBinding",
                    String(intent.invocationId),
                  ),
                ),
              );
            if (
              Option.isNone(stored.binding) ||
              Option.isNone(stored.attempt)
            ) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "RecoveryBinding",
                  String(intent.invocationId),
                )({ _tag: "RecoveryBindingReplayMismatch" }),
              );
            }
            const bound = stored.binding.value;
            const verified = verifyRecoveryBindingV1({
              invocationId: intent.invocationId,
              canonicalJson: bound.canonicalJson,
              bindingSha256: bound.bindingSha256,
            });
            const binding = verified?.value;
            const expectedArgumentsDigest = (() => {
              try {
                return canonicalArgumentsDigestV1(
                  JSON.parse(intent.argumentsJson),
                );
              } catch {
                return null;
              }
            })();
            const attempt = stored.attempt.value;
            const bindingMatchesIdentity =
              identity !== undefined &&
              binding !== undefined &&
              binding.executionId === context.executionId &&
              binding.invocationId === intent.invocationId &&
              binding.providerTurnId === identity.providerTurnId &&
              binding.logicalStepNo === identity.logicalStepNo &&
              binding.repairAttempt === identity.repairAttempt &&
              binding.logicalActionId === identity.logicalActionId &&
              binding.actionIndex === identity.actionIndex &&
              binding.callRef === intent.callRef &&
              binding.toolName === intent.toolName &&
              binding.toolVersion === intent.toolVersion &&
              binding.toolDefinitionHash ===
                recoveryBindingToolDefinitionHashV1(definition) &&
              binding.sideEffectSemantics === "Reconcilable" &&
              binding.canonicalArgumentsDigest === expectedArgumentsDigest &&
              binding.targetResourceIdentityDigest ===
                targetResourceIdentityDigestV1(priorRecord.resolvedRegions) &&
              binding.approvalId === priorRecord.approvalId &&
              binding.approvalId ===
                (context.executableApproval?.approvalId ?? intent.approvalId) &&
              (binding.approvalId === null ||
                binding.approvalConsumedBy === intent.invocationId) &&
              attempt.invocationId === intent.invocationId &&
              attempt.admissionState === "MayHaveStarted" &&
              attempt.sideEffectSemantics === "Reconcilable" &&
              attempt.bindingSha256 === bound.bindingSha256 &&
              attempt.toolDefinitionHash === binding.toolDefinitionHash &&
              binding.profileId === attempt.profileId &&
              binding.profileVersion === attempt.profileVersion &&
              binding.profileHash === attempt.profileHash &&
              binding.profileProtocol === attempt.profileProtocol &&
              binding.effectKey === attempt.effectKey;
            if (verified === null || !bindingMatchesIdentity) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "RecoveryBinding",
                  String(intent.invocationId),
                )({ _tag: "RecoveryBindingReplayMismatch" }),
              );
            }
            const currentProfileMatchesPersistedAttempt =
              trustedProfile !== undefined &&
              trustedEffectKey !== null &&
              binding.profileId === trustedProfile.profileId &&
              binding.profileVersion === trustedProfile.profileVersion &&
              binding.profileHash === trustedProfile.profileHash &&
              binding.profileProtocol === trustedProfile.profileProtocol &&
              binding.effectKey === trustedEffectKey &&
              attempt.profileId === trustedProfile.profileId &&
              attempt.profileVersion === trustedProfile.profileVersion &&
              attempt.profileHash === trustedProfile.profileHash &&
              attempt.profileProtocol === trustedProfile.profileProtocol &&
              attempt.effectKey === trustedEffectKey;
            if (!currentProfileMatchesPersistedAttempt) {
              return {
                _tag: "OutcomeUnknown" as const,
                reconciliationRefs: [String(intent.invocationId)],
              };
            }
            verifiedReplayBinding = verified;
          }
          const mountRefs = requestedMountRefs(intent.argumentsJson);
          let address: FilesystemAddress | undefined;
          let addresses: ReadonlyArray<ResourceAddress>;
          let boundaryWorkspace: Workspace | undefined;
          if (mountRefs.length > 0) {
            if (
              mountRefs.length !== 1 ||
              mountRefs.some((mount) => mount !== "workspace")
            ) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                [],
                "ResourceResolutionDenied",
              );
            }
            if (Option.isNone(workspaces)) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                [],
                "ResourceResolutionDenied",
              );
            }
            const workspace = yield* tx
              .transact(workspaces.value.findById(context.workspaceId))
              .pipe(
                Effect.mapError(
                  operationalFailure(
                    "WorkspaceLookup",
                    String(intent.invocationId),
                  ),
                ),
              );
            if (Option.isNone(workspace)) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                [],
                "ResourceResolutionDenied",
              );
            }
            boundaryWorkspace = workspace.value;
            address = primaryFilesystemAddress(
              workspace.value.resourceBoundary.addresses,
            );
            if (address === undefined) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                [],
                "ResourceResolutionDenied",
              );
            }
            addresses = [address];
          } else {
            addresses = legacyResourceArguments(intent.argumentsJson);
          }
          if (boundaryWorkspace === undefined) {
            if (Option.isNone(workspaces)) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                [],
                "ResourceResolutionDenied",
              );
            }
            const workspace = yield* tx
              .transact(workspaces.value.findById(context.workspaceId))
              .pipe(
                Effect.mapError(
                  operationalFailure(
                    "WorkspaceLookup",
                    String(intent.invocationId),
                  ),
                ),
              );
            if (
              Option.isNone(workspace) ||
              workspace.value.projectId !== context.projectId
            ) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                [],
                "ResourceResolutionDenied",
              );
            }
            boundaryWorkspace = workspace.value;
          }
          const capturedWorkspace = boundaryWorkspace;
          if (capturedWorkspace.projectId !== context.projectId) {
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              [],
              "ResourceResolutionDenied",
            );
          }
          const resolved = yield* environment
            .resolve(context.projectId, addresses)
            .pipe(
              Effect.mapError(
                operationalFailure(
                  "EnvironmentResolution",
                  String(intent.invocationId),
                ),
              ),
            );
          const resolvedBoundary = yield* environment
            .resolve(
              context.projectId,
              capturedWorkspace.resourceBoundary.addresses,
            )
            .pipe(
              Effect.mapError(
                operationalFailure(
                  "EnvironmentResolution",
                  String(intent.invocationId),
                ),
              ),
            );
          if (
            resolved.observedEnvironmentRevision !==
            resolvedBoundary.observedEnvironmentRevision
          ) {
            return yield* refreshAfterStale({
              _tag: "ResourceResolutionStale",
              observed: resolved.observedEnvironmentRevision,
              boundaryObserved: resolvedBoundary.observedEnvironmentRevision,
            });
          }
          const regions = resolved.regions;
          const boundaryRegions = resolvedBoundary.regions;
          const validateCapturedSnapshot = () =>
            Effect.gen(function* () {
              if (Option.isNone(workspaces)) {
                return yield* Effect.fail(P39_RESOURCE_RESOLUTION_STALE);
              }
              const currentWorkspace = yield* workspaces.value.findById(
                context.workspaceId,
              );
              if (
                Option.isNone(currentWorkspace) ||
                currentWorkspace.value.projectId !== context.projectId ||
                currentWorkspace.value.resourceBoundaryRevision !==
                  capturedWorkspace.resourceBoundaryRevision ||
                JSON.stringify(
                  currentWorkspace.value.resourceBoundary.addresses,
                ) !==
                  JSON.stringify(capturedWorkspace.resourceBoundary.addresses)
              ) {
                return yield* Effect.fail(P39_RESOURCE_RESOLUTION_STALE);
              }
              if (p39BindingEnabled) {
                if (Option.isNone(environmentRevisions)) {
                  return yield* Effect.fail<ToolRuntimeError>(
                    operationalFailure(
                      "RecoveryBinding",
                      String(intent.invocationId),
                    )({ _tag: "EnvironmentRevisionStoreUnavailable" }),
                  );
                }
                const currentEnvironment = yield* environmentRevisions.value
                  .current(context.projectId)
                  .pipe(
                    Effect.mapError(
                      operationalFailure(
                        "RecoveryBinding",
                        String(intent.invocationId),
                      ),
                    ),
                  );
                if (
                  (Option.isSome(currentEnvironment) &&
                    currentEnvironment.value !==
                      resolved.observedEnvironmentRevision) ||
                  (Option.isNone(currentEnvironment) &&
                    resolved.observedEnvironmentRevision !== "0")
                ) {
                  return yield* Effect.fail(P39_RESOURCE_RESOLUTION_STALE);
                }
              }
              return undefined;
            });
          const validateCapturedSnapshotAndAdmit = () =>
            Effect.gen(function* () {
              yield* validateCapturedSnapshot();
              return yield* admission.admit({
                workspaceId: context.workspaceId,
                regions,
                resolvedBoundaryRegions: boundaryRegions,
                write: executor.write,
              });
            });
          const checkCapturedSnapshotAndAdmit = () =>
            tx
              .transact(validateCapturedSnapshotAndAdmit())
              .pipe(
                Effect.mapError((cause) =>
                  isP39ResourceResolutionStale(cause)
                    ? cause
                    : operationalFailure(
                        "ResourceAdmission",
                        String(intent.invocationId),
                      )(cause),
                ),
              );
          const region = regions[0];
          if (
            address !== undefined &&
            (region === undefined || regions.length !== 1) &&
            verifiedReplayBinding === undefined
          ) {
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              [],
              "ResourceResolutionDenied",
            );
          }

          const resolvedAuthorityFromCurrent = Option.isSome(authorityResolver)
            ? yield* authorityResolver.value
                .resolve({
                  intent,
                  definition,
                  context,
                  regions,
                  now,
                })
                .pipe(
                  Effect.catchTag("ToolAuthorityDenied", () =>
                    Effect.succeed(undefined),
                  ),
                  Effect.mapError(
                    operationalFailure(
                      "AuthorityResolution",
                      String(intent.invocationId),
                    ),
                  ),
                )
            : context.authority;
          if (
            resolvedAuthorityFromCurrent === undefined &&
            verifiedReplayBinding === undefined
          ) {
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              "InvocationAuthorityDenied",
            );
          }
          const resolvedAuthority =
            resolvedAuthorityFromCurrent ??
            context.authority ??
            ({
              principal: context.authenticatedPrincipal,
              workspaceId: context.workspaceId,
              executionId: context.executionId,
              toolName: intent.toolName,
              toolVersion: intent.toolVersion,
              resourceSpaceIds: regions.map((item) => item.resourceSpaceId),
              allowedCapabilities: definition.capabilityMetadata,
              controlBasisDigest: context.controlBasisDigest,
              expiresAt: context.requestedAt,
              delegationDepth: context.delegationDepth ?? 0,
            } as NonNullable<ToolExecutionContext["authority"]>);
          const authority = checkInvocationAuthority({
            authority: resolvedAuthority,
            definition,
            intent,
            context,
            regions,
            now,
            maxDelegationDepth: options.maxDelegationDepth ?? 1,
          });
          if (
            authority._tag === "Denied" &&
            verifiedReplayBinding === undefined
          ) {
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              "InvocationAuthorityDenied",
            );
          }

          const needsApproval = executor.requiresApproval(intent);
          let approvalAlreadyConsumedBySelf = false;
          let currentApprovalRecord: ExecutableApprovalRecord | undefined;
          if (verifiedReplayBinding !== undefined) {
            approvalAlreadyConsumedBySelf = needsApproval;
          }
          if (
            verifiedReplayBinding === undefined &&
            !needsApproval &&
            context.executableApproval !== undefined
          ) {
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              "ApprovalMismatch",
            );
          }
          if (verifiedReplayBinding === undefined && needsApproval) {
            if (context.executableApproval === undefined) {
              const legacyApprovalId = intent.approvalId;
              if (p39BindingEnabled && legacyApprovalId !== null) {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  "ApprovalMismatch",
                );
              }
              if (legacyApprovalId === null) {
                return {
                  _tag: "ApprovalRequired" as const,
                  authority: resolvedAuthority,
                  targetResourceSpaceIds: regions.map(
                    (region) => region.resourceSpaceId,
                  ),
                  actionDigest: actionDigestOf(intent),
                  requestedCapabilities: definition.capabilityMetadata,
                  sideEffectSemantics: definition.sideEffectSemantics,
                  controlBasisDigest: context.controlBasisDigest,
                };
              }
              const legacyApproval = yield* tx
                .transact(store.findApproval(legacyApprovalId))
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "ApprovalLookup",
                      String(intent.invocationId),
                    ),
                  ),
                );
              if (Option.isNone(legacyApproval)) {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  "ApprovalNotFound",
                );
              }
              if (legacyApproval.value.consumedBy === intent.invocationId) {
                const priorInvocation = yield* tx
                  .transact(store.findById(intent.invocationId))
                  .pipe(
                    Effect.mapError(
                      operationalFailure(
                        "ApprovalLookup",
                        String(intent.invocationId),
                      ),
                    ),
                  );
                if (Option.isNone(priorInvocation)) {
                  return yield* recordNoEffectDenial(
                    definition.sideEffectSemantics,
                    regions,
                    "ApprovalConsumedByOtherInvocation",
                  );
                }
                approvalAlreadyConsumedBySelf = true;
              }
              const matched = matchApproval({
                approval: legacyApproval.value,
                intent,
                definition,
                context,
                regions,
                now,
                replayOfRecordedInvocation: approvalAlreadyConsumedBySelf,
              });
              if (matched._tag === "Denied") {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  approvalDenialCode(matched.reason),
                );
              }
            } else {
              if (intent.approvalId !== context.executableApproval.approvalId) {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  "ApprovalMismatch",
                );
              }
              if (Option.isNone(executableApprovals)) {
                return yield* Effect.fail(
                  operationalFailure(
                    "ApprovalLookup",
                    String(intent.invocationId),
                  )({
                    _tag: "ExecutableApprovalStoreUnavailable",
                  }),
                );
              }
              const exactExecutableApproval = yield* tx
                .transact(
                  executableApprovals.value.findById(
                    context.executableApproval.approvalId,
                  ),
                )
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "ApprovalLookup",
                      String(intent.invocationId),
                    ),
                  ),
                );
              if (Option.isSome(exactExecutableApproval)) {
                const currentApproval = exactExecutableApproval.value;
                currentApprovalRecord = currentApproval;
                if (currentApproval.state === "Pending") {
                  if (
                    context.executableApproval.state !== "Pending" ||
                    currentApproval.revision !==
                      context.executableApproval.expectedRevision ||
                    !executableApprovalBindingMatches(
                      currentApproval,
                      context.executableApproval.binding,
                    )
                  ) {
                    return yield* recordNoEffectDenial(
                      definition.sideEffectSemantics,
                      regions,
                      "ApprovalMismatch",
                    );
                  }
                  return {
                    _tag: "ApprovalRequired" as const,
                    authority: resolvedAuthority,
                    targetResourceSpaceIds: regions.map(
                      (region) => region.resourceSpaceId,
                    ),
                    actionDigest: actionDigestOf(intent),
                    requestedCapabilities: definition.capabilityMetadata,
                    sideEffectSemantics: definition.sideEffectSemantics,
                    controlBasisDigest: context.controlBasisDigest,
                  };
                }
                if (currentApproval.state === "Cancelled") {
                  return { _tag: "Interrupted" as const };
                }
                const terminalDenial = executableApprovalTerminalDenial(
                  currentApproval,
                  now,
                );
                if (terminalDenial !== null) {
                  return yield* recordNoEffectDenial(
                    definition.sideEffectSemantics,
                    regions,
                    terminalDenial,
                  );
                }
                if (
                  currentApproval.state === "Consumed" &&
                  currentApproval.consumedBy === intent.invocationId
                ) {
                  const priorInvocation = yield* tx
                    .transact(store.findById(intent.invocationId))
                    .pipe(
                      Effect.mapError(
                        operationalFailure(
                          "ApprovalLookup",
                          String(intent.invocationId),
                        ),
                      ),
                    );
                  if (Option.isSome(priorInvocation)) {
                    approvalAlreadyConsumedBySelf = true;
                  }
                }
              }
              if (
                Option.isNone(exactExecutableApproval) ||
                exactExecutableApproval.value.routeKind !== "Executable" ||
                (exactExecutableApproval.value.state !==
                  context.executableApproval.state &&
                  !approvalAlreadyConsumedBySelf) ||
                !(
                  (exactExecutableApproval.value.state === "Approved" &&
                    exactExecutableApproval.value.revision ===
                      context.executableApproval.expectedRevision) ||
                  (approvalAlreadyConsumedBySelf &&
                    exactExecutableApproval.value.state === "Consumed" &&
                    exactExecutableApproval.value.revision ===
                      context.executableApproval.expectedRevision + 1)
                ) ||
                exactExecutableApproval.value.expiresAt <= now ||
                !executableApprovalBindingMatches(
                  exactExecutableApproval.value,
                  context.executableApproval.binding,
                )
              ) {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  exactExecutableApproval._tag === "Some" &&
                    exactExecutableApproval.value.expiresAt <= now
                    ? "ApprovalExpired"
                    : "ApprovalMismatch",
                );
              }
              if (intent.approvalId !== context.executableApproval.approvalId) {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  "ApprovalMismatch",
                );
              }
            }
          }
          if (
            p39BindingEnabled &&
            context.executableApproval !== undefined &&
            !recoveryBindingIdentityMatches({
              identity: context.recoveryBindingIdentity,
              executionId: context.executionId,
              invocationId: intent.invocationId,
              callRef: intent.callRef,
              approvalBinding: context.executableApproval.binding,
            })
          ) {
            return yield* Effect.fail<ToolRuntimeError>(
              operationalFailure(
                "RecoveryBinding",
                String(intent.invocationId),
              )({ _tag: "RecoveryBindingApprovalSourceMismatch" }),
            );
          }

          let recoveredToolOutcome: ToolExecutionResult | undefined;
          let pendingReconciliation:
            | {
                readonly request: ToolReconciliationRequest;
                readonly result: Exclude<
                  ToolReconciliationResult,
                  { readonly _tag: "StillUnknown" }
                >;
                readonly observedAt: string;
                readonly selection: {
                  readonly attemptNo: 0 | 1;
                  readonly factId: string;
                };
              }
            | undefined;
          let retryAdmitted = false;
          if (options.qualificationProbe !== undefined) {
            const priorRecord = Option.isSome(prior) ? prior.value : undefined;
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "P38StopInvocationLookup",
                  executionId: context.executionId,
                  invocationId: intent.invocationId,
                  callRef: intent.callRef,
                  ...((context.logicalActionId ??
                    context.recoveryBindingIdentity?.logicalActionId) ===
                  undefined
                    ? {}
                    : {
                        logicalActionId:
                          context.logicalActionId ??
                          context.recoveryBindingIdentity?.logicalActionId,
                      }),
                  inputHash: canonicalArgumentsDigestV1(intent.argumentsJson),
                  toolName: intent.toolName,
                  toolVersion: intent.toolVersion,
                  fencingGeneration: context.executionFence.fencingGeneration,
                  priorFound: priorRecord !== undefined,
                  priorIdentityMatches:
                    priorRecord === undefined
                      ? false
                      : priorRecord.executionId === context.executionId &&
                        priorRecord.toolName === intent.toolName &&
                        priorRecord.toolVersion === intent.toolVersion &&
                        priorRecord.argumentsJson === intent.argumentsJson &&
                        priorRecord.approvalId === intent.approvalId,
                  priorEffectAdmissionState:
                    priorRecord?.effectAdmissionState ?? null,
                  priorSettlementKind: priorRecord?.settlement?._tag ?? null,
                }) ?? Promise.resolve(),
            );
          }
          if (Option.isSome(prior)) {
            const recorded = prior.value;
            let replayBindingValue: RecoveryBindingV1 | undefined;
            let replayBindingSha256: string | undefined;
            const sameIntent =
              recorded.executionId === context.executionId &&
              recorded.workspaceId === context.workspaceId &&
              recorded.toolName === intent.toolName &&
              recorded.toolVersion === intent.toolVersion &&
              recorded.sideEffectSemantics === definition.sideEffectSemantics &&
              recorded.argumentsJson === intent.argumentsJson &&
              recorded.approvalId === intent.approvalId;
            if (
              !sameIntent ||
              (verifiedReplayBinding === undefined &&
                JSON.stringify(recorded.resolvedRegions) !==
                  JSON.stringify(regions))
            ) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "IntentJournal",
                  String(intent.invocationId),
                )({
                  _tag: "ToolInvocationIdentityConflict",
                }),
              );
            }
            if (
              recorded.settlement === null &&
              recorded.sideEffectSemantics === "Reconcilable" &&
              recorded.effectAdmissionState !== "NotAdmitted" &&
              trustedProfile === undefined
            ) {
              // Historical shell@2 and any other profile-less legacy row are
              // ambiguous external effects. Do not synthesize P39 identity or
              // enter the Executor path during recovery.
              return {
                _tag: "OutcomeUnknown" as const,
                reconciliationRefs: [String(intent.invocationId)],
              };
            }
            if (verifiedReplayBinding !== undefined) {
              replayBindingValue = verifiedReplayBinding.value;
              replayBindingSha256 = verifiedReplayBinding.bindingSha256;
            } else {
              const replayAdmission = yield* Effect.match(
                checkCapturedSnapshotAndAdmit(),
                {
                  onFailure: (cause) => ({ ok: false as const, cause }),
                  onSuccess: (value) => ({ ok: true as const, value }),
                },
              );
              if (!replayAdmission.ok) {
                if (isP39ResourceResolutionStale(replayAdmission.cause)) {
                  return yield* refreshAfterStale(replayAdmission.cause);
                }
                return yield* Effect.fail<ToolRuntimeError>(
                  replayAdmission.cause as ToolRuntimeError,
                );
              }
              if (replayAdmission.value._tag === "Denied") {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  "ResourceAdmissionDenied",
                );
              }
            }
            if (
              verifiedReplayBinding === undefined &&
              p39BindingEnabled &&
              Option.isSome(p39Recovery)
            ) {
              const approvalSnapshot = needsApproval
                ? recoveryApprovalSnapshotFromRecord(
                    currentApprovalRecord,
                    intent.invocationId,
                  )
                : null;
              if (needsApproval && approvalSnapshot === null) {
                return yield* Effect.fail<ToolRuntimeError>(
                  operationalFailure(
                    "RecoveryBinding",
                    String(intent.invocationId),
                  )({ _tag: "ConsumedApprovalSourceUnavailable" }),
                );
              }
              let expectedBinding: RecoveryBindingV1;
              try {
                expectedBinding = makeRecoveryBindingV1({
                  context,
                  intent,
                  definition,
                  authority: resolvedAuthority,
                  regions,
                  resourceBoundaryRevision:
                    capturedWorkspace.resourceBoundaryRevision,
                  environmentRevision: resolved.observedEnvironmentRevision,
                  approval: approvalSnapshot,
                  ...(trustedProfile === undefined
                    ? {}
                    : {
                        profile: trustedProfile,
                        effectKey: trustedEffectKey,
                      }),
                });
              } catch (cause) {
                return yield* Effect.fail<ToolRuntimeError>(
                  operationalFailure(
                    "RecoveryBinding",
                    String(intent.invocationId),
                  )(cause),
                );
              }
              const bound = yield* tx
                .transact(
                  Effect.gen(function* () {
                    if (Option.isSome(observationEvidence)) {
                      yield* observationEvidence.value.assertCurrentFence(
                        context.executionFence,
                        yield* clock.now(),
                      );
                    }
                    return yield* p39Recovery.value.findBinding(
                      intent.invocationId,
                    );
                  }),
                )
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "RecoveryBinding",
                      String(intent.invocationId),
                    ),
                  ),
                );
              if (
                Option.isNone(bound) ||
                bound.value.canonicalJson !==
                  canonicalizeRecoveryBindingV1(expectedBinding) ||
                bound.value.bindingSha256 !==
                  recoveryBindingV1Digest(expectedBinding)
              ) {
                return yield* Effect.fail<ToolRuntimeError>(
                  operationalFailure(
                    "RecoveryBinding",
                    String(intent.invocationId),
                  )({ _tag: "RecoveryBindingReplayMismatch" }),
                );
              }
              replayBindingValue = bound.value.value;
              replayBindingSha256 = bound.value.bindingSha256;
            }
            if (
              recorded.settlement === null &&
              recorded.effectAdmissionState === "MayHaveStarted" &&
              recorded.sideEffectSemantics === "Reconcilable"
            ) {
              if (
                trustedProfile === undefined ||
                replayBindingValue === undefined ||
                replayBindingSha256 === undefined ||
                !Option.isSome(p39Recovery) ||
                !Option.isSome(reconciliationPort) ||
                !Option.isSome(reconciliationFacts) ||
                !Option.isSome(observationEvidence)
              ) {
                return {
                  _tag: "OutcomeUnknown" as const,
                  reconciliationRefs: [String(intent.invocationId)],
                };
              }
              const latestAttempt = yield* tx
                .transact(
                  Effect.gen(function* () {
                    yield* observationEvidence.value.assertCurrentFence(
                      context.executionFence,
                      yield* clock.now(),
                    );
                    return yield* p39Recovery.value.findLatestAttempt(
                      intent.invocationId,
                    );
                  }),
                )
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "RecoveryBinding",
                      String(intent.invocationId),
                    ),
                  ),
                );
              if (Option.isNone(latestAttempt)) {
                return {
                  _tag: "OutcomeUnknown" as const,
                  reconciliationRefs: [String(intent.invocationId)],
                };
              }
              const attempt = latestAttempt.value;
              if (
                attempt.admissionState !== "MayHaveStarted" ||
                attempt.bindingSha256 !== replayBindingSha256 ||
                attempt.profileId !== trustedProfile.profileId ||
                attempt.profileVersion !== trustedProfile.profileVersion ||
                attempt.profileHash !== trustedProfile.profileHash ||
                attempt.profileProtocol !== trustedProfile.profileProtocol ||
                attempt.effectKey === null ||
                trustedEffectKey === null ||
                attempt.effectKey !== trustedEffectKey
              ) {
                return {
                  _tag: "OutcomeUnknown" as const,
                  reconciliationRefs: [String(intent.invocationId)],
                };
              }
              const request: ToolReconciliationRequest = {
                invocationId: intent.invocationId,
                attemptNo: attempt.attemptNo,
                bindingSha256: replayBindingSha256,
                profileHash: trustedProfile.profileHash,
                effectKey: attempt.effectKey,
                visibilityScopeSha256:
                  replayBindingValue.targetResourceIdentityDigest,
              };
              yield* tx
                .transact(
                  observationEvidence.value.assertCurrentFence(
                    context.executionFence,
                    yield* clock.now(),
                  ),
                )
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "RecoveryBinding",
                      String(intent.invocationId),
                    ),
                  ),
                );
              const portResult = yield* Effect.match(
                reconciliationPort.value.reconcile(request),
                {
                  onFailure: () => ({
                    _tag: "StillUnknown" as const,
                    reasonCode: "ExternalSourceUnavailable" as const,
                    evidenceRef: null,
                  }),
                  onSuccess: (value) =>
                    validateToolReconciliationResult(request, value)
                      ? value
                      : {
                          _tag: "StillUnknown" as const,
                          reasonCode: "EvidenceBindingMismatch" as const,
                          evidenceRef: null,
                        },
                },
              );
              const persistUnknownFact = (
                result: Extract<
                  ToolReconciliationResult,
                  { readonly _tag: "StillUnknown" }
                >,
                observedAt: string,
              ) =>
                tx.transact(
                  Effect.gen(function* () {
                    const fenceNow = yield* clock.now();
                    yield* observationEvidence.value.assertCurrentFence(
                      context.executionFence,
                      fenceNow,
                    );
                    yield* probeReconciliation(
                      "AH7BeforeReconciliationFactCommit",
                      {
                        attemptNo: request.attemptNo,
                        outcomeTag: result._tag,
                      },
                    );
                    yield* reconciliationFacts.value.record(
                      request,
                      result,
                      observedAt,
                    );
                  }),
                );
              if (portResult._tag === "StillUnknown") {
                const observedAt = yield* clock.now();
                yield* persistUnknownFact(portResult, observedAt).pipe(
                  Effect.mapError(
                    operationalFailure(
                      "SettlementJournal",
                      String(intent.invocationId),
                    ),
                  ),
                );
                yield* probeReconciliation("AH7AfterReconciliationFactCommit", {
                  attemptNo: request.attemptNo,
                  outcomeTag: portResult._tag,
                });
                return {
                  _tag: "OutcomeUnknown" as const,
                  reconciliationRefs: [String(intent.invocationId)],
                };
              }
              const observedAt = portResult.proof.observedAt;
              const factId = reconciliationFactId({
                request,
                result: portResult,
                factDisposition: "RecoveryInput",
                evidenceSha256: portResult.proof.evidenceSha256,
              });
              if (portResult._tag === "NotOccurred") {
                if (attempt.attemptNo === 0) {
                  const retryGate = yield* tx
                    .transact(
                      Effect.gen(function* () {
                        const gateNow = yield* clock.now();
                        yield* observationEvidence.value.assertCurrentFence(
                          context.executionFence,
                          gateNow,
                        );
                        yield* probeReconciliation(
                          "AH7BeforeReconciliationFactCommit",
                          {
                            attemptNo: request.attemptNo,
                            outcomeTag: portResult._tag,
                            factId,
                          },
                        );
                        const fact = yield* reconciliationFacts.value.record(
                          request,
                          portResult,
                          observedAt,
                        );
                        if (fact.factId !== factId) {
                          return yield* Effect.fail({
                            _tag: "P39ReconciliationFactIdentityMismatch",
                          });
                        }

                        const snapshotAdmission = yield* Effect.match(
                          Effect.gen(function* () {
                            yield* validateCapturedSnapshot();
                            if (
                              replayBindingValue === undefined ||
                              targetResourceIdentityDigestV1(regions) !==
                                replayBindingValue.targetResourceIdentityDigest ||
                              capturedWorkspace.resourceBoundaryRevision !==
                                replayBindingValue.resourceBoundaryRevision ||
                              resolved.observedEnvironmentRevision !==
                                replayBindingValue.environmentRevision
                            ) {
                              return {
                                _tag: "Denied" as const,
                                reason: "RecoveryBindingSnapshotChanged",
                              };
                            }
                            return yield* admission.admit({
                              workspaceId: context.workspaceId,
                              regions,
                              resolvedBoundaryRegions: boundaryRegions,
                              write: executor.write,
                            });
                          }),
                          {
                            onFailure: (cause) =>
                              isP39ResourceResolutionStale(cause)
                                ? { _tag: "ResourceSnapshotChanged" as const }
                                : { _tag: "Failure" as const, cause },
                            onSuccess: (value) =>
                              value._tag === "Denied"
                                ? { _tag: "ResourceSnapshotChanged" as const }
                                : { _tag: "Admitted" as const },
                          },
                        );
                        if (snapshotAdmission._tag === "Failure") {
                          return yield* Effect.fail(
                            operationalFailure(
                              "ResourceAdmission",
                              String(intent.invocationId),
                            )(snapshotAdmission.cause),
                          );
                        }
                        if (snapshotAdmission._tag !== "Admitted") {
                          return snapshotAdmission;
                        }

                        const currentAuthority = Option.isSome(
                          authorityResolver,
                        )
                          ? yield* authorityResolver.value
                              .resolve({
                                intent,
                                definition,
                                context,
                                regions,
                                now: gateNow,
                              })
                              .pipe(
                                Effect.catchTag("ToolAuthorityDenied", () =>
                                  Effect.succeed(undefined),
                                ),
                                Effect.mapError(
                                  operationalFailure(
                                    "AuthorityResolution",
                                    String(intent.invocationId),
                                  ),
                                ),
                              )
                          : context.authority;
                        if (
                          currentAuthority === undefined ||
                          checkInvocationAuthority({
                            authority: currentAuthority,
                            definition,
                            intent,
                            context,
                            regions,
                            now: gateNow,
                            maxDelegationDepth: options.maxDelegationDepth ?? 1,
                          })._tag === "Denied"
                        ) {
                          return {
                            _tag: "AuthoritySnapshotChanged" as const,
                          };
                        }

                        if (
                          needsApproval &&
                          intent.approvalId !== null &&
                          context.executableApproval !== undefined
                        ) {
                          if (Option.isNone(executableApprovals)) {
                            return {
                              _tag: "ApprovalNoLongerAuthorized" as const,
                            };
                          }
                          const currentApproval =
                            yield* executableApprovals.value
                              .findById(context.executableApproval.approvalId)
                              .pipe(
                                Effect.mapError(
                                  operationalFailure(
                                    "ApprovalLookup",
                                    String(intent.invocationId),
                                  ),
                                ),
                              );
                          if (
                            Option.isNone(currentApproval) ||
                            currentApproval.value.state !== "Consumed" ||
                            currentApproval.value.consumedBy !==
                              intent.invocationId ||
                            currentApproval.value.revision !==
                              context.executableApproval.expectedRevision + 1 ||
                            currentApproval.value.expiresAt <= gateNow ||
                            !executableApprovalBindingMatches(
                              currentApproval.value,
                              context.executableApproval.binding,
                            )
                          ) {
                            return {
                              _tag: "ApprovalNoLongerAuthorized" as const,
                            };
                          }
                        } else if (
                          needsApproval &&
                          intent.approvalId !== null &&
                          context.executableApproval === undefined
                        ) {
                          const approval = yield* store
                            .findApproval(intent.approvalId)
                            .pipe(
                              Effect.mapError(
                                operationalFailure(
                                  "ApprovalLookup",
                                  String(intent.invocationId),
                                ),
                              ),
                            );
                          if (
                            Option.isNone(approval) ||
                            matchApproval({
                              approval: approval.value,
                              intent,
                              definition,
                              context,
                              regions,
                              now: gateNow,
                              replayOfRecordedInvocation: true,
                            })._tag === "Denied"
                          ) {
                            return {
                              _tag: "ApprovalNoLongerAuthorized" as const,
                            };
                          }
                        }

                        const admitted = yield* store.admitEffect(
                          intent.invocationId,
                          currentAuthority,
                          gateNow,
                          context.executionFence,
                        );
                        if (admitted._tag === "ExecutionStopping") {
                          return admitted;
                        }
                        if (admitted._tag === "Denied") {
                          return {
                            _tag: reconciliationRetryDenialReasonCode(
                              admitted.reasonCode,
                            ),
                          };
                        }
                        yield* p39Recovery.value.admitRetryAttempt({
                          invocationId: intent.invocationId,
                          factId,
                          admittedAt: gateNow,
                        });
                        return { _tag: "Admitted" as const };
                      }),
                    )
                    .pipe(
                      Effect.tapError((cause) =>
                        isLeaseFencingRejected(cause)
                          ? probeReconciliation(
                              "AH7ReconciliationResultFenceRejected",
                              {
                                attemptNo: request.attemptNo,
                                outcomeTag: portResult._tag,
                                factId,
                              },
                            ).pipe(Effect.catchCause(() => Effect.void))
                          : Effect.void,
                      ),
                      Effect.mapError(
                        operationalFailure(
                          "RecoveryBinding",
                          String(intent.invocationId),
                        ),
                      ),
                    );
                  yield* probeReconciliation(
                    "AH7AfterReconciliationFactCommit",
                    {
                      attemptNo: request.attemptNo,
                      outcomeTag: portResult._tag,
                      factId,
                    },
                  );
                  if (retryGate._tag === "Admitted") {
                    retryAdmitted = true;
                  } else {
                    recoveredToolOutcome = {
                      settlement: {
                        _tag: "ReconciledNoEffect",
                        reasonCode:
                          retryGate._tag === "ExecutionStopping"
                            ? "StopRequested"
                            : retryGate._tag,
                        reconciliationFactRef: factId,
                      },
                      observation: bounded(
                        "authoritative source confirmed that the effect attempt did not occur",
                      ),
                      resultRef: null,
                    };
                    pendingReconciliation = {
                      request,
                      result: portResult,
                      observedAt,
                      selection: { attemptNo: attempt.attemptNo, factId },
                    };
                  }
                } else {
                  const fact = yield* tx
                    .transact(
                      Effect.gen(function* () {
                        yield* observationEvidence.value.assertCurrentFence(
                          context.executionFence,
                          yield* clock.now(),
                        );
                        yield* probeReconciliation(
                          "AH7BeforeReconciliationFactCommit",
                          {
                            attemptNo: request.attemptNo,
                            outcomeTag: portResult._tag,
                            factId,
                          },
                        );
                        return yield* reconciliationFacts.value.record(
                          request,
                          portResult,
                          observedAt,
                        );
                      }),
                    )
                    .pipe(
                      Effect.mapError(
                        operationalFailure(
                          "SettlementJournal",
                          String(intent.invocationId),
                        ),
                      ),
                    );
                  yield* probeReconciliation(
                    "AH7AfterReconciliationFactCommit",
                    {
                      attemptNo: request.attemptNo,
                      outcomeTag: portResult._tag,
                      factId,
                    },
                  );
                  if (fact.factId !== factId) {
                    return yield* Effect.fail<ToolRuntimeError>(
                      operationalFailure(
                        "SettlementJournal",
                        String(intent.invocationId),
                      )({ _tag: "P39ReconciliationFactIdentityMismatch" }),
                    );
                  }
                  recoveredToolOutcome = {
                    settlement: {
                      _tag: "ReconciledNoEffect",
                      reasonCode: "ReplayLimitReached",
                      reconciliationFactRef: factId,
                    },
                    observation: bounded(
                      "authoritative source confirmed that the single retry did not occur",
                    ),
                    resultRef: null,
                  };
                  pendingReconciliation = {
                    request,
                    result: portResult,
                    observedAt,
                    selection: { attemptNo: attempt.attemptNo, factId },
                  };
                }
              } else {
                let resultBytes: Uint8Array | undefined;
                if (Option.isSome(artifactService)) {
                  try {
                    const resultArtifactId = parse(ArtifactId)(
                      portResult.resultRef,
                    );
                    const loaded = yield* tx
                      .transact(artifactService.value.load(resultArtifactId))
                      .pipe(
                        Effect.mapError(
                          operationalFailure(
                            "SettlementJournal",
                            String(intent.invocationId),
                          ),
                        ),
                      );
                    if (Option.isSome(loaded)) resultBytes = loaded.value;
                  } catch {
                    resultBytes = undefined;
                  }
                }
                const reconstructed =
                  resultBytes === undefined
                    ? null
                    : trustedProfile.reconstructOccurred({
                        bytes: resultBytes,
                        settlement: portResult.settlement,
                      });
                if (
                  reconstructed === null ||
                  reconstructed.settlement !== portResult.settlement
                ) {
                  const unknown = {
                    _tag: "StillUnknown" as const,
                    reasonCode: "ResultEvidenceUnavailable" as const,
                    evidenceRef: portResult.proof.evidenceRef,
                  };
                  const unknownAt = yield* clock.now();
                  yield* persistUnknownFact(unknown, unknownAt).pipe(
                    Effect.mapError(
                      operationalFailure(
                        "SettlementJournal",
                        String(intent.invocationId),
                      ),
                    ),
                  );
                  return {
                    _tag: "OutcomeUnknown" as const,
                    reconciliationRefs: [String(intent.invocationId)],
                  };
                }
                recoveredToolOutcome = {
                  settlement:
                    portResult.settlement === "Success"
                      ? { _tag: "Success" }
                      : { _tag: "ExpectedFailure" },
                  observation: reconstructed.observation,
                  resultRef:
                    portResult.settlement === "Success"
                      ? portResult.resultRef
                      : null,
                };
                const fact = yield* tx
                  .transact(
                    Effect.gen(function* () {
                      yield* observationEvidence.value.assertCurrentFence(
                        context.executionFence,
                        yield* clock.now(),
                      );
                      yield* probeReconciliation(
                        "AH7BeforeReconciliationFactCommit",
                        {
                          attemptNo: request.attemptNo,
                          outcomeTag: portResult._tag,
                          factId,
                        },
                      );
                      return yield* reconciliationFacts.value.record(
                        request,
                        portResult,
                        observedAt,
                      );
                    }),
                  )
                  .pipe(
                    Effect.mapError(
                      operationalFailure(
                        "SettlementJournal",
                        String(intent.invocationId),
                      ),
                    ),
                  );
                yield* probeReconciliation("AH7AfterReconciliationFactCommit", {
                  attemptNo: request.attemptNo,
                  outcomeTag: portResult._tag,
                  factId,
                });
                if (fact.factId !== factId) {
                  return yield* Effect.fail<ToolRuntimeError>(
                    operationalFailure(
                      "SettlementJournal",
                      String(intent.invocationId),
                    )({ _tag: "P39ReconciliationFactIdentityMismatch" }),
                  );
                }
                pendingReconciliation = {
                  request,
                  result: portResult,
                  observedAt,
                  selection: { attemptNo: attempt.attemptNo, factId },
                };
              }
            }
            if (recorded.settlement !== null) {
              if (recorded.settlement._tag === "Denied") {
                return denied(recorded.settlement.reasonCode);
              }
              if (
                recorded.settlement._tag === "Interrupted" &&
                Option.isNone(observationEvidence)
              ) {
                return { _tag: "Interrupted" as const };
              }
              if (Option.isSome(observationEvidence)) {
                return yield* decodeRecordedEvidence(intent, context, recorded);
              }
              if (
                recorded.settlement._tag === "Success" &&
                recorded.resultRef !== null &&
                Option.isSome(artifactService)
              ) {
                let artifactId: ArtifactId;
                try {
                  artifactId = parse(ArtifactId)(recorded.resultRef);
                } catch {
                  return {
                    _tag: "OutcomeUnknown" as const,
                    reconciliationRefs: [String(intent.invocationId)],
                  };
                }
                const bytes = yield* tx
                  .transact(artifactService.value.load(artifactId))
                  .pipe(
                    Effect.mapError(
                      operationalFailure(
                        "SettlementJournal",
                        String(intent.invocationId),
                      ),
                    ),
                  );
                if (Option.isSome(bytes)) {
                  return {
                    _tag: "Success" as const,
                    observation: bounded(new TextDecoder().decode(bytes.value)),
                    resultRef: recorded.resultRef,
                  };
                }
              }
              return {
                _tag: "OutcomeUnknown" as const,
                reconciliationRefs: [String(intent.invocationId)],
              };
            }
            if (
              recorded.effectAdmissionState !== "NotAdmitted" &&
              recoveredToolOutcome === undefined &&
              !retryAdmitted &&
              (recorded.sideEffectSemantics === "NonIdempotent" ||
                recorded.sideEffectSemantics === "Reconcilable")
            ) {
              const reconciliationRefs = [String(intent.invocationId)];
              if (recorded.sideEffectSemantics === "NonIdempotent") {
                const settledAt = yield* clock.now();
                const unknownWrite = yield* Effect.match(
                  tx.transact(
                    Effect.gen(function* () {
                      const applied = yield* store.settle(
                        intent.invocationId,
                        { _tag: "OutcomeUnknown", reconciliationRefs },
                        null,
                        settledAt,
                        context.executionFence,
                        context.executionFence === undefined
                          ? undefined
                          : yield* clock.now(),
                      );
                      return {
                        applied,
                        current: applied
                          ? Option.none()
                          : yield* store.findById(intent.invocationId),
                      };
                    }),
                  ),
                  {
                    onFailure: (cause) => ({ ok: false as const, cause }),
                    onSuccess: (value) => ({ ok: true as const, value }),
                  },
                );
                if (!unknownWrite.ok) {
                  if (
                    isLeaseFencingRejected(unknownWrite.cause) &&
                    options.qualificationProbe !== undefined
                  ) {
                    yield* Effect.promise(
                      () =>
                        options.qualificationProbe?.({
                          boundary: "AH7ToolSettlementFenceRejected",
                          executionId: context.executionId,
                          invocationId: intent.invocationId,
                          callRef: intent.callRef,
                        }) ?? Promise.resolve(),
                    );
                  }
                  return yield* Effect.fail<ToolRuntimeError>(
                    isLeaseFencingRejected(unknownWrite.cause)
                      ? unknownWrite.cause
                      : operationalFailure(
                          "SettlementJournal",
                          String(intent.invocationId),
                        )(unknownWrite.cause),
                  );
                }
                if (!unknownWrite.value.applied) {
                  const canonical = unknownWrite.value.current;
                  if (
                    Option.isSome(canonical) &&
                    canonical.value.settlement?._tag === "OutcomeUnknown"
                  ) {
                    return {
                      _tag: "OutcomeUnknown" as const,
                      reconciliationRefs:
                        canonical.value.settlement.reconciliationRefs,
                    };
                  }
                }
              }
              return {
                _tag: "OutcomeUnknown" as const,
                reconciliationRefs,
              };
            }
            if (recorded.effectAdmissionState === "LegacyUnknown") {
              return {
                _tag: "OutcomeUnknown" as const,
                reconciliationRefs: [String(intent.invocationId)],
              };
            }
          } else {
            if (
              p39BindingEnabled &&
              definition.sideEffectSemantics === "Reconcilable" &&
              trustedProfile === undefined
            ) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "RecoveryBinding",
                  String(intent.invocationId),
                )({ _tag: "ReconciliationProfileUnavailable" }),
              );
            }
            const invocation = {
              invocationId: intent.invocationId,
              executionId: context.executionId,
              workspaceId: context.workspaceId,
              toolName: intent.toolName,
              toolVersion: intent.toolVersion,
              sideEffectSemantics: definition.sideEffectSemantics,
              argumentsJson: intent.argumentsJson,
              resolvedRegions: regions,
              approvalId:
                context.executableApproval?.approvalId ?? intent.approvalId,
              intentAt: now,
            } as const;
            const claimStopped = { _tag: "AH7ClaimStopped" as const };
            const approvalClaimLost = { _tag: "AH7ApprovalClaimLost" as const };
            let approvalReceipt: ExecutableApprovalConsumptionReceipt | null =
              null;
            if (p39BindingEnabled && options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "P38P39ClaimBeforeTransaction",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                    approvalId:
                      context.executableApproval?.approvalId ??
                      intent.approvalId,
                  }) ?? Promise.resolve(),
              );
            }
            const claim = yield* Effect.match(
              tx.transact(
                Effect.gen(function* () {
                  const snapshotAdmission =
                    yield* validateCapturedSnapshotAndAdmit().pipe(
                      Effect.mapError((cause) =>
                        isP39ResourceResolutionStale(cause)
                          ? cause
                          : operationalFailure(
                              "ResourceAdmission",
                              String(intent.invocationId),
                            )(cause),
                      ),
                    );
                  if (snapshotAdmission._tag === "Denied") {
                    return "AdmissionDenied" as const;
                  }
                  const recordedIntent = yield* store.recordIntent(
                    invocation,
                    context.executionFence,
                    now,
                  );
                  if (recordedIntent === "ExecutionStopping") {
                    return "ExecutionStopping" as const;
                  }
                  if (
                    needsApproval &&
                    context.executableApproval !== undefined &&
                    Option.isSome(executableApprovals)
                  ) {
                    if (approvalAlreadyConsumedBySelf) {
                      if (p39BindingEnabled) {
                        return yield* Effect.fail<ToolRuntimeError>(
                          operationalFailure(
                            "RecoveryBinding",
                            String(intent.invocationId),
                          )({ _tag: "ConsumedApprovalHasNoPriorBinding" }),
                        );
                      }
                      return "Claimed" as const;
                    }
                    const consumed =
                      yield* executableApprovals.value.consumeApproved({
                        approvalId: context.executableApproval.approvalId,
                        expectedRevision:
                          context.executableApproval.expectedRevision,
                        consumedBy: intent.invocationId,
                        consumedAt: now,
                        binding: context.executableApproval.binding,
                        executionFence: context.executionFence,
                      });
                    if (consumed === "ExecutionStopping") {
                      return yield* Effect.fail(claimStopped);
                    }
                    if (consumed === false) {
                      return yield* Effect.fail(approvalClaimLost);
                    }
                    if (p39BindingEnabled) approvalReceipt = consumed;
                  } else if (
                    needsApproval &&
                    intent.approvalId !== null &&
                    !approvalAlreadyConsumedBySelf
                  ) {
                    if (p39BindingEnabled) {
                      return yield* Effect.fail<ToolRuntimeError>(
                        operationalFailure(
                          "RecoveryBinding",
                          String(intent.invocationId),
                        )({ _tag: "P38ConsumptionReceiptUnavailable" }),
                      );
                    }
                    const consumed = yield* store.consumeApproval(
                      intent.approvalId,
                      intent.invocationId,
                      context.executionFence,
                      now,
                    );
                    if (consumed === "ExecutionStopping") {
                      return yield* Effect.fail(claimStopped);
                    }
                    if (!consumed) {
                      return yield* Effect.fail(approvalClaimLost);
                    }
                  }
                  if (p39BindingEnabled) {
                    if (Option.isNone(p39Recovery)) {
                      return yield* Effect.fail<ToolRuntimeError>(
                        operationalFailure(
                          "RecoveryBinding",
                          String(intent.invocationId),
                        )({ _tag: "P39RecoveryEvidenceStoreUnavailable" }),
                      );
                    }
                    let approvalSnapshot: RecoveryApprovalSnapshot | null =
                      null;
                    if (needsApproval) {
                      const receipt = approvalReceipt;
                      const expected = context.executableApproval;
                      if (
                        receipt === null ||
                        expected === undefined ||
                        receipt.approvalId !== expected.approvalId ||
                        receipt.consumedBy !== intent.invocationId ||
                        receipt.preConsumeRevision !==
                          expected.expectedRevision ||
                        receipt.consumedRevision !==
                          expected.expectedRevision + 1 ||
                        !executableApprovalBindingMatches(
                          receipt.binding,
                          expected.binding,
                        )
                      ) {
                        return yield* Effect.fail<ToolRuntimeError>(
                          operationalFailure(
                            "RecoveryBinding",
                            String(intent.invocationId),
                          )({ _tag: "P38ReceiptBindingMismatch" }),
                        );
                      }
                      approvalSnapshot =
                        recoveryApprovalSnapshotFromReceipt(receipt);
                    }
                    let recoveryBinding: RecoveryBindingV1;
                    try {
                      recoveryBinding = makeRecoveryBindingV1({
                        context,
                        intent,
                        definition,
                        authority: resolvedAuthority,
                        regions,
                        resourceBoundaryRevision:
                          capturedWorkspace.resourceBoundaryRevision,
                        environmentRevision:
                          resolved.observedEnvironmentRevision,
                        approval: approvalSnapshot,
                        ...(trustedProfile === undefined
                          ? {}
                          : {
                              profile: trustedProfile,
                              effectKey: trustedEffectKey,
                            }),
                      });
                    } catch (cause) {
                      return yield* Effect.fail<ToolRuntimeError>(
                        operationalFailure(
                          "RecoveryBinding",
                          String(intent.invocationId),
                        )(cause),
                      );
                    }
                    yield* p39Recovery.value
                      .bindClaim({
                        binding: recoveryBinding,
                        createdAt: now,
                      })
                      .pipe(
                        Effect.mapError(
                          operationalFailure(
                            "RecoveryBinding",
                            String(intent.invocationId),
                          ),
                        ),
                      );
                  }
                  return "Claimed" as const;
                }),
              ),
              {
                onFailure: (cause) => ({ _tag: "Failed" as const, cause }),
                onSuccess: (value) => ({ _tag: "Succeeded" as const, value }),
              },
            );
            if (claim._tag === "Failed") {
              if (isP39ResourceResolutionStale(claim.cause)) {
                return yield* refreshAfterStale(claim.cause);
              }
              if (
                typeof claim.cause === "object" &&
                claim.cause !== null &&
                "_tag" in claim.cause &&
                claim.cause._tag === "AH7ApprovalClaimLost"
              ) {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  "ApprovalConsumedByOtherInvocation",
                );
              }
              if (
                typeof claim.cause === "object" &&
                claim.cause !== null &&
                "_tag" in claim.cause &&
                claim.cause._tag === "AH7ClaimStopped"
              ) {
                return { _tag: "Interrupted" as const };
              }
              return yield* Effect.fail<ToolRuntimeError>(
                isLeaseFencingRejected(claim.cause) ||
                  (typeof claim.cause === "object" &&
                    claim.cause !== null &&
                    "_tag" in claim.cause &&
                    claim.cause._tag === "ToolRuntimeOperationalFailure")
                  ? claim.cause
                  : operationalFailure(
                      "IntentJournal",
                      String(intent.invocationId),
                    )(claim.cause),
              );
            }
            if (claim.value === "ExecutionStopping") {
              return { _tag: "Interrupted" as const };
            }
            if (claim.value === "AdmissionDenied") {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                regions,
                "ResourceAdmissionDenied",
              );
            }
            if (needsApproval) approvalAlreadyConsumedBySelf = true;
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH7AfterToolIntentCommit",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                  }) ?? Promise.resolve(),
              );
            }
          }

          // A NotOccurred proof whose retry gate was denied is already a
          // complete, fenced no-effect decision. Do not send that settled
          // recovery outcome through the ordinary new-effect authority,
          // approval, or admission path: those checks govern a new attempt
          // and can only overwrite or obscure the authenticated P39/P40
          // terminal selection below.
          if (recoveredToolOutcome === undefined) {
            const effectGateNow = yield* clock.now();
            const effectAuthority = Option.isSome(authorityResolver)
              ? yield* authorityResolver.value
                  .resolve({
                    intent,
                    definition,
                    context,
                    regions,
                    now: effectGateNow,
                  })
                  .pipe(
                    Effect.catchTag("ToolAuthorityDenied", () =>
                      Effect.succeed(undefined),
                    ),
                    Effect.mapError(
                      operationalFailure(
                        "AuthorityResolution",
                        String(intent.invocationId),
                      ),
                    ),
                  )
              : context.authority;
            if (effectAuthority === undefined) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                regions,
                approvalAlreadyConsumedBySelf
                  ? "ApprovalNoLongerAuthorized"
                  : "InvocationAuthorityDenied",
              );
            }
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH7AfterEffectAuthorityResolvedBeforeAdmission",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                  }) ?? Promise.resolve(),
              );
            }
            if (effectAuthority.sourceRevision === undefined) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                regions,
                approvalAlreadyConsumedBySelf
                  ? "ApprovalNoLongerAuthorized"
                  : "InvocationAuthorityDenied",
              );
            }
            const effectAuthorityCheck = checkInvocationAuthority({
              authority: effectAuthority,
              definition,
              intent,
              context,
              regions,
              now: effectGateNow,
              maxDelegationDepth: options.maxDelegationDepth ?? 1,
            });
            if (effectAuthorityCheck._tag === "Denied") {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                regions,
                approvalAlreadyConsumedBySelf
                  ? "ApprovalNoLongerAuthorized"
                  : "InvocationAuthorityDenied",
              );
            }
            if (
              needsApproval &&
              intent.approvalId !== null &&
              context.executableApproval === undefined
            ) {
              const approval = yield* tx
                .transact(store.findApproval(intent.approvalId))
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "ApprovalLookup",
                      String(intent.invocationId),
                    ),
                  ),
                );
              const matched = Option.isSome(approval)
                ? matchApproval({
                    approval: approval.value,
                    intent,
                    definition,
                    context,
                    regions,
                    now: effectGateNow,
                    replayOfRecordedInvocation: approvalAlreadyConsumedBySelf,
                  })
                : { _tag: "Denied" as const, reason: "approval not found" };
              if (matched._tag === "Denied") {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  approvalAlreadyConsumedBySelf
                    ? "ApprovalNoLongerAuthorized"
                    : approvalDenialCode(matched.reason),
                );
              }
            }
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH7BeforeEffectAdmission",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                  }) ?? Promise.resolve(),
              );
            }
            const effectAdmission = retryAdmitted
              ? {
                  _tag: "Succeeded" as const,
                  value: { _tag: "Admitted" as const },
                }
              : yield* Effect.match(
                  tx.transact(
                    Effect.gen(function* () {
                      const admissionResult = yield* store.admitEffect(
                        intent.invocationId,
                        effectAuthority,
                        effectGateNow,
                        context.executionFence,
                      );
                      if (
                        admissionResult._tag === "Admitted" &&
                        p39BindingEnabled &&
                        Option.isSome(p39Recovery)
                      ) {
                        yield* p39Recovery.value.admitFirstAttempt(
                          intent.invocationId,
                          effectGateNow,
                        );
                      }
                      return admissionResult;
                    }),
                  ),
                  {
                    onFailure: (cause) => ({ _tag: "Failed" as const, cause }),
                    onSuccess: (value) => ({
                      _tag: "Succeeded" as const,
                      value,
                    }),
                  },
                );
            if (effectAdmission._tag === "Failed") {
              return yield* Effect.fail<ToolRuntimeError>(
                isLeaseFencingRejected(effectAdmission.cause)
                  ? effectAdmission.cause
                  : operationalFailure(
                      "IntentJournal",
                      String(intent.invocationId),
                    )(effectAdmission.cause),
              );
            }
            if (effectAdmission.value._tag === "Denied") {
              if (recoveredToolOutcome !== undefined) {
                // A known Occurred fact is accounted under the current fence even
                // if current authority no longer admits new effects.
              } else {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  approvalAlreadyConsumedBySelf
                    ? "ApprovalNoLongerAuthorized"
                    : effectAdmission.value.reasonCode,
                );
              }
            }
            if (effectAdmission.value._tag === "ExecutionStopping") {
              if (options.qualificationProbe !== undefined) {
                yield* Effect.promise(
                  () =>
                    options.qualificationProbe?.({
                      boundary: "P38StopEffectAdmissionResult",
                      executionId: context.executionId,
                      invocationId: intent.invocationId,
                      callRef: intent.callRef,
                      logicalActionId:
                        context.logicalActionId ??
                        context.recoveryBindingIdentity?.logicalActionId,
                      fencingGeneration:
                        context.executionFence.fencingGeneration,
                      admissionResult: effectAdmission.value._tag,
                    }) ?? Promise.resolve(),
                );
              }
              if (recoveredToolOutcome !== undefined) {
                // Stop gates new execution; it does not discard a confirmed
                // external outcome.
              } else {
                const settledAt = yield* clock.now();
                return yield* persistNoEffectInterruption(
                  Option.isSome(prior)
                    ? {
                        invocationId: intent.invocationId,
                        executionId: context.executionId,
                        workspaceId: context.workspaceId,
                        toolName: intent.toolName,
                        toolVersion: intent.toolVersion,
                        sideEffectSemantics: definition.sideEffectSemantics,
                        argumentsJson: intent.argumentsJson,
                        resolvedRegions: regions,
                        approvalId:
                          context.executableApproval?.approvalId ??
                          intent.approvalId,
                        intentAt: prior.value.intentAt,
                      }
                    : undefined,
                  settledAt,
                );
              }
            }

            if (
              options.qualificationProbe !== undefined &&
              recoveredToolOutcome === undefined
            ) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "P38StopEffectAdmissionResult",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                    ...((context.logicalActionId ??
                      context.recoveryBindingIdentity?.logicalActionId) ===
                    undefined
                      ? {}
                      : {
                          logicalActionId:
                            context.logicalActionId ??
                            context.recoveryBindingIdentity?.logicalActionId,
                        }),
                    fencingGeneration: context.executionFence.fencingGeneration,
                    admissionResult: effectAdmission.value._tag,
                    ...(effectAdmission.value._tag === "Denied"
                      ? {
                          admissionDenialReason:
                            effectAdmission.value.reasonCode,
                        }
                      : {}),
                  }) ?? Promise.resolve(),
              );
            }

            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH7AfterEffectAdmissionCommit",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                  }) ?? Promise.resolve(),
              );
            }
          }

          const executionBundle =
            recoveredToolOutcome !== undefined
              ? {
                  executed: {
                    ok: true as const,
                    value: recoveredToolOutcome,
                  },
                  closed: { ok: true as const },
                }
              : yield* Effect.gen(function* () {
                  const handle = yield* sandbox
                    .open(
                      address === undefined || region === undefined
                        ? {
                            executionId: context.executionId,
                            workspaceId: context.workspaceId,
                            regions,
                          }
                        : {
                            executionId: context.executionId,
                            workspaceId: context.workspaceId,
                            mounts: [
                              {
                                ref: "workspace",
                                address,
                                region,
                                access: executor.write
                                  ? "ReadWrite"
                                  : "ReadOnly",
                              },
                            ],
                          },
                    )
                    .pipe(
                      Effect.mapError(
                        operationalFailure(
                          "SandboxOpen",
                          String(intent.invocationId),
                        ),
                      ),
                    );
                  const executed = yield* Effect.match(
                    executor.execute({
                      intent,
                      definition,
                      context,
                      sandbox: handle,
                      regions,
                      ...(executor.processCapability === "SandboxProcess"
                        ? { runProcess: runProcessFor(context, handle) }
                        : {}),
                    }),
                    {
                      onFailure: (cause) => ({ ok: false as const, cause }),
                      onSuccess: (value) => ({ ok: true as const, value }),
                    },
                  );
                  const closed = yield* Effect.match(sandbox.close(handle), {
                    onFailure: (cause) => ({ ok: false as const, cause }),
                    onSuccess: () => ({ ok: true as const }),
                  });
                  return { executed, closed };
                });
          const { executed, closed } = executionBundle;
          if (!closed.ok) {
            return yield* Effect.fail<ToolRuntimeError>({
              _tag: "ToolRuntimeCleanupFailure",
              stage: "SandboxClose",
              effectDisposition: "OutcomeUncertain",
              invocationRef: String(intent.invocationId),
              cause: closed.cause,
              ...(executed.ok
                ? {}
                : {
                    priorFailure: {
                      _tag: "ToolRuntimeOperationalFailure" as const,
                      stage: "Executor" as const,
                      effectDisposition: "OutcomeUncertain" as const,
                      invocationRef: String(intent.invocationId),
                      cause: executed.cause,
                    },
                  }),
            });
          }
          if (!executed.ok) {
            return yield* Effect.fail<ToolRuntimeError>({
              _tag: "ToolRuntimeOperationalFailure",
              stage: "Executor",
              effectDisposition: "OutcomeUncertain",
              invocationRef: String(intent.invocationId),
              cause: executed.cause,
            });
          }
          const outcome = executed.value;
          if (
            options.qualificationProbe !== undefined &&
            recoveredToolOutcome === undefined &&
            outcome.sandboxProviderUnavailable === undefined
          ) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH7AfterToolEffectBeforeSettlement",
                  executionId: context.executionId,
                  invocationId: intent.invocationId,
                  callRef: intent.callRef,
                }) ?? Promise.resolve(),
            );
          }

          let authenticatedRecoveryEvidence:
            | SelectedP39RecoveryEvidence
            | undefined;
          if (outcome.settlement._tag === "ReconciledNoEffect") {
            const rejectUnverifiedSelection = (
              cause: unknown,
            ): Effect.Effect<never, ToolRuntimeError> =>
              Effect.fail({
                _tag: "ToolRuntimeOperationalFailure",
                stage: "SettlementJournal",
                effectDisposition: "OutcomeUncertain",
                invocationRef: String(intent.invocationId),
                cause: {
                  _tag: "P40AuthenticatedRecoveryEvidenceUnavailable",
                  cause,
                },
              });
            if (Option.isNone(p39RecoveryEvidence)) {
              return yield* rejectUnverifiedSelection({
                _tag: "P39RecoveryEvidenceStoreUnavailable",
              });
            }
            if (
              pendingReconciliation !== undefined &&
              pendingReconciliation.result._tag === "NotOccurred" &&
              outcome.settlement.reconciliationFactRef ===
                pendingReconciliation.selection.factId
            ) {
              // This invocation just recorded the exact RecoveryInput fact.
              // The P4 winner transaction validates the fact/binding/attempt
              // tuple and selects it atomically with the terminal Observation;
              // findSelected is intentionally reserved for replay of an
              // already-selected terminal winner.
            } else {
              const selectedRead = yield* Effect.match(
                tx.transact(
                  p39RecoveryEvidence.value.findSelected(intent.invocationId),
                ),
                {
                  onFailure: (cause) => ({ ok: false as const, cause }),
                  onSuccess: (value) => ({ ok: true as const, value }),
                },
              );
              if (!selectedRead.ok) {
                return yield* rejectUnverifiedSelection(selectedRead.cause);
              }
              if (Option.isNone(selectedRead.value)) {
                return yield* rejectUnverifiedSelection({
                  _tag: "P39SelectedRecoveryEvidenceMissing",
                });
              }
              const selected = selectedRead.value.value;
              if (
                !matchesAuthenticatedP39Evidence({
                  selected,
                  intent,
                  context,
                  factId: outcome.settlement.reconciliationFactRef,
                })
              ) {
                return yield* rejectUnverifiedSelection({
                  _tag: "P39SelectedRecoveryEvidenceMismatch",
                });
              }
              authenticatedRecoveryEvidence = selected;
            }
          }

          let resultRef = outcome.resultRef;
          if (
            Option.isNone(observationEvidence) &&
            outcome.settlement._tag === "ReconciledNoEffect"
          ) {
            return yield* Effect.fail<ToolRuntimeError>(
              operationalFailure(
                "SettlementJournal",
                String(intent.invocationId),
              )({
                _tag: "P40ObservationEvidenceStoreUnavailable",
              }),
            );
          }
          if (
            Option.isNone(observationEvidence) &&
            outcome.settlement._tag === "Success" &&
            resultRef === null &&
            Option.isSome(artifactService)
          ) {
            resultRef = String(
              (yield* tx
                .transact(
                  artifactService.value.store(
                    new TextEncoder().encode(outcome.observation.text),
                    `tool-result:${intent.toolName}`,
                    {
                      invocationId: intent.invocationId,
                      executionId: context.executionId,
                    },
                    now,
                  ),
                )
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "SettlementJournal",
                      String(intent.invocationId),
                    ),
                  ),
                )).artifactId,
            );
          }

          const settledAt = yield* clock.now();
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH7BeforeToolSettlementTransaction",
                  executionId: context.executionId,
                  invocationId: intent.invocationId,
                  callRef: intent.callRef,
                }) ?? Promise.resolve(),
            );
          }
          if (
            Option.isSome(observationEvidence) &&
            outcome.settlement._tag !== "Denied"
          ) {
            if (context.executionFence === undefined) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "SettlementJournal",
                  String(intent.invocationId),
                )({
                  _tag: "P40ObservationEvidenceFenceUnavailable",
                }),
              );
            }
            const p4Intent = yield* findInvocationFenced(
              intent.invocationId,
              context,
              "SettlementJournal",
            );
            if (Option.isNone(p4Intent)) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "SettlementJournal",
                  String(intent.invocationId),
                )({
                  _tag: "P4IntentMissingAtObservationSettlement",
                }),
              );
            }
            const record = p4Intent.value;
            const invocation = {
              invocationId: record.invocationId,
              executionId: record.executionId,
              workspaceId: record.workspaceId,
              toolName: record.toolName,
              toolVersion: record.toolVersion,
              sideEffectSemantics: record.sideEffectSemantics,
              argumentsJson: record.argumentsJson,
              resolvedRegions: record.resolvedRegions,
              approvalId: record.approvalId,
              intentAt: record.intentAt,
            } as const;
            const candidateObservation: CanonicalToolObservation = (() => {
              switch (outcome.settlement._tag) {
                case "Success":
                  return {
                    _tag: "Success",
                    observation: outcome.observation,
                    resultRef,
                  };
                case "ExpectedFailure":
                  return {
                    _tag: "ExpectedFailure",
                    observation: outcome.observation,
                  };
                case "Interrupted":
                  return { _tag: "Interrupted" };
                case "OutcomeUnknown":
                  return {
                    _tag: "OutcomeUnknown",
                    reconciliationRefs: outcome.settlement.reconciliationRefs,
                  };
                case "RuntimeFailure":
                  return {
                    _tag: "RuntimeFailure",
                    cause: outcome.settlement.cause,
                  };
                case "ReconciledNoEffect":
                  return {
                    _tag: "ReconciledNoEffect",
                    reasonCode: outcome.settlement.reasonCode,
                    reconciliationFactRef:
                      outcome.settlement.reconciliationFactRef,
                    observation: outcome.observation,
                    resultRef: resultRef ?? "",
                  };
              }
            })();
            const candidate = {
              invocation,
              settlement: outcome.settlement,
              resultRef,
              observation: candidateObservation,
              ...(authenticatedRecoveryEvidence === undefined
                ? {}
                : {
                    reconciliationSelection: {
                      attemptNo:
                        authenticatedRecoveryEvidence.attempt.attemptNo,
                      factId: authenticatedRecoveryEvidence.fact.factId,
                    },
                    authenticatedRecoveryEvidence,
                  }),
              ...(pendingReconciliation === undefined
                ? {}
                : {
                    reconciliationSelection: pendingReconciliation.selection,
                  }),
              ...(Option.isSome(artifactService) && resultRef === null
                ? {
                    materializeResultRef: () =>
                      artifactService.value
                        .store(
                          new TextEncoder().encode(outcome.observation.text),
                          `tool-result:${intent.toolName}`,
                          {
                            invocationId: intent.invocationId,
                            executionId: context.executionId,
                          },
                          now,
                        )
                        .pipe(
                          Effect.map((artifact) => String(artifact.artifactId)),
                        ),
                  }
                : {}),
              settledAt,
              executionFence: context.executionFence,
              fenceNow: yield* clock.now(),
            } as const;
            const p40Write = yield* Effect.match(
              tx.transact(
                Effect.gen(function* () {
                  const result =
                    yield* observationEvidence.value.settleOrReadWinner(
                      candidate,
                    );
                  if (
                    result._tag === "Applied" &&
                    options.qualificationProbe !== undefined
                  ) {
                    yield* Effect.promise(
                      () =>
                        options.qualificationProbe?.({
                          boundary: "AH7BeforeToolSettlementCommit",
                          executionId: context.executionId,
                          invocationId: intent.invocationId,
                          callRef: intent.callRef,
                        }) ?? Promise.resolve(),
                    );
                  }
                  return result;
                }),
              ),
              {
                onFailure: (cause) => ({ ok: false as const, cause }),
                onSuccess: (value) => ({ ok: true as const, value }),
              },
            );
            if (!p40Write.ok) {
              if (isLeaseFencingRejected(p40Write.cause)) {
                return yield* Effect.fail<ToolRuntimeError>(p40Write.cause);
              }
              const failureCode = replayFailureCode(p40Write.cause);
              if (failureCode !== undefined) {
                const afterFailure = yield* findInvocationFenced(
                  intent.invocationId,
                  context,
                  "SettlementJournal",
                );
                if (
                  (Option.isSome(afterFailure) &&
                    afterFailure.value.settlement !== null) ||
                  record.settledAt !== null
                ) {
                  return yield* recordReplayFailure(
                    intent,
                    context,
                    failureCode,
                    yield* clock.now(),
                  );
                }
              }
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "SettlementJournal",
                  String(intent.invocationId),
                )(p40Write.cause),
              );
            }
            if (
              p40Write.value._tag === "Applied" &&
              options.qualificationProbe !== undefined
            ) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH7AfterToolSettlementCommit",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                  }) ?? Promise.resolve(),
              );
            }
            if (p40Write.value._tag === "ExistingDenied") {
              return denied(p40Write.value.reasonCode);
            }
            return p40Write.value.evidence
              .observation as CanonicalToolObservation;
          }
          const settlementWrite = yield* Effect.match(
            tx.transact(
              Effect.gen(function* () {
                const fenceNow = yield* clock.now();
                const applied = yield* store.settle(
                  intent.invocationId,
                  outcome.settlement,
                  resultRef,
                  settledAt,
                  context.executionFence,
                  fenceNow,
                );
                if (applied && options.qualificationProbe !== undefined) {
                  yield* Effect.promise(
                    () =>
                      options.qualificationProbe?.({
                        boundary: "AH7BeforeToolSettlementCommit",
                        executionId: context.executionId,
                        invocationId: intent.invocationId,
                        callRef: intent.callRef,
                      }) ?? Promise.resolve(),
                  );
                }
                return {
                  applied,
                  current: applied
                    ? Option.none()
                    : yield* store.findById(intent.invocationId),
                };
              }),
            ),
            {
              onFailure: (cause) => ({ ok: false as const, cause }),
              onSuccess: (value) => ({ ok: true as const, value }),
            },
          );
          if (!settlementWrite.ok) {
            if (
              isLeaseFencingRejected(settlementWrite.cause) &&
              options.qualificationProbe !== undefined
            ) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH7ToolSettlementFenceRejected",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                  }) ?? Promise.resolve(),
              );
            }
            return yield* Effect.fail<ToolRuntimeError>(
              isLeaseFencingRejected(settlementWrite.cause)
                ? settlementWrite.cause
                : operationalFailure(
                    "SettlementJournal",
                    String(intent.invocationId),
                  )(settlementWrite.cause),
            );
          }
          if (!settlementWrite.value.applied) {
            const canonical = settlementWrite.value.current;
            if (
              Option.isSome(canonical) &&
              canonical.value.settlement?._tag === "OutcomeUnknown"
            ) {
              return {
                _tag: "OutcomeUnknown" as const,
                reconciliationRefs:
                  canonical.value.settlement.reconciliationRefs,
              };
            }
            return yield* Effect.fail<ToolRuntimeError>(
              operationalFailure(
                "SettlementJournal",
                String(intent.invocationId),
              )({
                _tag: "ToolInvocationSettlementNotApplied",
                canonicalSettlement: Option.isSome(canonical)
                  ? (canonical.value.settlement?._tag ?? "Unsettled")
                  : "Missing",
              }),
            );
          }
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH7AfterToolSettlementCommit",
                  executionId: context.executionId,
                  invocationId: intent.invocationId,
                  callRef: intent.callRef,
                }) ?? Promise.resolve(),
            );
          }

          if (
            executor.processCapability === "SandboxProcess" &&
            outcome.sandboxProviderUnavailable !== undefined
          ) {
            return outcome.sandboxProviderUnavailable;
          }

          const observation: CanonicalToolObservation = (() => {
            switch (outcome.settlement._tag) {
              case "Success":
                return {
                  _tag: "Success",
                  observation: outcome.observation,
                  resultRef,
                };
              case "ExpectedFailure":
                return {
                  _tag: "ExpectedFailure",
                  observation: outcome.observation,
                };
              case "Denied":
                return denied(outcome.settlement.reasonCode);
              case "Interrupted":
                return { _tag: "Interrupted" };
              case "OutcomeUnknown":
                return {
                  _tag: "OutcomeUnknown",
                  reconciliationRefs: outcome.settlement.reconciliationRefs,
                };
              case "RuntimeFailure":
                return {
                  _tag: "RuntimeFailure",
                  cause: outcome.settlement.cause,
                };
              case "ReconciledNoEffect":
                return {
                  _tag: "ReconciledNoEffect",
                  reasonCode: outcome.settlement.reasonCode,
                  reconciliationFactRef:
                    outcome.settlement.reconciliationFactRef,
                  observation: outcome.observation,
                  resultRef: resultRef ?? "",
                };
            }
          })();
          return observation;
        });

      return ToolRuntimePort.of({ invoke });
    }),
  );

export { bounded };
