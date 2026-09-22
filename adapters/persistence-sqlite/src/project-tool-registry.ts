import {
  ProjectToolRegistry,
  type ProjectToolRegistryError,
  type ToolDefinition,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

interface ContentHashRow {
  readonly content_hash: string;
}

interface DefinitionsRow {
  readonly definitions_json: string;
}

/**
 * P12 `01` §5.2 — the durable `project_tool_registry` store.
 *
 * `register` is invoked only by the `RegisterProjectTool` handler inside the
 * CommandGateway transaction (CI-1 / NEW-13). A registration is project-scoped
 * and may contribute multiple `ToolDefinition`s. Idempotency is key-exact
 * within a project: the same `(project_id, plugin_id, plugin_version,
 * content_hash)` is a replay no-op; the same `(project_id, plugin_id,
 * plugin_version)` with a different `content_hash` is a typed
 * `IdempotencyConflict` (never a silent overwrite).
 *
 * `listRegisteredToolDefinitions` is a committed-read enumeration (no
 * `TransactionScope`): the table only ever contains committed registrations.
 */
export const ProjectToolRegistryLive: Layer.Layer<
  ProjectToolRegistry,
  never,
  SqlClient
> = Layer.effect(
  ProjectToolRegistry,
  Effect.gen(function* () {
    const sql = yield* SqlClient;

    const run = <A>(
      effect: Effect.Effect<A, SqlError>,
    ): Effect.Effect<A, ProjectToolRegistryError> =>
      effect.pipe(
        Effect.mapError(
          (cause): ProjectToolRegistryError => ({
            _tag: "ProjectToolRegistryFailure",
            cause,
          }),
        ),
      );

    const parseDefinitions = (json: string): ReadonlyArray<ToolDefinition> =>
      JSON.parse(json) as ReadonlyArray<ToolDefinition>;

    return ProjectToolRegistry.of({
      register: (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const existing = yield* run(
            sql.unsafe<ContentHashRow>(
              "SELECT content_hash FROM project_tool_registry WHERE project_id = ? AND plugin_id = ? AND plugin_version = ?",
              [input.projectId, input.pluginId, input.pluginVersion],
            ),
          );
          const current = existing[0];
          if (current !== undefined) {
            if (current.content_hash !== input.contentHash) {
              return yield* Effect.fail<ProjectToolRegistryError>({
                _tag: "IdempotencyConflict",
                pluginId: input.pluginId,
                pluginVersion: input.pluginVersion,
                existingContentHash: current.content_hash,
                incomingContentHash: input.contentHash,
              });
            }
            return;
          }
          yield* run(
            sql.unsafe(
              "INSERT INTO project_tool_registry (project_id, plugin_id, plugin_version, content_hash, definitions_json, registered_at) VALUES (?,?,?,?,?,?)",
              [
                input.projectId,
                input.pluginId,
                input.pluginVersion,
                input.contentHash,
                JSON.stringify(input.definitions),
                new Date().toISOString(),
              ],
            ),
          );
        }),
      lookup: (key) =>
        Effect.gen(function* () {
          const rows = yield* run(
            sql.unsafe<DefinitionsRow>(
              "SELECT definitions_json FROM project_tool_registry WHERE project_id = ? AND plugin_id = ? AND plugin_version = ? AND content_hash = ?",
              [key.projectId, key.pluginId, key.pluginVersion, key.contentHash],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some(parseDefinitions(row.definitions_json));
        }),
      listRegisteredToolDefinitions: (projectId) =>
        Effect.gen(function* () {
          const rows = yield* run(
            sql.unsafe<DefinitionsRow>(
              "SELECT definitions_json FROM project_tool_registry WHERE project_id = ? ORDER BY registered_at, plugin_id, plugin_version, content_hash",
              [projectId],
            ),
          );
          return rows.flatMap((row) => parseDefinitions(row.definitions_json));
        }),
    });
  }),
);
