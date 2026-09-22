import type { PluginId, PluginVersion, ProjectId } from "@arbor/domain";
import { Context, type Effect, type Option } from "effect";
import type { TransactionScope } from "./session.js";
import type { ToolDefinition } from "./tool.js";

/**
 * P12 `01` §5.2 (RG-08, E-19, R-11, NEW-13): the durable Project-tool
 * registration store.
 *
 * A registration is project-scoped (the envelope `projectId` is the relational
 * scope key) and its identity is `(pluginId, pluginVersion, contentHash)`. One
 * registration may contribute multiple `ToolDefinition`s; the value stored is
 * therefore the definitions array. Content/version-bound trust: any content or
 * version change requires a new registration.
 *
 * CI-1 (NEW-13): `register` is a durable canonical write, invocable only by
 * the `RegisterProjectTool` handler inside the `CommandGateway` transaction.
 * The port therefore carries the `TransactionScope` requirement.
 *
 * P12 cross-contract completeness correction (`01` §5.2 / `07` §2):
 * `listRegisteredToolDefinitions` is the committed-read enumeration seam used
 * by the `ToolCatalogPort` union; it MUST NOT require `TransactionScope`
 * (normal catalog reads must not force Model Context / `prepareTurn` into a
 * persistence transaction).
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
    readonly projectId: ProjectId;
    readonly pluginId: PluginId;
    readonly pluginVersion: PluginVersion;
    readonly contentHash: string;
    readonly definitions: ReadonlyArray<ToolDefinition>;
  }) => Effect.Effect<void, ProjectToolRegistryError, TransactionScope>;
  readonly lookup: (key: {
    readonly projectId: ProjectId;
    readonly pluginId: PluginId;
    readonly pluginVersion: PluginVersion;
    readonly contentHash: string;
  }) => Effect.Effect<
    Option.Option<ReadonlyArray<ToolDefinition>>,
    ProjectToolRegistryError
  >;
  /** Committed-read enumeration: the `ToolDefinition`s contributed by
   * committed registrations for the project. Only committed registrations are
   * returned; one registration may contribute multiple definitions; the
   * registry identity `(pluginId, pluginVersion, contentHash)` and each
   * `ToolDefinitionRef(name, version, hash)` remain intentionally distinct.
   * No `TransactionScope` requirement. */
  readonly listRegisteredToolDefinitions: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<ToolDefinition>, ProjectToolRegistryError>;
}

export class ProjectToolRegistry extends Context.Service<
  ProjectToolRegistry,
  ProjectToolRegistryService
>()("arbor/ProjectToolRegistry") {}
