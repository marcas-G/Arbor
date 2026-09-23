import type {
  Execution,
  Work,
  WorkId,
  Workspace,
  WorkspaceId,
} from "@arbor/domain";
import { Effect, Option } from "effect";
import type { ProjectionReadError } from "../errors.js";
import { projectionReadError } from "../errors.js";
import type { CurrentWorkSummaryView, ExecutionSummaryView } from "./shared.js";

export type { CurrentWorkSummaryView, ExecutionSummaryView };

export interface CurrentWorkDeps {
  readonly findWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<Option.Option<Workspace>, ProjectionReadError>;
  readonly findWork: (
    workId: WorkId,
  ) => Effect.Effect<Option.Option<Work>, ProjectionReadError>;
  readonly findActiveMainExecution: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<Option.Option<Execution>, ProjectionReadError>;
}

/** CurrentWorkRes core: `{workId?, objective, status, revision, activeExecution?} |
 * null` — null when the workspace has no current work. Read-only. */
export const deriveCurrentWork = (
  workspaceId: WorkspaceId,
  deps: CurrentWorkDeps,
): Effect.Effect<CurrentWorkSummaryView | null, ProjectionReadError> =>
  Effect.gen(function* () {
    const found = yield* deps.findWorkspace(workspaceId);
    if (Option.isNone(found)) {
      return yield* Effect.fail(
        projectionReadError(`no workspace ${workspaceId}`),
      );
    }
    const workspace = found.value;
    if (workspace.currentWorkId === null) {
      return null;
    }
    const work = yield* deps.findWork(workspace.currentWorkId);
    if (Option.isNone(work)) {
      return null;
    }
    const activeMain = yield* deps.findActiveMainExecution(workspaceId);
    return {
      workId: work.value.workId,
      objective: work.value.objective,
      status: work.value.lifecycle,
      revision: work.value.revision,
      activeExecution: Option.isSome(activeMain)
        ? {
            executionId: activeMain.value.executionId,
            admittedAt: activeMain.value.admittedAt,
          }
        : undefined,
    };
  });
