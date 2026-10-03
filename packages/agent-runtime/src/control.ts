import { workEpisode } from "@arbor/domain";
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
  | { readonly _tag: "Control"; readonly stableId: string }
  | {
      readonly _tag: "Stale";
      readonly route: "Control";
      readonly stableId: string;
    }
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
    readonly stableId?: string;
    readonly version?: string;
    readonly hash?: string;
  }>,
  registry: Pick<ControlToolRegistryService, "classify" | "definitions">,
  toolName: string,
): ToolRouteClassification => {
  const route = toolRoutes.find((candidate) => candidate.name === toolName);
  if (route === undefined) return { _tag: "Invalid", reason: "UnknownTool" };
  const definition = registry
    .definitions()
    .find(
      (candidate) =>
        candidate.name === toolName ||
        candidate.legacyNames?.some((legacy) => legacy.name === toolName),
    );
  const registryRoute = registry.classify(toolName);
  if (
    (route.route === "Control" && registryRoute !== "Control") ||
    (route.route === "Executable" && registryRoute === "Control")
  ) {
    return { _tag: "Invalid", reason: "RouteRegistryMismatch" };
  }
  if (route.route === "Control" && route.version !== undefined) {
    const current = definition;
    const legacyMatch =
      current?.legacyNames?.some(
        (legacy) =>
          legacy.name === toolName &&
          legacy.version === route.version &&
          legacy.hash === route.hash,
      ) ?? false;
    if (
      current === undefined ||
      (route.stableId !== undefined && current.stableId !== route.stableId) ||
      (!legacyMatch &&
        (current.version !== route.version ||
          (route.hash !== undefined && current.hash !== route.hash)))
    ) {
      return {
        _tag: "Stale",
        route: "Control",
        stableId: current?.stableId ?? route.stableId ?? "unknown",
      };
    }
    return { _tag: "Control", stableId: current.stableId };
  }
  return route.route === "Control"
    ? { _tag: "Control", stableId: definition?.stableId ?? "unknown" }
    : { _tag: "Executable" };
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
          _tag: "AgentActionOperationalFailure",
          operation: "ControlRegistry.WaitDispatch",
          cause: "Wait handler received a different AgentAction",
        });
      }
      if (workEpisode(execution) === null) {
        return Effect.fail({
          _tag: "AgentActionRejected",
          code: "action/not-applicable",
          safeMessage:
            "Wait requires an active Work binding for durable WorkWait registration",
          correction: "ChooseAlternative",
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
  const definitionAction: Readonly<Record<string, AgentAction["_tag"]>> = {
    "core.control.wait": "Wait",
    "core.control.assign-work": "AssignWork",
    "core.control.list-workspaces": "ListWorkspaces",
    "core.control.read-workspace": "ReadWorkspace",
    "core.control.accept-result": "AcceptResult",
    "core.control.update-plan": "UpdatePlan",
    "core.control.select-current-work": "SelectCurrentWork",
    "core.control.send-message": "SendMessage",
    "core.control.claim-completion": "ClaimCompletion",
    "core.control.propose-workspace": "ProposeChildWorkspace",
    "core.control.spawn-specialist": "SpawnSpecialist",
    "core.control.declare-dependency": "DeclareDependency",
    "core.control.produce-deliverable": "ProduceDeliverable",
    "core.control.deliver": "Deliver",
    "core.control.record-verification-evidence": "RecordVerificationEvidence",
    "core.control.conclude-verification": "ConcludeVerification",
  };
  const registered = allDefinitions.filter((tool) => {
    const action = definitionAction[tool.stableId];
    return action !== undefined && handlerMap.has(action);
  });
  const names = new Set(
    registered.flatMap((tool) => [
      tool.name,
      ...(tool.legacyNames?.map((legacy) => legacy.name) ?? []),
    ]),
  );
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
            _tag: "AgentActionOperationalFailure",
            operation: "ControlRegistry.HandlerLookup",
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
