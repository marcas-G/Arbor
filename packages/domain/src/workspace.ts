import type { ResponsibilityBoundAgentBinding } from "./authority.js";
import type { ProducerBinding } from "./dependency.js";
import type { ProjectId, SessionId, WorkId, WorkspaceId } from "./ids.js";
import {
  incrementOrdinal,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
} from "./ordinals.js";
import type {
  ResourceBoundary,
  ResponsibilityDefinition,
} from "./resources.js";
import type { DomainResult } from "./result.js";
import { err, ok } from "./result.js";
import type { SessionBinding } from "./session.js";

declare const WorkspacePolicyBrand: unique symbol;

export type WorkspacePolicy = Readonly<Record<string, unknown>> & {
  readonly [WorkspacePolicyBrand]: "WorkspacePolicy";
};

export const makeWorkspacePolicy = (
  values: Readonly<Record<string, unknown>> = {},
): WorkspacePolicy => values as WorkspacePolicy;

export type WorkspaceLifecycle = "Active" | "Retired";

export interface Workspace {
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly parentWorkspaceId: WorkspaceId | null;
  readonly name: string;
  readonly responsibilityDefinition: ResponsibilityDefinition;
  readonly responsibilityRevision: ResponsibilityRevision;
  readonly resourceBoundary: ResourceBoundary;
  readonly resourceBoundaryRevision: ResourceBoundaryRevision;
  readonly agentBinding: ResponsibilityBoundAgentBinding;
  readonly primarySessionId: SessionId;
  readonly currentWorkId: WorkId | null;
  readonly workspacePolicy: WorkspacePolicy;
  readonly workspacePolicyRevision: Revision;
  readonly revision: Revision;
  readonly lifecycle: WorkspaceLifecycle;
}

export interface CreateWorkspaceInput {
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly parentWorkspaceId: WorkspaceId | null;
  readonly name: string;
  readonly responsibilityDefinition: ResponsibilityDefinition;
  readonly responsibilityRevision: ResponsibilityRevision;
  readonly resourceBoundary: ResourceBoundary;
  readonly resourceBoundaryRevision: ResourceBoundaryRevision;
  readonly agentBinding: ResponsibilityBoundAgentBinding;
  readonly primarySessionId: SessionId;
  readonly workspacePolicy: WorkspacePolicy;
  readonly workspacePolicyRevision: Revision;
  readonly revision: Revision;
}

export const createWorkspace = (input: CreateWorkspaceInput): Workspace => ({
  ...input,
  currentWorkId: null,
  lifecycle: "Active",
});

const retiredError = () => ({
  _tag: "TerminalLifecycleMutation" as const,
  entity: "Workspace",
  lifecycle: "Retired",
});

const authorityError = (operation: string) => ({
  _tag: "AuthorityDenied" as const,
  reason: `${operation} requires authority`,
});

const revisionError = (expected: Revision, actual: Revision) => ({
  _tag: "RevisionConflict" as const,
  expected,
  actual,
});

export interface CreateChildWorkspaceInput {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly responsibilityDefinition: ResponsibilityDefinition;
  readonly responsibilityRevision: ResponsibilityRevision;
  readonly resourceBoundary: ResourceBoundary;
  readonly resourceBoundaryRevision: ResourceBoundaryRevision;
  readonly agentBinding: ResponsibilityBoundAgentBinding;
  readonly primarySessionId: SessionId;
  readonly workspacePolicy: WorkspacePolicy;
  readonly workspacePolicyRevision: Revision;
  readonly revision: Revision;
  readonly authorized: boolean;
}

export const createChildWorkspace = (
  parent: Workspace,
  input: CreateChildWorkspaceInput,
): DomainResult<Workspace> => {
  if (parent.lifecycle !== "Active") {
    return err(retiredError());
  }
  if (!input.authorized) {
    return err(authorityError("CreateChildWorkspace"));
  }
  return ok({
    workspaceId: input.workspaceId,
    projectId: parent.projectId,
    parentWorkspaceId: parent.workspaceId,
    name: input.name,
    responsibilityDefinition: input.responsibilityDefinition,
    responsibilityRevision: input.responsibilityRevision,
    resourceBoundary: input.resourceBoundary,
    resourceBoundaryRevision: input.resourceBoundaryRevision,
    agentBinding: input.agentBinding,
    primarySessionId: input.primarySessionId,
    currentWorkId: null,
    workspacePolicy: input.workspacePolicy,
    workspacePolicyRevision: input.workspacePolicyRevision,
    revision: input.revision,
    lifecycle: "Active",
  });
};

export interface ChangeResponsibilityInput {
  readonly authorized: boolean;
  readonly expectedRevision: Revision;
  readonly responsibilityDefinition: ResponsibilityDefinition;
}

export const changeResponsibility = (
  workspace: Workspace,
  input: ChangeResponsibilityInput,
): DomainResult<Workspace> => {
  if (workspace.lifecycle !== "Active") {
    return err(retiredError());
  }
  if (!input.authorized) {
    return err(authorityError("ChangeResponsibility"));
  }
  if (workspace.revision !== input.expectedRevision) {
    return err(revisionError(input.expectedRevision, workspace.revision));
  }
  return ok({
    ...workspace,
    responsibilityDefinition: input.responsibilityDefinition,
    responsibilityRevision: incrementOrdinal(ResponsibilityRevision)(
      workspace.responsibilityRevision,
    ),
    revision: incrementOrdinal(Revision)(workspace.revision),
  });
};

export interface UpdateResourceBoundaryInput {
  readonly authorized: boolean;
  readonly expectedRevision: Revision;
  readonly resourceBoundary: ResourceBoundary;
  readonly ownershipOverlapDetected: boolean;
}

export const updateResourceBoundary = (
  workspace: Workspace,
  input: UpdateResourceBoundaryInput,
): DomainResult<Workspace> => {
  if (workspace.lifecycle !== "Active") {
    return err(retiredError());
  }
  if (!input.authorized) {
    return err(authorityError("UpdateResourceBoundary"));
  }
  if (workspace.revision !== input.expectedRevision) {
    return err(revisionError(input.expectedRevision, workspace.revision));
  }
  if (input.ownershipOverlapDetected) {
    return err({
      _tag: "AuthorityDenied",
      reason: "UpdateResourceBoundary rejected: write ownership overlap",
    });
  }
  return ok({
    ...workspace,
    resourceBoundary: input.resourceBoundary,
    resourceBoundaryRevision: incrementOrdinal(ResourceBoundaryRevision)(
      workspace.resourceBoundaryRevision,
    ),
    revision: incrementOrdinal(Revision)(workspace.revision),
  });
};

export interface UpdateWorkspacePolicyInput {
  readonly authorized: boolean;
  readonly expectedRevision: Revision;
  readonly workspacePolicy: WorkspacePolicy;
}

export const updateWorkspacePolicy = (
  workspace: Workspace,
  input: UpdateWorkspacePolicyInput,
): DomainResult<Workspace> => {
  if (workspace.lifecycle !== "Active") {
    return err(retiredError());
  }
  if (!input.authorized) {
    return err(authorityError("UpdateWorkspacePolicy"));
  }
  if (workspace.revision !== input.expectedRevision) {
    return err(revisionError(input.expectedRevision, workspace.revision));
  }
  return ok({
    ...workspace,
    workspacePolicy: input.workspacePolicy,
    workspacePolicyRevision: incrementOrdinal(Revision)(
      workspace.workspacePolicyRevision,
    ),
    revision: incrementOrdinal(Revision)(workspace.revision),
  });
};

export interface CandidateWorkFact {
  readonly workId: WorkId;
  readonly workspaceId: WorkspaceId;
  readonly lifecycle: "Open" | "Completed" | "Cancelled";
}

export interface ActiveMainFocusFact {
  readonly kind: "Work" | "Coordination";
  readonly workId: WorkId | null;
}

export interface SelectCurrentWorkInput {
  readonly authorized: boolean;
  readonly expectedRevision: Revision;
  readonly candidate: CandidateWorkFact;
  readonly activeMainFocus: ActiveMainFocusFact | null;
}

export const selectCurrentWork = (
  workspace: Workspace,
  input: SelectCurrentWorkInput,
): DomainResult<Workspace> => {
  if (workspace.lifecycle !== "Active") {
    return err(retiredError());
  }
  if (!input.authorized) {
    return err(authorityError("SelectCurrentWork"));
  }
  if (workspace.revision !== input.expectedRevision) {
    return err(revisionError(input.expectedRevision, workspace.revision));
  }
  if (input.candidate.workspaceId !== workspace.workspaceId) {
    return err({
      _tag: "AuthorityDenied",
      reason: "SelectCurrentWork candidate must belong to this Workspace",
    });
  }
  if (input.candidate.lifecycle !== "Open") {
    return err({ _tag: "WorkNotOpen", workId: input.candidate.workId });
  }
  const focus = input.activeMainFocus;
  if (
    focus !== null &&
    focus.kind === "Work" &&
    focus.workId === workspace.currentWorkId
  ) {
    return err({
      _tag: "ActiveExecutionConflict",
      workspaceId: workspace.workspaceId,
    });
  }
  return ok({
    ...workspace,
    currentWorkId: input.candidate.workId,
    revision: incrementOrdinal(Revision)(workspace.revision),
  });
};

export interface ReplacePrimarySessionInput {
  readonly authorized: boolean;
  readonly expectedRevision: Revision;
  readonly targetSessionId: SessionId;
  readonly targetBinding: SessionBinding;
  readonly hasActiveMainExecution: boolean;
}

export const replacePrimarySession = (
  workspace: Workspace,
  input: ReplacePrimarySessionInput,
): DomainResult<Workspace> => {
  if (workspace.lifecycle !== "Active") {
    return err(retiredError());
  }
  if (!input.authorized) {
    return err(authorityError("ReplacePrimarySession"));
  }
  if (workspace.revision !== input.expectedRevision) {
    return err(revisionError(input.expectedRevision, workspace.revision));
  }
  if (input.targetBinding._tag !== "WorkspacePrimary") {
    return err({
      _tag: "AuthorityDenied",
      reason: "ReplacePrimarySession target must be a WorkspacePrimary binding",
    });
  }
  if (input.hasActiveMainExecution) {
    return err({
      _tag: "ActiveExecutionConflict",
      workspaceId: workspace.workspaceId,
    });
  }
  return ok({
    ...workspace,
    primarySessionId: input.targetSessionId,
    revision: incrementOrdinal(Revision)(workspace.revision),
  });
};

export interface IncomingDependencyFact {
  readonly producerBinding: ProducerBinding;
  readonly producerWorkWorkspaceId: WorkspaceId | null;
  readonly unresolved: boolean;
  readonly resolvedOrReplacedInSameGovernanceChange: boolean;
}

export interface RetireWorkspaceInput {
  readonly authorized: boolean;
  readonly expectedRevision: Revision;
  readonly isRoot: boolean;
  readonly hasActiveMainExecution: boolean;
  readonly hasOpenWork: boolean;
  readonly hasActiveChildWorkspace: boolean;
  readonly hasActiveResourceOwnershipClaim: boolean;
  readonly incomingDependencies: ReadonlyArray<IncomingDependencyFact>;
}

const blocksRetire = (
  fact: IncomingDependencyFact,
  workspaceId: WorkspaceId,
): boolean => {
  if (!fact.unresolved || fact.resolvedOrReplacedInSameGovernanceChange) {
    return false;
  }
  if (fact.producerBinding._tag === "WorkspaceBound") {
    return fact.producerBinding.workspaceId === workspaceId;
  }
  if (fact.producerBinding._tag === "WorkBound") {
    return fact.producerWorkWorkspaceId === workspaceId;
  }
  return false;
};

export const retireWorkspace = (
  workspace: Workspace,
  input: RetireWorkspaceInput,
): DomainResult<Workspace> => {
  if (!input.authorized) {
    return err(authorityError("RetireWorkspace"));
  }
  if (workspace.revision !== input.expectedRevision) {
    return err(revisionError(input.expectedRevision, workspace.revision));
  }
  const reasons: string[] = [];
  if (workspace.lifecycle !== "Active") {
    reasons.push("already retired");
  }
  if (input.isRoot) {
    reasons.push("root workspace");
  }
  if (input.hasActiveMainExecution) {
    reasons.push("active main execution");
  }
  if (workspace.currentWorkId !== null) {
    reasons.push("current work set");
  }
  if (input.hasOpenWork) {
    reasons.push("open work");
  }
  if (input.hasActiveChildWorkspace) {
    reasons.push("active child workspace");
  }
  if (input.hasActiveResourceOwnershipClaim) {
    reasons.push("active resource ownership claim");
  }
  if (
    input.incomingDependencies.some((fact) =>
      blocksRetire(fact, workspace.workspaceId),
    )
  ) {
    reasons.push("unresolved incoming dependency");
  }
  if (reasons.length > 0) {
    return err({
      _tag: "RetirePreconditionFailed",
      workspaceId: workspace.workspaceId,
      reason: reasons.join(", "),
    });
  }
  return ok({
    ...workspace,
    lifecycle: "Retired",
    revision: incrementOrdinal(Revision)(workspace.revision),
  });
};

export type WorkspaceLineageRelation =
  | "Supersede"
  | "Split"
  | "Merge"
  | "ResponsibilityTransfer";

export interface WorkspaceLineage {
  readonly predecessorWorkspaceId: WorkspaceId;
  readonly successorWorkspaceId: WorkspaceId;
  readonly relation: WorkspaceLineageRelation;
  readonly decisionId: string;
  readonly recordedAt: string;
}

export const isWorkspaceActive = (workspace: Workspace): boolean =>
  workspace.lifecycle === "Active";

export const isWorkspaceRetired = (workspace: Workspace): boolean =>
  workspace.lifecycle === "Retired";
