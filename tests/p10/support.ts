import type {
  Workspace,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import type { ProjectionQueryRuntimeDeps } from "../../packages/projection-runtime/src/index.js";
import { makeProjectionQueryService } from "../../packages/projection-runtime/src/index.js";
import type { P10FixtureDeps } from "../support/p10-fixture.js";
import { p10Child, p10Leaf, p10Root } from "../support/p10-fixture.js";

export const makeQueryService = (deps: P10FixtureDeps) =>
  makeProjectionQueryService({
    journalLastSequence: deps.journalLastSequence,
    projectIdOfWorkspace: deps.projectIdOfWorkspace,
    tree: deps.tree,
    attention: deps.attention,
    workspaceDetail: deps.workspaceDetail,
    workDetail: deps.workDetail,
    currentWork: deps.currentWork,
    verification: deps.verificationView,
    dependency: deps.dependencyView,
    transcript: deps.transcript,
    usage: deps.usage,
    inboxView: deps.inboxView,
    effectiveFacts: deps.effectiveFacts,
    inboxReconcile: deps.inboxReconcile,
  });

export const runtimeDepsOf = (
  deps: P10FixtureDeps,
  snapshotWatermark: NonNullable<
    ProjectionQueryRuntimeDeps["snapshotWatermark"]
  >,
  catchUp: NonNullable<ProjectionQueryRuntimeDeps["catchUp"]>,
): ProjectionQueryRuntimeDeps => ({
  journalLastSequence: deps.journalLastSequence,
  projectIdOfWorkspace: deps.projectIdOfWorkspace,
  snapshotWatermark,
  catchUp,
  tree: deps.tree,
  attention: deps.attention,
  workspaceDetail: deps.workspaceDetail,
  workDetail: deps.workDetail,
  currentWork: deps.currentWork,
  verification: deps.verificationView,
  dependency: deps.dependencyView,
  transcript: deps.transcript,
  usage: deps.usage,
  inboxView: deps.inboxView,
  effectiveFacts: deps.effectiveFacts,
  inboxReconcile: deps.inboxReconcile,
});

export const malformedTreeCases: ReadonlyArray<{
  readonly label: string;
  readonly arrange: (
    workspaces: ReadonlyArray<Workspace>,
  ) => ReadonlyArray<Workspace>;
}> = [
  {
    label: "zero root",
    arrange: (workspaces) =>
      workspaces.map((workspace) =>
        workspace.workspaceId === p10Root
          ? { ...workspace, parentWorkspaceId: p10Child }
          : workspace,
      ),
  },
  {
    label: "multiple roots",
    arrange: (workspaces) =>
      workspaces.map((workspace) =>
        workspace.workspaceId === p10Child
          ? { ...workspace, parentWorkspaceId: null }
          : workspace,
      ),
  },
  {
    label: "dangling parent",
    arrange: (workspaces) =>
      workspaces.map((workspace) =>
        workspace.workspaceId === p10Child
          ? {
              ...workspace,
              parentWorkspaceId:
                "ws_00000000-0000-7000-8000-0000000000ff" as WorkspaceId,
            }
          : workspace,
      ),
  },
  {
    label: "cycle",
    arrange: (workspaces) =>
      workspaces.map((workspace) =>
        workspace.workspaceId === p10Child
          ? { ...workspace, parentWorkspaceId: p10Leaf }
          : workspace.workspaceId === p10Leaf
            ? { ...workspace, parentWorkspaceId: p10Child }
            : workspace,
      ),
  },
];
