import {
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

export const BUILTIN_TOOLS: ReadonlyArray<ToolDefinition> = [
  READ_DEFINITION,
  PATCH_DEFINITION,
  SHELL_DEFINITION,
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

export const ToolCatalogPortLive: Layer.Layer<ToolCatalogPort> = Layer.succeed(
  ToolCatalogPort,
  {
    visibleRefs: () =>
      Effect.succeed(
        BUILTIN_TOOLS.map(
          (tool): ToolDefinitionRef => ({
            name: tool.name,
            version: tool.version,
            hash: tool.hash,
          }),
        ),
      ),
    resolveForModel: (ref) => {
      const found = BUILTIN_TOOLS.find(
        (tool) =>
          tool.name === ref.name &&
          tool.version === ref.version &&
          tool.hash === ref.hash,
      );
      if (found === undefined) {
        return Effect.fail({ _tag: "ToolNotRegistered" as const, ref });
      }
      return Effect.succeed({
        name: found.name,
        description: found.description,
        schemaJson: found.inputSchemaJson,
        version: found.version,
        hash: found.hash,
        capabilityMetadata: found.capabilityMetadata,
        sideEffectSemantics: found.sideEffectSemantics,
      });
    },
  },
);
