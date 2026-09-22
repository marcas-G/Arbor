import {
  type ProjectId,
  ProjectToolRegistry,
  ToolCatalogPort,
  type ToolDefinition,
  type ToolDefinitionRef,
  ToolDefinitionStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";

/** P4 `01` §1, `08` §1–§4; DID v1.8 G5/G6. Exact input/result schemas are
 * frozen contract for each tool version. */

const READ_INPUT_SCHEMA = JSON.stringify({
  type: "object",
  required: ["path"],
  properties: {
    path: {
      oneOf: [
        {
          type: "object",
          required: ["_tag", "path"],
          properties: { _tag: { const: "FileTree" }, path: { type: "string" } },
        },
        {
          type: "object",
          required: ["_tag", "path"],
          properties: {
            _tag: { const: "GitWorktree" },
            path: { type: "string" },
          },
        },
      ],
    },
    offset: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 0 },
  },
});

const READ_RESULT_SCHEMA = JSON.stringify({
  type: "object",
  required: ["text", "truncated", "byteSize"],
  properties: {
    text: { type: "string" },
    truncated: { type: "boolean" },
    byteSize: { type: "integer" },
  },
});

const PATCH_INPUT_SCHEMA = JSON.stringify({
  type: "object",
  required: ["path", "unifiedDiff"],
  properties: {
    path: { type: "object", required: ["_tag", "path"] },
    unifiedDiff: { type: "string" },
  },
});

const PATCH_RESULT_SCHEMA = JSON.stringify({
  type: "object",
  required: ["applied", "hunks"],
  properties: { applied: { type: "boolean" }, hunks: { type: "integer" } },
});

const SHELL_INPUT_SCHEMA = JSON.stringify({
  type: "object",
  required: ["command", "cwd"],
  properties: {
    command: { type: "string" },
    cwd: { type: "object", required: ["_tag", "path"] },
    timeoutMs: { type: "integer", minimum: 1 },
  },
});

const SHELL_RESULT_SCHEMA = JSON.stringify({
  type: "object",
  required: ["exitCode", "stdoutRef", "stderrRef", "truncated"],
  properties: {
    exitCode: { type: "integer" },
    stdoutRef: { type: "string" },
    stderrRef: { type: "string" },
    truncated: { type: "boolean" },
  },
});

const LIST_INPUT_SCHEMA = JSON.stringify({
  type: "object",
  required: ["path"],
  properties: {
    path: {
      oneOf: [
        {
          type: "object",
          required: ["_tag", "path"],
          properties: { _tag: { const: "FileTree" }, path: { type: "string" } },
        },
        {
          type: "object",
          required: ["_tag", "path"],
          properties: {
            _tag: { const: "GitWorktree" },
            path: { type: "string" },
          },
        },
      ],
    },
    depth: { type: "integer", minimum: 0 },
  },
});

const LIST_RESULT_SCHEMA = JSON.stringify({
  type: "object",
  required: ["entries", "truncated"],
  properties: {
    entries: { type: "array", items: { type: "string" } },
    truncated: { type: "boolean" },
  },
});

export const READ_DEFINITION: ToolDefinition = {
  name: "read",
  version: "1",
  hash: "read-v1",
  description:
    "Read a bounded slice of a file inside the admitted resource regions.",
  inputSchemaJson: READ_INPUT_SCHEMA,
  resultSchemaJson: READ_RESULT_SCHEMA,
  capabilityMetadata: ["fs:read"],
  sideEffectSemantics: "ReadOnly",
  source: "Builtin",
};

export const PATCH_DEFINITION: ToolDefinition = {
  name: "patch",
  version: "1",
  hash: "patch-v1",
  description:
    "Apply a unified diff to a file inside the admitted resource regions.",
  inputSchemaJson: PATCH_INPUT_SCHEMA,
  resultSchemaJson: PATCH_RESULT_SCHEMA,
  capabilityMetadata: ["fs:write"],
  sideEffectSemantics: "Idempotent",
  source: "Builtin",
};

export const SHELL_DEFINITION: ToolDefinition = {
  name: "shell",
  version: "1",
  hash: "shell-v1",
  description: "Run a policy-checked shell command inside the sandbox.",
  inputSchemaJson: SHELL_INPUT_SCHEMA,
  resultSchemaJson: SHELL_RESULT_SCHEMA,
  capabilityMetadata: ["shell:exec"],
  sideEffectSemantics: "Reconcilable",
  source: "Builtin",
};

/** P12 `12` §6: a non-`read`/`patch`/`shell` builtin, added through the
 * generic `ToolDefinition` + `ToolExecutor` seam (P4 pipeline unchanged). */
export const LIST_DEFINITION: ToolDefinition = {
  name: "list",
  version: "1",
  hash: "list-v1",
  description:
    "List files and directories inside an admitted resource region, bounded by depth.",
  inputSchemaJson: LIST_INPUT_SCHEMA,
  resultSchemaJson: LIST_RESULT_SCHEMA,
  capabilityMetadata: ["fs:read"],
  sideEffectSemantics: "ReadOnly",
  source: "Builtin",
};

export const BUILTIN_TOOLS: ReadonlyArray<ToolDefinition> = [
  READ_DEFINITION,
  PATCH_DEFINITION,
  SHELL_DEFINITION,
  LIST_DEFINITION,
];

export const ToolDefinitionStoreLive: Layer.Layer<ToolDefinitionStore> =
  Layer.succeed(ToolDefinitionStore, {
    definition: (name: string, version: string) => {
      const found = BUILTIN_TOOLS.find(
        (tool) => tool.name === name && tool.version === version,
      );
      return Effect.succeed(
        found === undefined ? Option.none() : Option.some(found),
      );
    },
    all: () => Effect.succeed(BUILTIN_TOOLS),
  });

/** P12 cross-contract completeness correction (`01` §5.2 / `07` §2):
 * composition config for the catalog union. `projectId` is supplied by the
 * Composition Root; absent means the catalogued set is the builtins only. */
export interface ToolCatalogConfig {
  readonly projectId?: ProjectId;
}

const toRef = (tool: ToolDefinition): ToolDefinitionRef => ({
  name: tool.name,
  version: tool.version,
  hash: tool.hash,
});

const matchesRef = (tool: ToolDefinition, ref: ToolDefinitionRef): boolean =>
  tool.name === ref.name &&
  tool.version === ref.version &&
  tool.hash === ref.hash;

/**
 * `CataloguedTools = Builtins ∪ CommittedRegisteredProjectToolDefinitions`.
 *
 * `visibleRefs()` and `resolveForModel(ref)` derive from the same union. The
 * union is composed here (the catalog implementation) from the
 * `ProjectToolRegistry` port; Model Context depends only on `ToolCatalogPort`.
 * The registry read is committed-read (no `TransactionScope`). A durable-read
 * failure cannot be represented in the frozen `ToolCatalogPortService` error
 * channels (`visibleRefs` has `E = never`; `resolveForModel` has
 * `E = ToolCatalogError`), so it is raised as a defect (`Effect.orDie`), never
 * a silent placeholder.
 */
export const ToolCatalogPortLive = (
  config: ToolCatalogConfig = {},
): Layer.Layer<ToolCatalogPort, never, ProjectToolRegistry> =>
  Layer.effect(
    ToolCatalogPort,
    Effect.gen(function* () {
      const registry = yield* ProjectToolRegistry;
      const projectId = config.projectId;

      const catalogued = (): Effect.Effect<ReadonlyArray<ToolDefinition>> => {
        if (projectId === undefined) {
          return Effect.succeed(BUILTIN_TOOLS);
        }
        return registry.listRegisteredToolDefinitions(projectId).pipe(
          Effect.map(
            (registered): ReadonlyArray<ToolDefinition> => [
              ...BUILTIN_TOOLS,
              ...registered,
            ],
          ),
          Effect.orDie,
        );
      };

      return ToolCatalogPort.of({
        visibleRefs: () =>
          catalogued().pipe(Effect.map((tools) => tools.map(toRef))),
        resolveForModel: (ref) =>
          Effect.gen(function* () {
            const tools = yield* catalogued();
            const found = tools.find((tool) => matchesRef(tool, ref));
            if (found === undefined) {
              return yield* Effect.fail({
                _tag: "ToolNotRegistered" as const,
                ref,
              });
            }
            return {
              name: found.name,
              description: found.description,
              schemaJson: found.inputSchemaJson,
              version: found.version,
              hash: found.hash,
              capabilityMetadata: found.capabilityMetadata,
              sideEffectSemantics: found.sideEffectSemantics,
            };
          }),
      });
    }),
  );
