import type { PluginId, PluginVersion } from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { TransactionScope } from "./session.js";
import type { ToolDefinition } from "./tool.js";

/**
 * P12 `01` §5.2 (RG-08, E-19, R-11, NEW-13): the durable Project-tool
 * registration store.
 *
 * The registration key is `(pluginId, pluginVersion, contentHash)` and the
 * value is the exact `ToolDefinition` the key binds — content/version-bound
 * trust: any content or version change requires a new registration.
 *
 * CI-1 (NEW-13): `register` is a durable canonical write, invocable only by
 * the `RegisterProjectTool` handler inside the `CommandGateway` transaction.
 * The port therefore carries the `TransactionScope` requirement.
 */
export type ProjectToolRegistryError =
  | {
      readonly _tag: "IdempotencyConflict";
      readonly pluginId: PluginId;
      readonly pluginVersion: PluginVersion;
      readonly existingContentHash: string;
      readonly incomingContentHash: string;
    }
  | {
      readonly _tag: "ProjectToolRegistryFailure";
      readonly cause: unknown;
    };

export interface ProjectToolRegistryService {
  readonly register: (input: {
    readonly pluginId: PluginId;
    readonly pluginVersion: PluginVersion;
    readonly contentHash: string;
    readonly definition: ToolDefinition;
  }) => Effect.Effect<void, ProjectToolRegistryError, TransactionScope>;
  readonly lookup: (key: {
    readonly pluginId: PluginId;
    readonly pluginVersion: PluginVersion;
    readonly contentHash: string;
  }) => Effect.Effect<Option.Option<ToolDefinition>, ProjectToolRegistryError>;
}

export class ProjectToolRegistry extends Context.Service<
  ProjectToolRegistry,
  ProjectToolRegistryService
>()("arbor/ProjectToolRegistry") {}
