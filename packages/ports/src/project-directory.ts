import type {
  ProjectId,
  ProjectLifecycle,
  Revision,
  WorkspaceId,
} from "@arbor/domain";
import { Context, type Effect } from "effect";

export interface ProjectDirectoryRow {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly lifecycle: ProjectLifecycle;
  readonly rootWorkspaceId: WorkspaceId;
  readonly revision: Revision;
  readonly updatedAt: string;
}

export interface ProjectDirectoryReadError {
  readonly _tag: "ProjectDirectoryReadError";
  readonly cause: unknown;
}

/** P15 local single-user directory. No pagination or multi-principal claims. */
export interface ProjectDirectoryService {
  readonly list: () => Effect.Effect<
    ReadonlyArray<ProjectDirectoryRow>,
    ProjectDirectoryReadError
  >;
}

export class ProjectDirectory extends Context.Service<
  ProjectDirectory,
  ProjectDirectoryService
>()("arbor/ProjectDirectory") {}
