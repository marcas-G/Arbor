import type { PluginId, PluginVersion } from "@arbor/domain";
import type { ProjectToolRegistryService, ToolDefinition } from "@arbor/ports";
import { Effect } from "effect";
import { commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";

/**
 * P12 `01` §5 (G1): the explicit Project-tool registration governance command.
 *
 * A `ToolDefinition.source: "Project"` becomes supported only through this
 * command: project-supplied content is untrusted until an explicit
 * registration commits the `(pluginId, pluginVersion, contentHash)` ->
 * `ToolDefinition` binding (content/version-bound trust). The command is
 * authority-gated by `RegisterProjectToolAuthority` and writes only through
 * the `ProjectToolRegistry` port (CI-1), inside the CommandGateway
 * transaction.
 *
 * Registration does NOT change `InvocationAuthority`, the capability ceiling,
 * `SandboxPort`, or `ResourceBoundary` semantics: a registered tool still
 * passes the P4 admission pipeline with a resolver-produced authority.
 */
export interface RegisterProjectToolPayload {
  readonly pluginId: PluginId;
  readonly pluginVersion: PluginVersion;
  readonly definitions: ReadonlyArray<ToolDefinition>;
  readonly contentHash: string;
}

export interface RegisterProjectToolResult {
  readonly pluginId: PluginId;
  readonly pluginVersion: PluginVersion;
  readonly contentHash: string;
}

export interface RegisterProjectToolDependencies {
  readonly registry: ProjectToolRegistryService;
}

export const makeRegisterProjectToolHandler = (
  dependencies: RegisterProjectToolDependencies,
): CommandHandler<RegisterProjectToolPayload, RegisterProjectToolResult> => ({
  commandType: "RegisterProjectTool",
  schemaVersion: "1",
  authority: {
    tag: "RegisterProjectToolAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "RegisterProjectToolAuthority" &&
      authority.pluginId === payload.pluginId &&
      authority.pluginVersion === payload.pluginVersion &&
      authority.contentHash === payload.contentHash,
  },
  stopAdmission: { _tag: "Unclassified" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      yield* dependencies.registry.register({
        projectId: envelope.projectId,
        pluginId: payload.pluginId,
        pluginVersion: payload.pluginVersion,
        contentHash: payload.contentHash,
        definitions: payload.definitions,
      });
      return commandOk({
        result: {
          pluginId: payload.pluginId,
          pluginVersion: payload.pluginVersion,
          contentHash: payload.contentHash,
        },
        events: [],
      });
    }),
});
