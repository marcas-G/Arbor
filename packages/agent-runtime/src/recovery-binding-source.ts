import type { Execution, ProviderTurnId } from "@arbor/domain";
import type { ControlBasis } from "@arbor/model-context";
import type {
  AgentLoopStepActionRecord,
  AgentLoopStepRecord,
  RecoveryBindingPolicyRevisions,
  RecoveryBindingSourceIdentity,
} from "@arbor/ports";

export const recoveryBindingIdentityFor = (input: {
  readonly step: AgentLoopStepRecord | undefined;
  readonly action: AgentLoopStepActionRecord | undefined;
  readonly executionId: Execution["executionId"];
  readonly providerTurnId: ProviderTurnId;
  readonly actionIndex: number;
  readonly callRef: string;
}): RecoveryBindingSourceIdentity | undefined => {
  const { step, action } = input;
  if (
    step === undefined ||
    action === undefined ||
    step.identity.executionId !== input.executionId ||
    step.providerTurnId !== input.providerTurnId ||
    action.identity.executionId !== step.identity.executionId ||
    action.identity.logicalStepNo !== step.identity.logicalStepNo ||
    action.identity.repairAttempt !== step.identity.repairAttempt ||
    action.actionIndex !== input.actionIndex ||
    action.callRef !== input.callRef ||
    action.logicalActionId.trim().length === 0
  ) {
    return undefined;
  }
  return {
    executionId: step.identity.executionId,
    providerTurnId: step.providerTurnId,
    logicalStepNo: step.identity.logicalStepNo,
    repairAttempt: step.identity.repairAttempt,
    logicalActionId: action.logicalActionId,
    actionIndex: action.actionIndex,
    callRef: action.callRef,
  };
};

export const recoveryBindingPolicyRevisionsFor = (
  controlBasis: Pick<
    ControlBasis,
    "workspacePolicyRevision" | "projectPolicyRevision"
  >,
): RecoveryBindingPolicyRevisions | undefined => {
  const workspacePolicyRevision = controlBasis.workspacePolicyRevision;
  const projectPolicyRevision = controlBasis.projectPolicyRevision;
  if (
    !Number.isSafeInteger(workspacePolicyRevision) ||
    workspacePolicyRevision < 0 ||
    !Number.isSafeInteger(projectPolicyRevision) ||
    projectPolicyRevision < 0
  ) {
    return undefined;
  }
  return { workspacePolicyRevision, projectPolicyRevision };
};
