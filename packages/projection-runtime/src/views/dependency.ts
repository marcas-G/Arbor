import type { Dependency, ProjectId, Work, WorkspaceId } from "@arbor/domain";
import { Effect, Option } from "effect";
import type { ProjectionReadError } from "../errors.js";
import { projectionReadError } from "../errors.js";
import type { DependencyRowView } from "./shared.js";

export type { DependencyRowView };

// --- P10 `01` §1 Dependency View (SD §12.1/§13.9; P10 `05` §1 cores) -----
//
// Derive inputs: dependencies + deliverables + work_waits (P10 `01`
// frozen row) — satisfiedBy renders the bound deliverable (the
// deliverable row itself is referenced by id; no extra shape is read).
// Scoping: `projectId | workspaceId` exactly one of the two.

/** Mirrors the frozen DependencyReq core: exactly one of
 * projectId | workspaceId. */
export type DependencyViewRequest =
  | { readonly projectId: ProjectId; readonly workspaceId?: undefined }
  | { readonly projectId?: undefined; readonly workspaceId: WorkspaceId };

export interface DependencyViewDeps {
  readonly listDependenciesByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<Dependency>, ProjectionReadError>;
  readonly listWorksByWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<Work>, ProjectionReadError>;
  readonly findWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<
    Option.Option<{ readonly projectId: ProjectId }>,
    ProjectionReadError
  >;
}

const toRow = (dependency: Dependency): DependencyRowView => ({
  dependencyId: dependency.dependencyId,
  consumerWorkId: dependency.consumerWorkId,
  binding: dependency.producerBinding,
  state: dependency.state,
  satisfiedBy: dependency.satisfiedByDeliverableId ?? undefined,
});

/** DependencyRes core derive — read-only; rows ordered by dependencyId. */
export const deriveDependencyRows = (
  request: DependencyViewRequest,
  deps: DependencyViewDeps,
): Effect.Effect<ReadonlyArray<DependencyRowView>, ProjectionReadError> =>
  Effect.gen(function* () {
    if (request.projectId !== undefined) {
      const rows = yield* deps.listDependenciesByProject(request.projectId);
      return rows.map(toRow);
    }
    const workspace = yield* deps.findWorkspace(request.workspaceId);
    if (Option.isNone(workspace)) {
      return yield* Effect.fail(
        projectionReadError(`no workspace ${request.workspaceId}`),
      );
    }
    const works = yield* deps.listWorksByWorkspace(request.workspaceId);
    const owned = new Set(works.map((work) => work.workId));
    const rows = yield* deps.listDependenciesByProject(
      workspace.value.projectId,
    );
    return rows
      .filter((dependency) => owned.has(dependency.consumerWorkId))
      .map(toRow);
  });
