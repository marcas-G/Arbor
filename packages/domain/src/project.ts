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

const PROJECT_NAME_MAX_SCALARS = 120;
const UNSAFE_PROJECT_NAME = /[\p{Cc}\p{Cf}\p{Cs}]/u;

/** Local-product ProjectName v1: deterministic, useful and intentionally
 * smaller than the previously proposed UTS#39 directory policy. */
export const normalizeProjectName = (input: string): DomainResult<string> => {
  const normalized = input
    .normalize("NFC")
    .replace(/\p{White_Space}+/gu, " ")
    .trim();
  const length = [...normalized].length;
  if (length === 0 || length > PROJECT_NAME_MAX_SCALARS) {
    return err({
      _tag: "InvalidProjectName",
      reason: `name must contain 1..${PROJECT_NAME_MAX_SCALARS} Unicode scalars`,
    });
  }
  if (UNSAFE_PROJECT_NAME.test(normalized)) {
    return err({
      _tag: "InvalidProjectName",
      reason: "name contains control, format, or surrogate characters",
    });
  }
  return ok(normalized);
};

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

export interface RenameProjectInput {
  readonly authorized: boolean;
  readonly expectedRevision: Revision;
  readonly name: string;
}

/** P15 `01`: name is a canonical Project field. The application boundary owns
 * the versioned Unicode policy; this pure aggregate preserves the authority,
 * lifecycle and optimistic-concurrency invariants. */
export const renameProject = (
  project: Project,
  input: RenameProjectInput,
): DomainResult<Project> => {
  if (project.lifecycle !== "Open") {
    return err(closedProjectError(project));
  }
  if (!input.authorized) {
    return err({
      _tag: "AuthorityDenied",
      reason: "RenameProject requires authority",
    });
  }
  if (project.revision !== input.expectedRevision) {
    return err({
      _tag: "RevisionConflict",
      expected: input.expectedRevision,
      actual: project.revision,
    });
  }
  const name = normalizeProjectName(input.name);
  if (!name.ok) {
    return name;
  }
  return ok({
    ...project,
    name: name.value,
    revision: incrementOrdinal(Revision)(project.revision),
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
