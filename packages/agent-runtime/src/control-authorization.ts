import type {
  CommandSubmissionContext,
  Execution,
  PermissionGrant,
} from "@arbor/domain";
import type { ControlBasis, ToolInvocation } from "@arbor/model-context";
import { Context, type Effect } from "effect";
import type { AgentAction } from "./control-types.js";

export type ControlAuthorizationDecision =
  | {
      readonly _tag: "Authorized";
      readonly authorityRef: string;
      readonly approvalId?: string;
      readonly approvalRevision?: number;
      readonly actionDigest: string;
      readonly controlBasisDigest: string;
    }
  | {
      readonly _tag: "ApprovalRequired";
      readonly approvalId: string;
      readonly revision: number;
    }
  | { readonly _tag: "Denied"; readonly reason: string };

export interface ControlActionAuthorizerService {
  readonly authorize: (input: {
    readonly action: AgentAction;
    readonly invocation: ToolInvocation;
    readonly execution: Execution;
    readonly context: CommandSubmissionContext;
    readonly controlBasis: ControlBasis;
  }) => Effect.Effect<ControlAuthorizationDecision, never>;
  readonly consumeApproval: (input: {
    readonly approvalId: string;
    readonly approvalRevision: number;
    readonly actionDigest: string;
    readonly controlBasisDigest: string;
  }) => Effect.Effect<boolean, never>;
}

export class ControlActionAuthorizer extends Context.Service<
  ControlActionAuthorizer,
  ControlActionAuthorizerService
>()("arbor/ControlActionAuthorizer") {}

export const permissionGrantMatchesExecution = (
  grant: PermissionGrant,
  input: {
    readonly execution: Execution;
    readonly principal: string;
    readonly capability: string;
    readonly targetRef: string;
    readonly now: string;
  },
): boolean => {
  if (
    grant.state !== "Active" ||
    grant.subject === undefined ||
    grant.capability === undefined ||
    grant.validFrom === undefined ||
    Date.parse(input.now) < Date.parse(grant.validFrom) ||
    (grant.expiresAt != null &&
      Date.parse(input.now) >= Date.parse(grant.expiresAt))
  ) {
    return false;
  }
  const subjectMatches =
    (grant.subject._tag === "HumanPrincipal" &&
      grant.subject.principal === input.principal) ||
    (grant.subject._tag === "WorkspaceAgent" &&
      grant.subject.workspaceId === input.execution.workspaceId) ||
    (grant.subject._tag === "Execution" &&
      grant.subject.executionId === input.execution.executionId);
  return (
    subjectMatches &&
    (grant.capability === input.capability || grant.capability === "*") &&
    (grant.target == null || grant.target === input.targetRef)
  );
};
