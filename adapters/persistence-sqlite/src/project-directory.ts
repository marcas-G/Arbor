import type {
  ProjectDirectoryReadError,
  ProjectDirectoryRow,
  ProjectDirectoryService,
} from "@arbor/ports";
import { ProjectDirectory } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

interface ProjectDirectoryDbRow {
  readonly project_id: string;
  readonly name: string;
  readonly lifecycle: "Open" | "Closed";
  readonly root_workspace_id: string;
  readonly revision: number;
  readonly updated_at: string;
}

export const ProjectDirectoryLive: Layer.Layer<
  ProjectDirectory,
  never,
  SqlClient
> = Layer.effect(
  ProjectDirectory,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = (cause: SqlError): ProjectDirectoryReadError => ({
      _tag: "ProjectDirectoryReadError",
      cause,
    });
    return ProjectDirectory.of({
      list: () =>
        sql
          .unsafe<ProjectDirectoryDbRow>(
            "SELECT project_id, name, lifecycle, root_workspace_id, revision, updated_at FROM projects ORDER BY updated_at DESC, project_id ASC",
          )
          .pipe(
            Effect.mapError(failure),
            Effect.map(
              (rows): ReadonlyArray<ProjectDirectoryRow> =>
                rows.map((row) => ({
                  projectId: row.project_id as ProjectDirectoryRow["projectId"],
                  name: row.name,
                  lifecycle: row.lifecycle,
                  rootWorkspaceId:
                    row.root_workspace_id as ProjectDirectoryRow["rootWorkspaceId"],
                  revision: row.revision as ProjectDirectoryRow["revision"],
                  updatedAt: row.updated_at,
                })),
            ),
          ),
    } satisfies ProjectDirectoryService);
  }),
);
