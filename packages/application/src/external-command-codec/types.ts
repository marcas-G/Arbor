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
import type {
  AcceptWorkOutcomePayload,
  CompleteWorkPayload,
} from "../commands/accept-complete.js";
import type { AssignWorkPayload } from "../commands/assign-work.js";
import type {
  ConcludeVerificationPayload,
  RecordVerificationEvidencePayload,
} from "../commands/conclude-verification.js";
import type {
  CancelConversationResponsePayload,
  ResumeConversationResponsePayload,
} from "../commands/conversation-response.js";
import type { CreateChildWorkspacePayload } from "../commands/create-child-workspace.js";
import type { CreateProjectPayload } from "../commands/create-project.js";
import type { DecideSandboxPolicyPayload } from "../commands/decide-sandbox-policy.js";
import type { DeclareDependencyPayload } from "../commands/declare-dependency.js";
import type { DeliverMessagePayload } from "../commands/deliver-message.js";
import type { GrantPermissionPayload } from "../commands/grant-permission.js";
import type { ProduceDeliverablePayload } from "../commands/produce-deliverable.js";
import type {
  CloseProjectPayload,
  RenameProjectPayload,
} from "../commands/project-management.js";
import type { RecordDecisionPayload } from "../commands/record-decision.js";
import type { ResolveControlApprovalPayload } from "../commands/resolve-control-approval.js";
import type { ResolveExecutableApprovalPayload } from "../commands/resolve-executable-approval.js";
import type { RetryVerificationPayload } from "../commands/retry-verification.js";
import type { RevokePermissionPayload } from "../commands/revoke-permission.js";
import type { SatisfyDependencyPayload } from "../commands/satisfy-dependency.js";
import type { SelectCurrentWorkPayload } from "../commands/select-current-work.js";
import type { SendMessagePayload } from "../commands/send-message.js";
import type { StartVerificationPayload } from "../commands/start-verification.js";
import type { SteerWorkPayload } from "../commands/steer-work.js";
import type { SubmitHumanMessagePayload } from "../commands/submit-human-message.js";
import type {
  AuthorizeWorkspaceSandboxPayload,
  RevokeWorkspaceSandboxAuthorizationPayload,
} from "../commands/workspace-sandbox-authorization.js";

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
  | "DeliverMessage"
  | "DeclareDependency"
  | "ProduceDeliverable"
  | "SatisfyDependency"
  | "RecordDecision"
  | "ResolveControlApproval"
  | "ResolveExecutableApproval"
  | "SteerWork"
  | "AcceptWorkOutcome"
  | "CompleteWork"
  | "StartVerification"
  | "RecordVerificationEvidence"
  | "ConcludeVerification"
  | "RetryVerification"
  | "GrantPermission"
  | "DecideSandboxPolicy"
  | "AuthorizeWorkspaceSandbox"
  | "RevokeWorkspaceSandboxAuthorization"
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
  | "authenticated local human external governance; exact actor/principal and ProjectGovernanceAuthority; no Agent origin"
  | "reject external; producer Agent"
  | "reject external; dependency coordinator"
  | "external human governance"
  | "external human approval"
  | "external human"
  | "external root-parent/human; parent-agent remains typed internal"
  | "reject external; Verification consumer/runtime"
  | "external only when P12 authority resolves the principal"
  | "external authenticated human"
  | "authenticated human external response retry"
  | "authenticated human external response cancellation"
  | "reject external unless P17 establishes the route";

export type CommandInputIssueRule =
  | "required"
  | "type"
  | "format"
  | "range"
  | "enum"
  | "unknown-field"
  | "unsupported-command"
  | "unsupported-version";

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
  readonly DeliverMessage: DeliverMessagePayload;
  readonly DeclareDependency: DeclareDependencyPayload;
  readonly ProduceDeliverable: ProduceDeliverablePayload;
  readonly SatisfyDependency: SatisfyDependencyPayload;
  readonly RecordDecision: RecordDecisionPayload;
  readonly ResolveControlApproval: ResolveControlApprovalPayload;
  readonly ResolveExecutableApproval: ResolveExecutableApprovalPayload;
  readonly SteerWork: SteerWorkPayload;
  readonly AcceptWorkOutcome: AcceptWorkOutcomePayload;
  readonly CompleteWork: CompleteWorkPayload;
  readonly StartVerification: StartVerificationPayload;
  readonly RecordVerificationEvidence: RecordVerificationEvidencePayload;
  readonly ConcludeVerification: ConcludeVerificationPayload;
  readonly RetryVerification: RetryVerificationPayload;
  readonly GrantPermission: GrantPermissionPayload;
  readonly DecideSandboxPolicy: DecideSandboxPolicyPayload;
  readonly AuthorizeWorkspaceSandbox: AuthorizeWorkspaceSandboxPayload;
  readonly RevokeWorkspaceSandboxAuthorization: RevokeWorkspaceSandboxAuthorizationPayload;
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
