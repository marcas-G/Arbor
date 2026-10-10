import type {
  CommandId,
  CompletedResult,
  ExecutionEpisodeBinding,
  ExecutionFailure,
  ExecutionId,
  InterruptedResult,
  LeaseGeneration,
  ProjectId,
  ReconciliationRequired,
} from "@arbor/domain";
import { Actor, ID_SCHEMAS, type IdTypeName } from "@arbor/domain";
import { Schema } from "effect";
import type {
  AcceptWorkOutcomePayload,
  CompleteWorkPayload,
} from "./commands/accept-complete.js";
import type { AssignWorkPayload } from "./commands/assign-work.js";
import type {
  ConcludeVerificationPayload,
  RecordVerificationEvidencePayload,
} from "./commands/conclude-verification.js";
import type {
  CancelConversationResponsePayload,
  ResumeConversationResponsePayload,
} from "./commands/conversation-response.js";
import type { CreateChildWorkspacePayload } from "./commands/create-child-workspace.js";
import type { CreateProjectPayload } from "./commands/create-project.js";
import type { DeclareDependencyPayload } from "./commands/declare-dependency.js";
import type { GrantPermissionPayload } from "./commands/grant-permission.js";
import type { ProduceDeliverablePayload } from "./commands/produce-deliverable.js";
import type {
  CloseProjectPayload,
  RenameProjectPayload,
} from "./commands/project-management.js";
import type { RecordDecisionPayload } from "./commands/record-decision.js";
import type { ResolveControlApprovalPayload } from "./commands/resolve-control-approval.js";
import type { RevokePermissionPayload } from "./commands/revoke-permission.js";
import type { SatisfyDependencyPayload } from "./commands/satisfy-dependency.js";
import type { SelectCurrentWorkPayload } from "./commands/select-current-work.js";
import type { SendMessagePayload } from "./commands/send-message.js";
import type { StartVerificationPayload } from "./commands/start-verification.js";
import type { SteerWorkPayload } from "./commands/steer-work.js";
import type { SubmitHumanMessagePayload } from "./commands/submit-human-message.js";

export type RegisteredCommandType =
  | "CreateProject"
  | "CreateChildWorkspace"
  | "AssignWork"
  | "RenameProject"
  | "CloseProject"
  | "SelectCurrentWork"
  | "AdmitExecution"
  | "StopExecution"
  | "SettleExecution"
  | "SendMessage"
  | "DeclareDependency"
  | "ProduceDeliverable"
  | "SatisfyDependency"
  | "RecordDecision"
  | "ResolveControlApproval"
  | "SteerWork"
  | "AcceptWorkOutcome"
  | "CompleteWork"
  | "StartVerification"
  | "RecordVerificationEvidence"
  | "ConcludeVerification"
  | "GrantPermission"
  | "RevokePermission"
  | "SubmitHumanMessage"
  | "ResumeConversationResponse"
  | "CancelConversationResponse";

/** Server-selected wire contract, independent of Handler schema and receipt
 * fingerprint algorithm versions. It is never persisted in a receipt. */
export const EXTERNAL_WIRE_CODEC_VERSION = 1 as const;

export type ExternalOriginPolicy =
  | "human/bootstrap"
  | "reject external"
  | "reject external; agent-originated"
  | "reject external; scheduler-originated"
  | "reject external under P13 U-3"
  | "human/parent external; runtime remains typed internal"
  | "reject external; ExecutionOrigin/RecoveryController"
  | "reject external; producer Agent"
  | "reject external; dependency coordinator"
  | "external human governance"
  | "external human approval"
  | "external human"
  | "external root-parent/human; parent-agent remains typed internal"
  | "reject external; Verification consumer/runtime"
  | "external only when P12 authority resolves the principal"
  | "external authenticated human"
  | "reject external unless P17 establishes the route";

export type CommandInputIssueRule =
  | "required"
  | "type"
  | "format"
  | "range"
  | "enum"
  | "unknown-field"
  | "unsupported-command";

export interface CommandInputIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly rule: CommandInputIssueRule;
}

export type DecodeCommandPayloadResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: ReadonlyArray<CommandInputIssue> };

export interface ExternalCommandPayloadMap {
  readonly CreateProject: CreateProjectPayload;
  readonly CreateChildWorkspace: CreateChildWorkspacePayload;
  readonly AssignWork: AssignWorkPayload;
  readonly RenameProject: RenameProjectPayload;
  readonly CloseProject: CloseProjectPayload;
  readonly SelectCurrentWork: SelectCurrentWorkPayload;
  readonly AdmitExecution:
    | {
        readonly _tag: "WorkspaceMain";
        readonly executionId: ExecutionId;
        readonly workspaceId: import("@arbor/domain").WorkspaceId;
        readonly episode: ExecutionEpisodeBinding;
      }
    | {
        readonly _tag: "ExecutionBound";
        readonly executionId: ExecutionId;
        readonly workspaceId: import("@arbor/domain").WorkspaceId;
        readonly parentExecutionId: ExecutionId | null;
        readonly mission: string;
        readonly sessionId: import("@arbor/domain").SessionId;
      };
  readonly StopExecution: { readonly executionId: ExecutionId };
  readonly SettleExecution: {
    readonly executionId: ExecutionId;
    readonly settlement: ExternalExecutionSettlement;
    readonly expectedFencingGeneration?: LeaseGeneration;
  };
  readonly SendMessage: SendMessagePayload;
  readonly DeclareDependency: DeclareDependencyPayload;
  readonly ProduceDeliverable: ProduceDeliverablePayload;
  readonly SatisfyDependency: SatisfyDependencyPayload;
  readonly RecordDecision: RecordDecisionPayload;
  readonly ResolveControlApproval: ResolveControlApprovalPayload;
  readonly SteerWork: SteerWorkPayload;
  readonly AcceptWorkOutcome: AcceptWorkOutcomePayload;
  readonly CompleteWork: CompleteWorkPayload;
  readonly StartVerification: StartVerificationPayload;
  readonly RecordVerificationEvidence: RecordVerificationEvidencePayload;
  readonly ConcludeVerification: ConcludeVerificationPayload;
  readonly GrantPermission: GrantPermissionPayload;
  readonly RevokePermission: RevokePermissionPayload;
  readonly SubmitHumanMessage: SubmitHumanMessagePayload;
  readonly ResumeConversationResponse: ResumeConversationResponsePayload;
  readonly CancelConversationResponse: CancelConversationResponsePayload;
}

type ExternalCompletedResult = Exclude<
  CompletedResult,
  { readonly _tag: "CoordinationCompleted" | "QueryCompleted" }
>;

type ExternalExecutionSettlement =
  | { readonly _tag: "Completed"; readonly result: ExternalCompletedResult }
  | { readonly _tag: "Interrupted"; readonly result: InterruptedResult }
  | { readonly _tag: "Failed"; readonly failure: ExecutionFailure }
  | {
      readonly _tag: "OutcomeUnknown";
      readonly reconciliation: ReconciliationRequired;
    };

export type SemanticExternalCommand = {
  [K in RegisteredCommandType]: {
    readonly commandType: K;
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly actor: import("@arbor/domain").Actor;
    readonly issuedAt: string;
    readonly payload: ExternalCommandPayloadMap[K];
  };
}[RegisteredCommandType];

type Rule =
  | { readonly kind: "string" }
  | { readonly kind: "non-empty-string" }
  | { readonly kind: "opaque-identifier" }
  | { readonly kind: "boolean" }
  | { readonly kind: "integer" }
  | { readonly kind: "id"; readonly idType: IdTypeName }
  | { readonly kind: "actor" }
  | { readonly kind: "literal"; readonly value: string | number | boolean }
  | { readonly kind: "nullable"; readonly inner: Rule }
  | { readonly kind: "optional"; readonly inner: Rule }
  | { readonly kind: "array"; readonly item: Rule }
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, Rule>> }
  | { readonly kind: "record" }
  | {
      readonly kind: "union";
      readonly tag: string;
      readonly cases: Readonly<Record<string, Rule>>;
    };

const string: Rule = { kind: "string" };
const nonEmptyString: Rule = { kind: "non-empty-string" };
const opaqueIdentifier: Rule = { kind: "opaque-identifier" };
const boolean: Rule = { kind: "boolean" };
const integer: Rule = { kind: "integer" };
const record: Rule = { kind: "record" };
const id = (idType: IdTypeName): Rule => ({ kind: "id", idType });
const actor: Rule = { kind: "actor" };
const literal = (value: string | number | boolean): Rule => ({
  kind: "literal",
  value,
});
const nullable = (inner: Rule): Rule => ({ kind: "nullable", inner });
const optional = (inner: Rule): Rule => ({ kind: "optional", inner });
const array = (item: Rule): Rule => ({ kind: "array", item });
const object = (fields: Readonly<Record<string, Rule>>): Rule => ({
  kind: "object",
  fields,
});
const union = (tag: string, cases: Readonly<Record<string, Rule>>): Rule => ({
  kind: "union",
  tag,
  cases,
});

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

const payloadRules: Readonly<Record<RegisteredCommandType, Rule>> = {
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
  SteerWork: object({
    workId: id("WorkId"),
    workspaceId: id("WorkspaceId"),
    steer: object({
      severity: enumRule("Normal", "Critical"),
      guidance: string,
      scope: optional(enumRule("Direction", "Constraint")),
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
    capability: string,
    target: nullable(string),
    expiresAt: nullable(string),
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

const externalOriginPolicies: Readonly<
  Record<RegisteredCommandType, ExternalOriginPolicy>
> = {
  CreateProject: "human/bootstrap",
  CreateChildWorkspace: "reject external",
  AssignWork: "reject external; agent-originated",
  RenameProject: "reject external",
  CloseProject: "reject external",
  SelectCurrentWork: "reject external; scheduler-originated",
  AdmitExecution: "reject external under P13 U-3",
  StopExecution: "human/parent external; runtime remains typed internal",
  SettleExecution: "reject external; ExecutionOrigin/RecoveryController",
  SendMessage: "reject external; agent-originated",
  DeclareDependency: "reject external; producer Agent",
  ProduceDeliverable: "reject external; producer Agent",
  SatisfyDependency: "reject external; dependency coordinator",
  RecordDecision: "external human governance",
  ResolveControlApproval: "external human approval",
  SteerWork: "external human",
  AcceptWorkOutcome:
    "external root-parent/human; parent-agent remains typed internal",
  CompleteWork: "reject external",
  StartVerification: "reject external; Verification consumer/runtime",
  RecordVerificationEvidence: "reject external; Verification consumer/runtime",
  ConcludeVerification: "reject external; Verification consumer/runtime",
  GrantPermission: "external only when P12 authority resolves the principal",
  RevokePermission: "external only when P12 authority resolves the principal",
  SubmitHumanMessage: "external authenticated human",
  ResumeConversationResponse:
    "reject external unless P17 establishes the route",
  CancelConversationResponse:
    "reject external unless P17 establishes the route",
};

export interface CommandInputContract {
  readonly commandType: RegisteredCommandType;
  readonly externalWireCodecVersion: typeof EXTERNAL_WIRE_CODEC_VERSION;
  readonly externalOriginPolicy: ExternalOriginPolicy;
  readonly externalOriginAllowed: boolean;
  readonly decodePayload: (payload: unknown) => DecodeCommandPayloadResult;
}

export interface CommandInputContractRegistry {
  readonly commandTypes: ReadonlyArray<RegisteredCommandType>;
  readonly lookup: (commandType: string) => CommandInputContract | undefined;
}

const COMMAND_TYPES = Object.freeze(
  Object.keys(payloadRules) as RegisteredCommandType[],
);

export const makeCommandInputContractRegistry = (
  registeredHandlerTypes: ReadonlyArray<string> = COMMAND_TYPES,
): CommandInputContractRegistry => {
  const registeredSet = new Set(registeredHandlerTypes);
  const knownTypes = new Set<string>(COMMAND_TYPES);
  const requiredTypes = COMMAND_TYPES.filter(
    (commandType) => commandType !== "ResolveControlApproval",
  );
  if (
    registeredSet.size !== registeredHandlerTypes.length ||
    registeredHandlerTypes.some(
      (commandType) => !knownTypes.has(commandType),
    ) ||
    requiredTypes.some((commandType) => !registeredSet.has(commandType))
  ) {
    throw new Error(
      "command input contract registry does not match registered handlers",
    );
  }
  const contractTypes = Object.freeze(
    COMMAND_TYPES.filter((commandType) => registeredSet.has(commandType)),
  );
  const contracts = new Map<RegisteredCommandType, CommandInputContract>(
    contractTypes.map((commandType) => [
      commandType,
      {
        commandType,
        externalWireCodecVersion: EXTERNAL_WIRE_CODEC_VERSION,
        externalOriginPolicy: externalOriginPolicies[commandType],
        externalOriginAllowed:
          !externalOriginPolicies[commandType].startsWith("reject external"),
        decodePayload: (payload) =>
          decodeAgainstRule(payloadRules[commandType], payload),
      },
    ]),
  );
  return {
    commandTypes: contractTypes,
    lookup: (commandType) =>
      contracts.get(commandType as RegisteredCommandType),
  };
};

export const CommandInputContractRegistry = makeCommandInputContractRegistry();

export interface ExternalCommandDecoder {
  readonly decode: <K extends RegisteredCommandType>(
    commandType: K,
    payload: unknown,
  ) => DecodeCommandPayloadResult<ExternalCommandPayloadMap[K]>;
  readonly decodeEnvelope: (envelope: unknown) => DecodeExternalCommandResult;
}

export type DecodedExternalCommandEnvelope = SemanticExternalCommand;

export type DecodeExternalCommandResult =
  | { readonly ok: true; readonly value: DecodedExternalCommandEnvelope }
  | { readonly ok: false; readonly issues: ReadonlyArray<CommandInputIssue> };

export const makeExternalCommandDecoder = (
  registry: CommandInputContractRegistry = CommandInputContractRegistry,
): ExternalCommandDecoder => ({
  decode: (commandType, payload) => {
    const contract = registry.lookup(commandType);
    if (contract === undefined) {
      return { ok: false, issues: [{ path: [], rule: "unsupported-command" }] };
    }
    return contract.decodePayload(payload) as DecodeCommandPayloadResult<
      ExternalCommandPayloadMap[typeof commandType]
    >;
  },
  decodeEnvelope: (envelope) => decodeEnvelopeWithRegistry(registry, envelope),
});

export const ExternalCommandDecoder = makeExternalCommandDecoder();

export const decodeCommandPayload = (
  commandType: RegisteredCommandType,
  payload: unknown,
): DecodeCommandPayloadResult<ExternalCommandPayloadMap[typeof commandType]> =>
  ExternalCommandDecoder.decode(commandType, payload);

export const decodeExternalCommand = (
  envelope: unknown,
): DecodeExternalCommandResult =>
  ExternalCommandDecoder.decodeEnvelope(envelope);

const INVALID = Symbol("invalid command input");
type Invalid = typeof INVALID;
type IssueSink = Array<CommandInputIssue>;

const decodeAgainstRule = (
  rule: Rule,
  input: unknown,
): DecodeCommandPayloadResult => {
  const issues: IssueSink = [];
  const value = decodeValue(rule, input, [], issues);
  const stableIssues = [
    ...new Map(
      issues.map((issue) => [
        `${issue.path.map((part) => `${typeof part}:${String(part)}`).join("/")}\0${issue.rule}`,
        issue,
      ]),
    ).values(),
  ].sort(compareIssues);
  if (stableIssues.length > 0 || value === INVALID) {
    return { ok: false, issues: stableIssues };
  }
  return { ok: true, value };
};

const compareIssues = (
  left: CommandInputIssue,
  right: CommandInputIssue,
): number => {
  const leftPath = left.path.map(String).join("\0");
  const rightPath = right.path.map(String).join("\0");
  return compareText(leftPath, rightPath) || compareText(left.rule, right.rule);
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const addIssue = (
  issues: IssueSink,
  path: ReadonlyArray<string | number>,
  rule: CommandInputIssueRule,
): void => {
  issues.push({ path, rule });
};

const decodeValue = (
  rule: Rule,
  input: unknown,
  path: ReadonlyArray<string | number>,
  issues: IssueSink,
): unknown | Invalid => {
  switch (rule.kind) {
    case "optional":
      return input === undefined
        ? undefined
        : decodeValue(rule.inner, input, path, issues);
    case "nullable":
      return input === null
        ? null
        : decodeValue(rule.inner, input, path, issues);
    case "string":
      if (typeof input === "string") return input;
      addIssue(issues, path, "type");
      return INVALID;
    case "non-empty-string":
      if (typeof input === "string" && input.length > 0) return input;
      addIssue(issues, path, typeof input === "string" ? "format" : "type");
      return INVALID;
    case "opaque-identifier":
      if (
        typeof input === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input)
      ) {
        return input;
      }
      addIssue(issues, path, typeof input === "string" ? "format" : "type");
      return INVALID;
    case "boolean":
      if (typeof input === "boolean") return input;
      addIssue(issues, path, "type");
      return INVALID;
    case "integer":
      if (typeof input !== "number" || !Number.isFinite(input)) {
        addIssue(issues, path, "type");
        return INVALID;
      }
      if (!Number.isInteger(input) || input < 0) {
        addIssue(issues, path, "range");
        return INVALID;
      }
      return input;
    case "id":
      try {
        return Schema.decodeUnknownSync(ID_SCHEMAS[rule.idType])(input);
      } catch {
        addIssue(issues, path, typeof input === "string" ? "format" : "type");
        return INVALID;
      }
    case "actor":
      try {
        return Schema.decodeUnknownSync(Actor)(input);
      } catch {
        addIssue(issues, path, typeof input === "string" ? "format" : "type");
        return INVALID;
      }
    case "literal":
      if (input === rule.value) return input;
      addIssue(
        issues,
        path,
        typeof input === typeof rule.value ? "enum" : "type",
      );
      return INVALID;
    case "array": {
      if (!Array.isArray(input)) {
        addIssue(issues, path, "type");
        return INVALID;
      }
      const output: unknown[] = [];
      input.forEach((item, index) => {
        const decoded = decodeValue(rule.item, item, [...path, index], issues);
        if (decoded !== INVALID && decoded !== undefined) output.push(decoded);
      });
      return output;
    }
    case "object": {
      if (!isRecord(input)) {
        addIssue(issues, path, "type");
        return INVALID;
      }
      const fieldNames = Object.keys(rule.fields);
      for (const key of Object.keys(input)) {
        if (!Object.hasOwn(rule.fields, key))
          addIssue(issues, [...path, "<unknown-field>"], "unknown-field");
      }
      const output: Record<string, unknown> = {};
      for (const key of fieldNames) {
        const fieldRule = rule.fields[key];
        if (fieldRule === undefined) continue;
        if (!Object.hasOwn(input, key)) {
          if (fieldRule.kind !== "optional")
            addIssue(issues, [...path, key], "required");
          continue;
        }
        const decoded = decodeValue(
          fieldRule,
          input[key],
          [...path, key],
          issues,
        );
        if (decoded !== INVALID && decoded !== undefined) {
          Object.defineProperty(output, key, {
            value: decoded,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
      return output;
    }
    case "union": {
      if (rule.tag === "__enum") {
        const enumCase =
          typeof input === "string" && Object.hasOwn(rule.cases, input)
            ? rule.cases[input]
            : undefined;
        if (enumCase === undefined) {
          addIssue(issues, path, typeof input === "string" ? "enum" : "type");
          return INVALID;
        }
        return input;
      }
      if (!isRecord(input)) {
        addIssue(issues, path, "type");
        return INVALID;
      }
      const tagValue = input[rule.tag];
      if (typeof tagValue !== "string") {
        addIssue(
          issues,
          [...path, rule.tag],
          Object.hasOwn(input, rule.tag) ? "type" : "required",
        );
        return INVALID;
      }
      const selected = Object.hasOwn(rule.cases, tagValue)
        ? rule.cases[tagValue]
        : undefined;
      if (selected === undefined) {
        addIssue(issues, [...path, rule.tag], "enum");
        return INVALID;
      }
      return decodeValue(selected, input, path, issues);
    }
    case "record":
      if (!isRecord(input)) {
        addIssue(issues, path, "type");
        return INVALID;
      }
      return decodeJson(input, path, issues);
  }
};

const decodeEnvelopeWithRegistry = (
  registry: CommandInputContractRegistry,
  envelope: unknown,
): DecodeExternalCommandResult => {
  if (!isRecord(envelope)) {
    return { ok: false, issues: [{ path: [], rule: "type" }] };
  }
  const commandType = envelope.commandType;
  if (
    typeof commandType !== "string" ||
    registry.lookup(commandType) === undefined
  ) {
    return {
      ok: false,
      issues: [{ path: ["commandType"], rule: "unsupported-command" }],
    };
  }
  const envelopeRule = object({
    commandType: literal(commandType),
    commandId: id("CommandId"),
    projectId: id("ProjectId"),
    actor,
    issuedAt: string,
    payload: payloadRules[commandType as RegisteredCommandType],
  });
  const decoded = decodeAgainstRule(envelopeRule, envelope);
  if (!decoded.ok) return decoded;
  return { ok: true, value: decoded.value as DecodedExternalCommandEnvelope };
};

const decodeJson = (
  input: unknown,
  path: ReadonlyArray<string | number>,
  issues: IssueSink,
): unknown | Invalid => {
  if (input === null || typeof input === "string" || typeof input === "boolean")
    return input;
  if (typeof input === "number") {
    if (Number.isFinite(input)) return input;
    addIssue(issues, path, "range");
    return INVALID;
  }
  if (Array.isArray(input)) {
    const output: unknown[] = [];
    input.forEach((value, index) => {
      const decoded = decodeJson(value, [...path, index], issues);
      if (decoded !== INVALID) output.push(decoded);
    });
    return output;
  }
  if (!isRecord(input)) {
    addIssue(issues, path, "type");
    return INVALID;
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const decoded = decodeJson(value, [...path, "<unknown-field>"], issues);
    if (decoded !== INVALID)
      Object.defineProperty(output, key, {
        value: decoded,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  return output;
};
