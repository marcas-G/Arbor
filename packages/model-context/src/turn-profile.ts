import type { Execution } from "@arbor/domain";
import {
  ControlToolCatalogPort,
  type ControlToolCatalogPortService,
  type ModelFacingControlToolDefinition,
  type ModelFacingToolDefinition,
  sha256Hex,
  ToolCatalogPort,
  type ToolCatalogPortService,
} from "@arbor/ports";
import { Context, Effect, Layer, Option } from "effect";

export type ExecutionPurpose =
  | "RootConversationRespond"
  | "WorkspaceWork"
  | "WorkspaceCoordination"
  | "ExecutionBoundSpecialist";

export interface ResolvedTurnProfile {
  readonly purpose: ExecutionPurpose;
  readonly profileVersion: "turn-profile-v1";
  readonly outputContractRef: string;
  readonly executableTools: ReadonlyArray<ModelFacingToolDefinition>;
  readonly controlTools: ReadonlyArray<ModelFacingControlToolDefinition>;
  readonly contextPolicyRef: string;
  readonly fingerprint: string;
}

export interface TurnProfileResolverService {
  readonly resolve: (input: {
    readonly execution: Execution;
    readonly conversation: boolean;
  }) => Effect.Effect<
    ResolvedTurnProfile,
    import("@arbor/ports").ToolCatalogError
  >;
}

export class TurnProfileResolver extends Context.Service<
  TurnProfileResolver,
  TurnProfileResolverService
>()("arbor/TurnProfileResolver") {}

const purposeOf = (
  execution: Execution,
  conversation: boolean,
): ExecutionPurpose =>
  execution.binding._tag === "ExecutionBoundAgentBinding"
    ? "ExecutionBoundSpecialist"
    : conversation
      ? "RootConversationRespond"
      : execution.binding.focus._tag === "Coordination"
        ? "WorkspaceCoordination"
        : "WorkspaceWork";

const specialistControls = new Set([
  "arbor_send_message",
  "arbor_propose_child_workspace",
  "arbor_spawn_specialist",
]);

export const makeTurnProfileResolver = (dependencies: {
  readonly toolCatalog: ToolCatalogPortService;
  readonly controlCatalog?: ControlToolCatalogPortService;
}): TurnProfileResolverService => ({
  resolve: ({ execution, conversation }) =>
    Effect.gen(function* () {
      const purpose = purposeOf(execution, conversation);
      const executableTools: ModelFacingToolDefinition[] = [];
      if (purpose === "WorkspaceWork" || purpose === "WorkspaceCoordination") {
        for (const ref of yield* dependencies.toolCatalog.visibleRefs()) {
          executableTools.push(
            yield* dependencies.toolCatalog.resolveForModel(ref),
          );
        }
      }
      const allControls =
        dependencies.controlCatalog === undefined
          ? []
          : yield* dependencies.controlCatalog.visibleDefinitions();
      const controlTools =
        purpose === "RootConversationRespond"
          ? []
          : purpose === "ExecutionBoundSpecialist"
            ? allControls.filter((tool) => specialistControls.has(tool.name))
            : allControls;
      const outputContractRef =
        purpose === "RootConversationRespond"
          ? "text-response-v1"
          : "tool-invocation-v1";
      const contextPolicyRef =
        purpose === "RootConversationRespond"
          ? "root-conversation-context-v1"
          : purpose === "WorkspaceWork"
            ? "workspace-work-context-v1"
            : purpose === "WorkspaceCoordination"
              ? "workspace-coordination-context-v1"
              : "specialist-context-v1";
      const identity = {
        purpose,
        profileVersion: "turn-profile-v1" as const,
        outputContractRef,
        executableTools: executableTools.map(({ name, version, hash }) => ({
          name,
          version,
          hash,
        })),
        controlTools: controlTools.map(({ name, version, hash }) => ({
          name,
          version,
          hash,
        })),
        contextPolicyRef,
      };
      return {
        ...identity,
        executableTools,
        controlTools,
        fingerprint: `tpf_${sha256Hex(JSON.stringify(identity))}`,
      };
    }),
});

export const TurnProfileResolverLive: Layer.Layer<
  TurnProfileResolver,
  never,
  ToolCatalogPort
> = Layer.effect(
  TurnProfileResolver,
  Effect.gen(function* () {
    const toolCatalog = yield* ToolCatalogPort;
    const controlCatalog = yield* Effect.serviceOption(ControlToolCatalogPort);
    return makeTurnProfileResolver({
      toolCatalog,
      ...(Option.isSome(controlCatalog)
        ? { controlCatalog: controlCatalog.value }
        : {}),
    });
  }),
);
