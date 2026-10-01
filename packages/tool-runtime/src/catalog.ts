import {
  type ProjectId,
  ProjectToolRegistry,
  ToolCatalogPort,
  type ToolDefinition,
  type ToolDefinitionRef,
  ToolDefinitionStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";

/** P4 `01` §1, `08`; DID v1.25 EWB. Exact input/result schemas are
 * frozen contract for each tool version. */

const TARGET_SCHEMA = {
  type: "object",
  required: ["mount", "path"],
  additionalProperties: false,
  properties: {
    mount: { type: "string", minLength: 1 },
    path: { type: "string", minLength: 1 },
  },
} as const;

const READ_INPUT_SCHEMA = JSON.stringify({
  type: "object",
  required: ["target"],
  additionalProperties: false,
  properties: {
    target: TARGET_SCHEMA,
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
  required: ["target", "unifiedDiff"],
  additionalProperties: false,
  properties: {
    target: TARGET_SCHEMA,
    unifiedDiff: { type: "string" },
  },
});

const PATCH_RESULT_SCHEMA = JSON.stringify({
  type: "object",
  required: ["applied", "hunks", "created"],
  properties: {
    applied: { type: "boolean" },
    hunks: { type: "integer" },
    created: { type: "boolean" },
  },
});

const SHELL_INPUT_SCHEMA = JSON.stringify({
  type: "object",
  required: ["command", "cwd"],
  additionalProperties: false,
  properties: {
    command: { type: "string" },
    cwd: TARGET_SCHEMA,
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
  required: ["target"],
  additionalProperties: false,
  properties: {
    target: TARGET_SCHEMA,
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
  version: "2",
  hash: "read-v2-mount-relative",
  description:
    "Read a bounded slice of a workspace-relative file. Use mount 'workspace' for the current coding worktree.",
  inputSchemaJson: READ_INPUT_SCHEMA,
  resultSchemaJson: READ_RESULT_SCHEMA,
  capabilityMetadata: ["fs:read"],
  sideEffectSemantics: "ReadOnly",
  source: "Builtin",
};

export const PATCH_DEFINITION: ToolDefinition = {
  name: "patch",
  version: "2",
  hash: "patch-v2-mount-relative-create",
  description:
    "Create or update one workspace-relative file with an idempotent unified diff.",
  inputSchemaJson: PATCH_INPUT_SCHEMA,
  resultSchemaJson: PATCH_RESULT_SCHEMA,
  capabilityMetadata: ["fs:write"],
  sideEffectSemantics: "Idempotent",
  source: "Builtin",
};

export const SHELL_DEFINITION: ToolDefinition = {
  name: "shell",
  version: "2",
  hash: "shell-v2-mount-relative-cwd",
  description:
    "Run a policy-checked shell command with a workspace-relative cwd.",
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
  version: "2",
  hash: "list-v2-mount-relative",
  description:
    "List a workspace-relative directory, bounded by depth. Use target { mount: 'workspace', path: '.' } for the root.",
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
