import type { CanonicalResourceRegion } from "@arbor/domain";
import {
  approvalTargetDigestV1,
  canonicalArgumentsDigestV1,
  type ExecutableApprovalConsumptionReceipt,
  type ExecutableApprovalRecord,
  type RecoveryBindingV1,
  type SelectedP39RecoveryEvidence,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolIntent,
  type ToolReconciliationProfile,
  targetResourceIdentityDigestV1,
  toolDefinitionIdentityDigestV1,
} from "@arbor/ports";

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

export interface RecoveryApprovalSnapshot {
  readonly approvalId: string;
  readonly subject: string;
  readonly preConsumeRevision: number;
  readonly consumedRevision: number;
  readonly expiresAt: string;
  readonly targetResourceSpaceIds: ReadonlyArray<string>;
  readonly actionDigest: string;
  readonly consumedBy: ToolIntent["invocationId"];
}

export const recoveryApprovalSnapshotFromReceipt = (
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

export const recoveryApprovalSnapshotFromRecord = (
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

export const makeRecoveryBindingV1 = (input: {
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

export const matchesAuthenticatedP39Evidence = (input: {
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
