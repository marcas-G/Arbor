import type { DomainError } from "./errors.js";
import type { ProjectId, WorkspaceId } from "./ids.js";
import { incrementOrdinal, Revision } from "./ordinals.js";
import type { DomainResult } from "./result.js";
import { err, ok } from "./result.js";

declare const ProjectPolicyBrand: unique symbol;

export type ProjectPolicy = Readonly<Record<string, unknown>> & {
  readonly [ProjectPolicyBrand]: "ProjectPolicy";
};

export const makeProjectPolicy = (
  values: Readonly<Record<string, unknown>> = {},
): ProjectPolicy => values as ProjectPolicy;

export type ProjectLifecycle = "Open" | "Closed";

export interface Project {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly rootWorkspaceId: WorkspaceId;
  readonly projectPolicy: ProjectPolicy;
  readonly projectPolicyRevision: Revision;
  readonly defaultConfiguration: Readonly<Record<string, unknown>>;
  readonly environmentRef: string;
  readonly lifecycle: ProjectLifecycle;
  readonly revision: Revision;
}

export interface CreateProjectInput {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly rootWorkspaceId: WorkspaceId;
  readonly projectPolicy: ProjectPolicy;
  readonly projectPolicyRevision: Revision;
  readonly revision: Revision;
  readonly defaultConfiguration?: Readonly<Record<string, unknown>>;
  readonly environmentRef?: string;
}

export const createProject = (input: CreateProjectInput): Project => ({
  projectId: input.projectId,
  name: input.name,
  rootWorkspaceId: input.rootWorkspaceId,
  projectPolicy: input.projectPolicy,
  projectPolicyRevision: input.projectPolicyRevision,
  defaultConfiguration: input.defaultConfiguration ?? {},
  environmentRef: input.environmentRef ?? "",
  lifecycle: "Open",
  revision: input.revision,
});

export interface UpdateProjectPolicyInput {
  readonly authorized: boolean;
  readonly expectedRevision: Revision;
  readonly policy: ProjectPolicy;
}

const closedProjectError = (project: Project): DomainError => ({
  _tag: "TerminalLifecycleMutation",
  entity: "Project",
  lifecycle: project.lifecycle,
});

export const updateProjectPolicy = (
  project: Project,
  input: UpdateProjectPolicyInput,
): DomainResult<Project> => {
  if (project.lifecycle !== "Open") {
    return err(closedProjectError(project));
  }
  if (!input.authorized) {
    return err({
      _tag: "AuthorityDenied",
      reason: "UpdateProjectPolicy requires authority",
    });
  }
  if (project.revision !== input.expectedRevision) {
    return err({
      _tag: "RevisionConflict",
      expected: input.expectedRevision,
      actual: project.revision,
    });
  }
  return ok({
    ...project,
    projectPolicy: input.policy,
    revision: incrementOrdinal(Revision)(project.revision),
    projectPolicyRevision: incrementOrdinal(Revision)(
      project.projectPolicyRevision,
    ),
  });
};

export interface CloseProjectInput {
  readonly authorized: boolean;
}

export const closeProject = (
  project: Project,
  input: CloseProjectInput,
): DomainResult<Project> => {
  if (project.lifecycle !== "Open") {
    return err(closedProjectError(project));
  }
  if (!input.authorized) {
    return err({
      _tag: "AuthorityDenied",
      reason: "CloseProject requires authority",
    });
  }
  return ok({
    ...project,
    lifecycle: "Closed",
    revision: incrementOrdinal(Revision)(project.revision),
  });
};

export const isProjectOpen = (project: Project): boolean =>
  project.lifecycle === "Open";

export const isProjectClosed = (project: Project): boolean =>
  project.lifecycle === "Closed";

export const allowsNewAutonomousExecution = (project: Project): boolean =>
  project.lifecycle === "Open";
