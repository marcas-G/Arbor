import { ControlToolCatalogPort } from "@arbor/ports";
import { Effect, Layer } from "effect";

export {
  type AgentAction,
  type AgentActionError,
  type AgentActionHandler,
  type AgentActionHandlerInput,
  type AgentActionOutcome,
  type ControlToolDecodeError,
  type ControlToolInvocation,
  ControlToolRegistry,
  type ControlToolRegistryService,
  type ExecutableInvocationHandler,
  type ExecutableInvocationInput,
  type ExecutableInvocationOutcome,
} from "./control-types.js";

import {
  type AgentAction,
  type AgentActionHandler,
  type ControlToolDecodeError,
  ControlToolRegistry,
  type ControlToolRegistryService,
} from "./control-types.js";

export type ToolRouteClassification =
  | { readonly _tag: "Executable" }
  | { readonly _tag: "Control" }
  | { readonly _tag: "Stale"; readonly route: "Control" }
  | {
      readonly _tag: "Invalid";
      readonly reason: "UnknownTool" | "RouteRegistryMismatch";
    };

/** Classification intersects the exact current-turn route manifest with
 * ControlToolRegistry identity. It never infers category from descriptions. */
export const classifyToolRoute = (
  toolRoutes: ReadonlyArray<{
    readonly name: string;
    readonly route: "Executable" | "Control";
    readonly version?: string;
    readonly hash?: string;
  }>,
  registry: Pick<ControlToolRegistryService, "classify" | "definitions">,
  toolName: string,
): ToolRouteClassification => {
  const route = toolRoutes.find((candidate) => candidate.name === toolName);
  if (route === undefined) return { _tag: "Invalid", reason: "UnknownTool" };
  const registryRoute = registry.classify(toolName);
  if (
    (route.route === "Control" && registryRoute !== "Control") ||
    (route.route === "Executable" && registryRoute === "Control")
  ) {
    return { _tag: "Invalid", reason: "RouteRegistryMismatch" };
  }
  if (route.route === "Control" && route.version !== undefined) {
    const current = registry
      .definitions()
      .find((definition) => definition.name === toolName);
    if (
      current === undefined ||
      current.version !== route.version ||
      (route.hash !== undefined && current.hash !== route.hash)
    ) {
      return { _tag: "Stale", route: "Control" };
    }
  }
  return { _tag: route.route };
};

import { controlToolDefinitions } from "./control-catalog.js";
import { decodeControlInvocation } from "./control-decoder.js";

export const makeControlToolRegistry = (
  handlers: ReadonlyArray<AgentActionHandler> = [],
): ControlToolRegistryService => {
  const waitHandler: AgentActionHandler = {
    action: "Wait",
    handle: ({ action, execution }) => {
      if (action._tag !== "Wait") {
        return Effect.fail({
          _tag: "AgentActionError",
          cause: "Wait handler received a different AgentAction",
        });
      }
      if (
        execution.binding._tag !== "WorkspaceExecution" ||
        execution.binding.focus._tag !== "Work"
      ) {
        return Effect.fail({
          _tag: "AgentActionError",
          cause:
            "Wait requires an active Work binding for durable WorkWait registration",
        });
      }
      return Effect.succeed({
        _tag: "Settle",
        settlement: {
          _tag: "Completed",
          result: {
            _tag: "Yielded",
            reason: action.reason,
            waitSpec: action.waitSpec,
          },
        },
      });
    },
  };
  const allHandlers = [
    waitHandler,
    ...handlers.filter((handler) => handler.action !== "Wait"),
  ];
  const handlerMap = new Map(
    allHandlers.map((handler) => [handler.action, handler] as const),
  );
  const allDefinitions = controlToolDefinitions();
  const definitionAction: Readonly<
    Record<(typeof allDefinitions)[number]["name"], AgentAction["_tag"]>
  > = {
    arbor_wait: "Wait",
    arbor_send_message: "SendMessage",
    arbor_claim_completion: "ClaimCompletion",
    arbor_propose_child_workspace: "ProposeChildWorkspace",
    arbor_spawn_specialist: "SpawnSpecialist",
    arbor_declare_dependency: "DeclareDependency",
    arbor_record_verification_evidence: "RecordVerificationEvidence",
    arbor_conclude_verification: "ConcludeVerification",
  };
  const registered = allDefinitions.filter((tool) => {
    const action = definitionAction[tool.name];
    return action !== undefined && handlerMap.has(action);
  });
  const names = new Set(registered.map((tool) => tool.name));
  const visibleDefinitions = () => Effect.succeed(registered);
  return {
    definitions: () => registered,
    visibleDefinitions,
    classify: (toolName) => (names.has(toolName) ? "Control" : "NotControl"),
    decode: (invocation) =>
      names.has(invocation.toolName)
        ? decodeControlInvocation(invocation)
        : Effect.fail<ControlToolDecodeError>({
            _tag: "UnknownControlTool",
            toolName: invocation.toolName,
          }),
    handle: (input) => {
      const handler = handlerMap.get(input.action._tag);
      return handler === undefined
        ? Effect.fail({
            _tag: "AgentActionError",
            cause: `no handler registered for ${input.action._tag}`,
          })
        : handler.handle(input);
    },
  };
};

export const ControlToolRegistryLive = (
  handlers: ReadonlyArray<AgentActionHandler> = [],
): Layer.Layer<ControlToolRegistry | ControlToolCatalogPort> => {
  const registry = makeControlToolRegistry(handlers);
  return Layer.merge(
    Layer.succeed(ControlToolRegistry, registry),
    Layer.succeed(ControlToolCatalogPort, {
      visibleDefinitions: registry.visibleDefinitions,
    }),
  );
};
