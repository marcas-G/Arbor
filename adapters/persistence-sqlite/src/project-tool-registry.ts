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

interface DefinitionRow {
  readonly definition_json: string;
}

/**
 * P12 `01` §5.2 — the durable `project_tool_registry` store.
 *
 * `register` is invoked only by the `RegisterProjectTool` handler inside the
 * CommandGateway transaction (CI-1 / NEW-13). Idempotency is key-exact: the
 * same `(plugin_id, plugin_version, content_hash)` is a replay no-op; the
 * same `(plugin_id, plugin_version)` with a different `content_hash` is a
 * typed `IdempotencyConflict` (never a silent overwrite).
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

    return ProjectToolRegistry.of({
      register: (input) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const existing = yield* run(
            sql.unsafe<ContentHashRow>(
              "SELECT content_hash FROM project_tool_registry WHERE plugin_id = ? AND plugin_version = ?",
              [input.pluginId, input.pluginVersion],
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
              "INSERT INTO project_tool_registry (plugin_id, plugin_version, content_hash, definition_json, registered_at) VALUES (?,?,?,?,?)",
              [
                input.pluginId,
                input.pluginVersion,
                input.contentHash,
                JSON.stringify(input.definition),
                new Date().toISOString(),
              ],
            ),
          );
        }),
      lookup: (key) =>
        Effect.gen(function* () {
          const rows = yield* run(
            sql.unsafe<DefinitionRow>(
              "SELECT definition_json FROM project_tool_registry WHERE plugin_id = ? AND plugin_version = ? AND content_hash = ?",
              [key.pluginId, key.pluginVersion, key.contentHash],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some(JSON.parse(row.definition_json) as ToolDefinition);
        }),
    });
  }),
);
