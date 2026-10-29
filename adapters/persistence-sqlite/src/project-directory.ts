import { isProjectResourceSource } from "@arbor/domain";
import type {
  ProjectDirectoryReadError,
  ProjectDirectoryRow,
  ProjectDirectoryService,
} from "@arbor/ports";
import { ProjectDirectory } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { persistenceCorruption } from "./repository-error.js";

interface ProjectDirectoryDbRow {
  readonly project_id: string;
  readonly name: string;
  readonly lifecycle: "Open" | "Closed";
  readonly root_workspace_id: string;
  readonly revision: number;
  readonly updated_at: string;
  readonly resource_source_json: string;
}

export const ProjectDirectoryLive: Layer.Layer<
  ProjectDirectory,
  never,
  SqlClient
> = Layer.effect(
  ProjectDirectory,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = (cause: unknown): ProjectDirectoryReadError => ({
      _tag: "ProjectDirectoryReadError",
      cause,
    });
    return ProjectDirectory.of({
      list: () =>
        sql
          .unsafe<ProjectDirectoryDbRow>(
            "SELECT project_id, name, lifecycle, root_workspace_id, revision, updated_at, resource_source_json FROM projects ORDER BY updated_at DESC, project_id ASC",
          )
          .pipe(
            Effect.mapError(failure),
            Effect.flatMap((rows) => {
              const projects: ProjectDirectoryRow[] = [];
              for (const row of rows) {
                let resourceSource: unknown;
                try {
                  resourceSource = JSON.parse(row.resource_source_json);
                } catch {
                  return Effect.fail({
                    _tag: "ProjectDirectoryReadError" as const,
                    cause: persistenceCorruption(
                      "ProjectRepository",
                      "decodeResourceSource",
                      "Stored ProjectResourceSource is invalid",
                    ),
                  });
                }
                if (!isProjectResourceSource(resourceSource)) {
                  return Effect.fail({
                    _tag: "ProjectDirectoryReadError" as const,
                    cause: persistenceCorruption(
                      "ProjectRepository",
                      "decodeResourceSource",
                      "Stored ProjectResourceSource is invalid",
                    ),
                  });
                }
                projects.push({
                  projectId: row.project_id as ProjectDirectoryRow["projectId"],
                  name: row.name,
                  lifecycle: row.lifecycle,
                  rootWorkspaceId:
                    row.root_workspace_id as ProjectDirectoryRow["rootWorkspaceId"],
                  revision: row.revision as ProjectDirectoryRow["revision"],
                  updatedAt: row.updated_at,
                  resourceSource,
                });
              }
              return Effect.succeed(projects);
            }),
          ),
    } satisfies ProjectDirectoryService);
  }),
);
