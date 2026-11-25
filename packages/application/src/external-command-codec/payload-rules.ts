import { NO_EFFECT_DENIAL_CODES } from "@arbor/domain";
import type { RegisteredCommandType } from "./types.js";
import {
  string,
  nonEmptyString,
  trimmedNonEmptyString,
  isoTimestamp,
  boundedString,
  opaqueIdentifier,
  boolean,
  integer,
  positiveSafeInteger,
  canonicalIdentifier,
  record,
  id,
  actor,
  literal,
  nullable,
  optional,
  array,
  object,
  union,
  type Rule,
} from "./rules.js";

const stringArray = array(string);
const workRevision = integer;
const revision = integer;
const sessionPrimary = object({
  sessionId: id("SessionId"),
  contextEpoch: integer,
});
const responsibilityDefinition = object({
  purpose: string,
  ownedResponsibilities: stringArray,
  obligations: stringArray,
  includes: stringArray,
  excludes: stringArray,
  interfaces: stringArray,
});
const verificationMission = object({
  goal: string,
  criteria: array(
    object({
      criterionId: string,
      requirement: string,
      required: boolean,
    }),
  ),
  riskRequirements: stringArray,
});
const workContractSnapshot = object({
  objective: string,
  why: string,
  constraints: stringArray,
  completionExpectation: string,
  verificationMission,
});
const steerOperation = union("kind", {
  DirectionGuidance: object({
    kind: literal("DirectionGuidance"),
    guidance: string,
  }),
  ContractAmendment: object({
    kind: literal("ContractAmendment"),
    amendment: workContractSnapshot,
  }),
});
const executionEpisodeBinding = union("_tag", {
  WorkEpisode: object({
    _tag: literal("WorkEpisode"),
    workId: id("WorkId"),
    targetWorkRevision: revision,
  }),
  ConversationResponseEpisode: object({
    _tag: literal("ConversationResponseEpisode"),
    messageId: id("MessageId"),
    responseJobRevision: revision,
  }),
  InboxEpisode: object({
    _tag: literal("InboxEpisode"),
    entryKey: nonEmptyString,
    inputKind: nonEmptyString,
  }),
  DecisionEpisode: object({
    _tag: literal("DecisionEpisode"),
    decisionId: id("DecisionId"),
    decisionKind: literal("SelectCurrentWork"),
    requestRevision: revision,
  }),
});
const sandboxPolicySelection = union("kind", {
  OsEnforced: object({
    kind: literal("OsEnforced"),
    policy: object({
      version: literal(1),
      mode: enumRule("Disabled", "Restricted", "Enabled"),
      destinations: stringArray,
    }),
  }),
  TrustedLocalUnconfinedV1: object({
    kind: literal("TrustedLocalUnconfinedV1"),
    version: literal(1),
  }),
});
const resourceAddress = union("_tag", {
  FileTree: object({ _tag: literal("FileTree"), path: string }),
  GitWorktree: object({
    _tag: literal("GitWorktree"),
    path: string,
    repositoryRef: optional(string),
    branch: optional(string),
  }),
  DatabaseNamespace: object({
    _tag: literal("DatabaseNamespace"),
    namespace: string,
  }),
  ExternalResource: object({
    _tag: literal("ExternalResource"),
    address: string,
  }),
});
const resourceBoundary = object({
  basisResponsibilityRevision: integer,
  addresses: array(resourceAddress),
});
const projectResourceSelection = union("_tag", {
  Profile: object({
    _tag: literal("Profile"),
    resourceProfileRef: opaqueIdentifier,
    version: opaqueIdentifier,
  }),
  ConversationOnly: object({ _tag: literal("ConversationOnly") }),
});
const responsibilityBoundAgentBinding = object({
  _tag: literal("ResponsibilityBoundAgentBinding"),
  workspaceId: id("WorkspaceId"),
});
const producerBinding = union("_tag", {
  AnyProducer: object({ _tag: literal("AnyProducer") }),
  WorkspaceBound: object({
    _tag: literal("WorkspaceBound"),
    workspaceId: id("WorkspaceId"),
  }),
  WorkBound: object({ _tag: literal("WorkBound"), workId: id("WorkId") }),
});
const expectedDeliverable = object({
  kind: string,
  requiredArtifactRoles: stringArray,
});
const outboundMessage = union("kind", {
  Query: object({
    kind: literal("Query"),
    recipientWorkspaceId: id("WorkspaceId"),
    bodyRef: string,
    correlationId: optional(string),
    causationId: optional(string),
    urgency: literal("Normal"),
  }),
  Reply: object({
    kind: literal("Reply"),
    recipientWorkspaceId: id("WorkspaceId"),
    bodyRef: string,
    correlationId: optional(string),
    causationId: optional(string),
    urgency: literal("Normal"),
  }),
  Report: object({
    kind: literal("Report"),
    recipientWorkspaceId: id("WorkspaceId"),
    bodyRef: string,
    correlationId: optional(string),
    causationId: optional(string),
    urgency: literal("Normal"),
  }),
  DecisionRequest: object({
    kind: literal("DecisionRequest"),
    recipientWorkspaceId: id("WorkspaceId"),
    bodyRef: string,
    correlationId: optional(string),
    causationId: optional(string),
    urgency: literal("Normal"),
  }),
  Deliver: object({
    kind: literal("Deliver"),
    recipientWorkspaceId: id("WorkspaceId"),
    bodyRef: string,
    correlationId: optional(string),
    causationId: optional(string),
    urgency: literal("Normal"),
    deliverableId: id("DeliverableId"),
  }),
});
const responsibilityDraft = responsibilityDefinition;
const childWorkspaceProposal = object({
  name: string,
  responsibilityDraft,
  resourceBoundaryDraft: resourceBoundary,
  resourceOwnershipDelegation: optional(
    object({
      addresses: array(resourceAddress, { minItems: 1, maxItems: 16 }),
    }),
  ),
  rationale: string,
  initialWork: optional(
    object({
      objective: string,
      why: string,
      constraints: stringArray,
      completionExpectation: string,
      verificationMission,
    }),
  ),
  formationDepthHint: optional(enumRule("Single", "Recursive")),
});

const wakeCondition = union("_tag", {
  DependencyChanged: object({
    _tag: literal("DependencyChanged"),
    dependencyId: id("DependencyId"),
    observedRevision: revision,
  }),
  DecisionChanged: object({
    _tag: literal("DecisionChanged"),
    decisionId: id("DecisionId"),
    observedRevision: revision,
  }),
  VerificationChanged: object({
    _tag: literal("VerificationChanged"),
    workId: id("WorkId"),
    targetWorkRevision: revision,
  }),
  InboxAdvanced: object({
    _tag: literal("InboxAdvanced"),
    workspaceId: id("WorkspaceId"),
    observedSequence: integer,
  }),
  EnvironmentChanged: object({
    _tag: literal("EnvironmentChanged"),
    environmentRef: string,
    observedRevision: string,
  }),
  TimeReached: object({ _tag: literal("TimeReached"), instant: string }),
  Manual: object({ _tag: literal("Manual") }),
});
const waitSpec = object({
  mode: literal("Any"),
  conditions: array(wakeCondition),
});
const executionEpisode = union("_tag", {
  WorkEpisode: object({
    _tag: literal("WorkEpisode"),
    workId: id("WorkId"),
    targetWorkRevision: workRevision,
  }),
  ConversationResponseEpisode: object({
    _tag: literal("ConversationResponseEpisode"),
    messageId: id("MessageId"),
    responseJobRevision: integer,
  }),
  InboxEpisode: object({
    _tag: literal("InboxEpisode"),
    entryKey: string,
    inputKind: string,
  }),
  DecisionEpisode: object({
    _tag: literal("DecisionEpisode"),
    decisionId: id("DecisionId"),
    decisionKind: literal("SelectCurrentWork"),
    requestRevision: integer,
  }),
});
const completedResult = union("_tag", {
  Blocked: object({
    _tag: literal("Blocked"),
    workId: id("WorkId"),
    targetWorkRevision: workRevision,
    blockerId: string,
    waitFor: waitSpec,
    request: boundedString(1, 2000),
    failedActionRefs: array(
      object({
        executionId: id("ExecutionId"),
        providerTurnId: id("ProviderTurnId"),
        logicalStepNo: integer,
        repairAttempt: integer,
        actionIndex: integer,
        logicalActionId: string,
        callRef: string,
        resultRef: string,
        settlementRef: string,
        observationSourceRef: string,
        toolInvocationId: optional(id("ToolInvocationId")),
        terminalDenial: union("_tag", {
          P4NoEffectDenied: object({
            _tag: literal("P4NoEffectDenied"),
            reasonCode: enumRule(
              ...NO_EFFECT_DENIAL_CODES.filter(
                (code) => code !== "ApprovalRequired",
              ),
            ),
          }),
          HandlerRejected: object({
            _tag: literal("HandlerRejected"),
            routeKind: literal("Executable"),
          }),
        }),
      }),
    ),
  }),
  Yielded: object({ _tag: literal("Yielded"), reason: string, waitSpec }),
  CompletionClaimed: object({
    _tag: literal("CompletionClaimed"),
    workRevision,
    claimRef: string,
  }),
  ConversationResponseProduced: object({
    _tag: literal("ConversationResponseProduced"),
    messageId: id("MessageId"),
  }),
  InboxInputHandled: object({
    _tag: literal("InboxInputHandled"),
    entryKey: string,
  }),
  DecisionSubmitted: object({
    _tag: literal("DecisionSubmitted"),
    decisionId: id("DecisionId"),
  }),
  VerificationConcluded: object({
    _tag: literal("VerificationConcluded"),
    verificationId: id("VerificationId"),
    verdict: enumRule("Pass", "Fail", "Unknown"),
  }),
});
const executionSettlement = union("_tag", {
  Completed: object({ _tag: literal("Completed"), result: completedResult }),
  Interrupted: object({
    _tag: literal("Interrupted"),
    result: union("_tag", {
      StopRequested: object({ _tag: literal("StopRequested") }),
      ControlledInterruption: object({
        _tag: literal("ControlledInterruption"),
        reason: string,
      }),
    }),
  }),
  Failed: object({
    _tag: literal("Failed"),
    failure: object({ _tag: literal("ExecutionFailure"), reason: string }),
  }),
  OutcomeUnknown: object({
    _tag: literal("OutcomeUnknown"),
    reconciliation: object({
      _tag: literal("ReconciliationRequired"),
      invocationRefs: stringArray,
    }),
  }),
});

function enumRule(...values: ReadonlyArray<string>): Rule {
  return {
    kind: "union",
    tag: "__enum",
    cases: Object.fromEntries(values.map((value) => [value, literal(value)])),
  };
}

export const payloadRules: Readonly<Record<RegisteredCommandType, Rule>> = {
  CreateProject: object({
    name: string,
    revision,
    projectPolicy: record,
    projectPolicyRevision: revision,
    defaultConfiguration: record,
    environmentRef: string,
    rootWorkspaceId: id("WorkspaceId"),
    primarySession: sessionPrimary,
    rootWorkspace: object({
      name: string,
      responsibilityDefinition,
      responsibilityRevision: integer,
      resourceSelection: projectResourceSelection,
      agentBinding: responsibilityBoundAgentBinding,
      workspacePolicy: record,
      workspacePolicyRevision: revision,
      revision,
    }),
  }),
  CreateChildWorkspace: object({
    parentWorkspaceId: id("WorkspaceId"),
    workspaceId: id("WorkspaceId"),
    primarySession: sessionPrimary,
    name: string,
    responsibilityDefinition,
    responsibilityRevision: integer,
    resourceBoundary,
    resourceBoundaryRevision: integer,
    agentBinding: responsibilityBoundAgentBinding,
    workspacePolicy: record,
    workspacePolicyRevision: revision,
    revision,
    ownershipDelegationApproval: optional(
      object({
        delegationSourceId: string,
        formationProposalId: id("FormationProposalId"),
        formationProposalRevision: integer,
        addresses: array(resourceAddress, { minItems: 1, maxItems: 16 }),
        approvedBy: actor,
        causedByCommandId: id("CommandId"),
        parentWorkspaceId: id("WorkspaceId"),
        expectedParentWorkspaceRevision: revision,
        expectedChildWorkspaceRevision: revision,
        expectedParentBoundaryRevision: revision,
        expectedParentOwnershipRevision: integer,
        expectedChildOwnershipRevision: integer,
      }),
    ),
  }),
  AssignWork: object({
    workId: id("WorkId"),
    workspaceId: id("WorkspaceId"),
    expectedWorkspaceRevision: revision,
    objective: string,
    why: string,
    constraints: stringArray,
    completionExpectation: string,
    verificationMission,
    provenance: object({
      predecessorWorkId: nullable(id("WorkId")),
      reason: string,
    }),
    revision: workRevision,
  }),
  RenameProject: object({ name: string, expectedRevision: revision }),
  CloseProject: object({
    expectedRevision: revision,
    confirmed: literal(true),
  }),
  SelectCurrentWork: object({
    workspaceId: id("WorkspaceId"),
    workId: id("WorkId"),
    expectedWorkspaceRevision: revision,
  }),
  AdmitExecution: union("_tag", {
    WorkspaceMain: object({
      _tag: literal("WorkspaceMain"),
      executionId: id("ExecutionId"),
      workspaceId: id("WorkspaceId"),
      episode: executionEpisode,
    }),
    ExecutionBound: object({
      _tag: literal("ExecutionBound"),
      executionId: id("ExecutionId"),
      workspaceId: id("WorkspaceId"),
      parentExecutionId: nullable(id("ExecutionId")),
      mission: string,
      sessionId: id("SessionId"),
    }),
  }),
  StopExecution: object({ executionId: id("ExecutionId") }),
  SettleExecution: object({
    executionId: id("ExecutionId"),
    settlement: executionSettlement,
    expectedFencingGeneration: optional(integer),
  }),
  SendMessage: object({
    messageId: id("MessageId"),
    senderWorkspaceId: id("WorkspaceId"),
    message: outboundMessage,
  }),
  DeliverMessage: object({
    messageId: id("MessageId"),
    senderWorkspaceId: id("WorkspaceId"),
    deliverableId: id("DeliverableId"),
    bodyRef: boundedString(1, 4096),
    correlationId: optional(string),
    causationId: optional(string),
  }),
  DeclareDependency: object({
    dependencyId: id("DependencyId"),
    consumerWorkId: id("WorkId"),
    producerBinding,
    expectedDeliverable,
    expectedConsumerWorkRevision: workRevision,
    revision: integer,
  }),
  ProduceDeliverable: object({
    deliverableId: id("DeliverableId"),
    sourceWorkId: id("WorkId"),
    observedSourceWorkRevision: workRevision,
    kind: string,
    artifacts: array(object({ role: string, artifactId: id("ArtifactId") })),
  }),
  SatisfyDependency: object({
    dependencyId: id("DependencyId"),
    targetDependencyRevision: integer,
    deliverableId: id("DeliverableId"),
  }),
  RecordDecision: object({
    proposalId: id("FormationProposalId"),
    expectedProposalRevision: revision,
    outcome: union("_tag", {
      Approve: object({ _tag: literal("Approve") }),
      Reject: object({ _tag: literal("Reject") }),
      Modify: object({
        _tag: literal("Modify"),
        proposal: childWorkspaceProposal,
      }),
    }),
  }),
  ResolveControlApproval: object({
    approvalId: nonEmptyString,
    expectedRevision: revision,
    decision: enumRule("Approve", "Reject"),
    reason: nullable(string),
  }),
  ResolveExecutableApproval: object({
    approvalId: nonEmptyString,
    expectedRevision: revision,
    decision: enumRule("Approve", "Reject"),
    reason: nullable(string),
  }),
  SteerWork: object({
    workId: id("WorkId"),
    workspaceId: id("WorkspaceId"),
    steer: object({
      severity: enumRule("Normal", "Critical"),
      guidance: optional(string),
      scope: optional(enumRule("Direction", "Constraint")),
      operation: optional(steerOperation),
    }),
    expectedWorkRevision: workRevision,
    provenance: object({ source: literal("HumanInput") }),
  }),
  AcceptWorkOutcome: object({
    acceptanceId: id("AcceptanceId"),
    workId: id("WorkId"),
    targetWorkRevision: workRevision,
    verificationId: id("VerificationId"),
  }),
  CompleteWork: object({
    workId: id("WorkId"),
    expectedWorkRevision: workRevision,
  }),
  StartVerification: object({
    verificationId: id("VerificationId"),
    workId: id("WorkId"),
    observedWorkRevision: workRevision,
    missionSnapshot: verificationMission,
    targetDeliverables: optional(array(id("DeliverableId"))),
    verifierExecutionId: id("ExecutionId"),
    executableMission: boolean,
  }),
  RecordVerificationEvidence: object({
    verificationId: id("VerificationId"),
    evidence: object({
      evidenceId: id("EvidenceId"),
      criterionId: string,
      kind: enumRule(
        "ToolObservation",
        "ArtifactRef",
        "ReasoningTrace",
        "ReproductionLog",
      ),
      artifactRef: optional(id("ArtifactId")),
      observedEnvironmentRevision: optional(string),
      toolInvocationId: optional(id("ToolInvocationId")),
      observationRef: optional(string),
      callRef: optional(string),
      recordedAt: string,
    }),
  }),
  ConcludeVerification: object({
    verificationId: id("VerificationId"),
    verdict: enumRule("Pass", "Fail", "Unknown"),
    criteriaResults: array(
      object({
        criterionId: string,
        requirement: string,
        required: boolean,
        verdict: enumRule("Pass", "Fail", "Unknown"),
        evidenceRefs: array(id("EvidenceId")),
      }),
    ),
    summaryRef: string,
    conclusionReason: optional(literal("Orphaned")),
  }),
  RetryVerification: object({
    workId: id("WorkId"),
    verificationId: id("VerificationId"),
    expectedWorkRevision: workRevision,
    summaryContent: boundedString(1, 4096),
    successorVerificationId: id("VerificationId"),
    verifierExecutionId: id("ExecutionId"),
  }),
  GrantPermission: object({
    permissionGrantId: id("PermissionGrantId"),
    issuer: nonEmptyString,
    subject: union("_tag", {
      HumanPrincipal: object({
        _tag: literal("HumanPrincipal"),
        principal: nonEmptyString,
      }),
      WorkspaceAgent: object({
        _tag: literal("WorkspaceAgent"),
        workspaceId: id("WorkspaceId"),
      }),
      Execution: object({
        _tag: literal("Execution"),
        executionId: id("ExecutionId"),
      }),
    }),
    capability: trimmedNonEmptyString,
    target: trimmedNonEmptyString,
    expiresAt: nullable(isoTimestamp),
  }),
  DecideSandboxPolicy: object({
    projectId: id("ProjectId"),
    workspaceId: id("WorkspaceId"),
    executionId: id("ExecutionId"),
    episodeBinding: executionEpisodeBinding,
    expectedEpisodeRevision: revision,
    expectedPolicyRevision: revision,
    expectedWorkspaceRevision: revision,
    expectedResourceBoundaryRevision: revision,
    expectedSandboxHandleBindingDigest: string,
    expectedAuthorityBundleRevision: revision,
    expectedAuthorityBundleDigest: string,
    expectedOperatorConfigRevision: revision,
    expectedOperatorConfigDigest: string,
    expectedProviderRegistryRevision: optional(revision),
    expectedProviderRegistryDigest: optional(string),
    profile: enumRule("ReadOnly", "WorkspaceWrite", "FullAccess"),
    providerId: nonEmptyString,
    providerVersion: optional(canonicalIdentifier),
    capabilityRevision: optional(positiveSafeInteger),
    networkPolicy: sandboxPolicySelection,
    decisionExpiresAt: isoTimestamp,
  }),
  AuthorizeWorkspaceSandbox: object({
    workspaceId: id("WorkspaceId"),
    expectedAuthorizationRevision: revision,
    expectedResourceBoundaryRevision: revision,
    expectedWorkspacePolicyRevision: revision,
    profile: enumRule("ReadOnly", "WorkspaceWrite"),
    providerId: canonicalIdentifier,
    networkPolicy: object({
      version: literal(1),
      mode: enumRule("Disabled", "Restricted", "Enabled"),
      destinations: array(nonEmptyString),
    }),
    expiresAt: nullable(isoTimestamp),
    source: union("kind", {
      Human: object({ kind: literal("Human") }),
      Parent: object({
        kind: literal("Parent"),
        expectedParentAuthorizationRevision: positiveSafeInteger,
      }),
    }),
  }),
  RevokeWorkspaceSandboxAuthorization: object({
    workspaceId: id("WorkspaceId"),
    expectedAuthorizationRevision: positiveSafeInteger,
  }),
  RevokePermission: object({ permissionGrantId: id("PermissionGrantId") }),
  SubmitHumanMessage: object({
    messageId: id("MessageId"),
    targetWorkspaceId: id("WorkspaceId"),
    bodyRef: string,
  }),
  ResumeConversationResponse: object({
    messageId: id("MessageId"),
    expectedJobRevision: revision,
  }),
  CancelConversationResponse: object({
    messageId: id("MessageId"),
    expectedJobRevision: revision,
  }),
};

