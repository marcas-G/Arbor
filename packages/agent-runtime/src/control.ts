import type {
  CommandSubmissionContext,
  Execution,
  ExecutionSettlement,
  MessageKind,
  WaitSpec,
} from "@arbor/domain";
import {
  DecisionId,
  DependencyId,
  MessageId,
  parse,
  Revision,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import type { ToolInvocation } from "@arbor/model-context";
import {
  type BoundedObservation,
  ControlToolCatalogPort,
  type ControlToolCatalogPortService,
  type ModelFacingControlToolDefinition,
} from "@arbor/ports";
import { Context, Effect, Layer } from "effect";

export type AgentAction =
  | {
      readonly _tag: "Wait";
      readonly reason: string;
      readonly waitSpec: WaitSpec;
    }
  | {
      readonly _tag: "SendMessage";
      readonly kind: Exclude<MessageKind, "Deliver">;
      readonly body: string;
      readonly recipientWorkspaceId?: WorkspaceId;
      readonly queryMessageId?: MessageId;
    };

export interface ControlToolInvocation {
  readonly invocation: ToolInvocation;
  readonly action: AgentAction;
}

export type ControlToolDecodeError =
  | { readonly _tag: "UnknownControlTool"; readonly toolName: string }
  | {
      readonly _tag: "InvalidControlArguments";
      readonly toolName: string;
      readonly reason: string;
    };

export type AgentActionOutcome =
  | {
      readonly _tag: "Observation";
      readonly source: "Runtime";
      readonly observation: BoundedObservation;
    }
  | { readonly _tag: "Settle"; readonly settlement: ExecutionSettlement };

export interface AgentActionHandlerInput {
  readonly action: AgentAction;
  readonly invocation: ToolInvocation;
  readonly execution: Execution;
  readonly context: CommandSubmissionContext;
}

export interface AgentActionHandler {
  readonly action: AgentAction["_tag"];
  readonly handle: (
    input: AgentActionHandlerInput,
  ) => Effect.Effect<AgentActionOutcome, AgentActionError>;
}

export interface AgentActionError {
  readonly _tag: "AgentActionError";
  readonly cause: unknown;
}

export type ExecutableInvocationOutcome =
  | {
      readonly _tag: "Observation";
      readonly source: "Runtime" | "Tool";
      readonly observation: BoundedObservation;
    }
  | { readonly _tag: "Settle"; readonly settlement: ExecutionSettlement };

export interface ExecutableInvocationInput {
  readonly invocation: ToolInvocation;
  readonly execution: Execution;
  readonly context: CommandSubmissionContext;
}

export interface ExecutableInvocationHandler {
  readonly handle: (
    input: ExecutableInvocationInput,
  ) => Effect.Effect<ExecutableInvocationOutcome, AgentActionError>;
}

export interface ControlToolRegistryService
  extends ControlToolCatalogPortService {
  readonly definitions: () => ReadonlyArray<ModelFacingControlToolDefinition>;
  readonly classify: (toolName: string) => "Control" | "NotControl";
  readonly decode: (
    invocation: ToolInvocation,
  ) => Effect.Effect<ControlToolInvocation, ControlToolDecodeError>;
  readonly handle: (
    input: AgentActionHandlerInput,
  ) => Effect.Effect<AgentActionOutcome, AgentActionError>;
}

export class ControlToolRegistry extends Context.Service<
  ControlToolRegistry,
  ControlToolRegistryService
>()("arbor/ControlToolRegistry") {}

export type ToolRouteClassification =
  | { readonly _tag: "Executable" }
  | { readonly _tag: "Control" }
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
  }>,
  registry: Pick<ControlToolRegistryService, "classify">,
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
  return { _tag: route.route };
};

const fnv = (input: string): string => {
  let value = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, "0");
};

const WAIT_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    reason: { type: "string", minLength: 1 },
    waitSpec: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "conditions"],
      properties: {
        mode: { const: "Any" },
        conditions: {
          type: "array",
          minItems: 1,
          items: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["_tag", "dependencyId", "observedRevision"],
                properties: {
                  _tag: { const: "DependencyChanged" },
                  dependencyId: { type: "string", pattern: "^dep_" },
                  observedRevision: { type: "integer", minimum: 0 },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["_tag", "decisionId", "observedRevision"],
                properties: {
                  _tag: { const: "DecisionChanged" },
                  decisionId: { type: "string", pattern: "^dec_" },
                  observedRevision: { type: "integer", minimum: 0 },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["_tag", "workId", "targetWorkRevision"],
                properties: {
                  _tag: { const: "VerificationChanged" },
                  workId: { type: "string", pattern: "^wrk_" },
                  targetWorkRevision: { type: "integer", minimum: 0 },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["_tag", "workspaceId", "observedSequence"],
                properties: {
                  _tag: { const: "InboxAdvanced" },
                  workspaceId: { type: "string", pattern: "^ws_" },
                  observedSequence: { type: "integer", minimum: 0 },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["_tag", "environmentRef", "observedRevision"],
                properties: {
                  _tag: { const: "EnvironmentChanged" },
                  environmentRef: { type: "string", minLength: 1 },
                  observedRevision: { type: "string", minLength: 1 },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["_tag", "instant"],
                properties: {
                  _tag: { const: "TimeReached" },
                  instant: { type: "string", format: "date-time" },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["_tag"],
                properties: { _tag: { const: "Manual" } },
              },
            ],
          },
        },
      },
    },
  },
  required: ["reason", "waitSpec"],
});

const SEND_MESSAGE_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    kind: {
      enum: ["Query", "Reply", "Report", "DecisionRequest"],
    },
    body: { type: "string", minLength: 1 },
    recipientWorkspaceId: { type: "string", minLength: 1 },
    queryMessageId: { type: "string", minLength: 1 },
  },
  required: ["kind", "body"],
});

const definitions = (): ReadonlyArray<ModelFacingControlToolDefinition> => {
  const raw = [
    {
      name: "arbor_wait",
      description:
        "Register a durable wait condition and settle this execution.",
      schemaJson: WAIT_SCHEMA,
      version: "1",
      requiredCapability: "agent:wait",
    },
    {
      name: "arbor_send_message",
      description:
        "Send a durable coordination message through the owning workspace.",
      schemaJson: SEND_MESSAGE_SCHEMA,
      version: "1",
      requiredCapability: "agent:communicate",
    },
  ] as const;
  return raw.map((tool) => ({
    ...tool,
    hash: fnv(JSON.stringify(tool)),
  }));
};

const invalid = (
  toolName: string,
  reason: string,
): Effect.Effect<never, ControlToolDecodeError> =>
  Effect.fail({
    _tag: "InvalidControlArguments",
    toolName,
    reason,
  });

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const parseId = <A>(
  name: string,
  parser: (value: string) => A,
  value: unknown,
): A | null => {
  if (!nonEmptyString(value)) return null;
  try {
    return parser(value);
  } catch {
    return null;
  }
};

const decodeWaitSpec = (
  invocation: ToolInvocation,
  value: unknown,
): Effect.Effect<WaitSpec, ControlToolDecodeError> => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !hasOnly(value as Record<string, unknown>, ["mode", "conditions"])
  ) {
    return invalid(invocation.toolName, "waitSpec must be a closed object");
  }
  const spec = value as Record<string, unknown>;
  if (
    spec.mode !== "Any" ||
    !Array.isArray(spec.conditions) ||
    spec.conditions.length === 0
  ) {
    return invalid(
      invocation.toolName,
      "waitSpec requires mode Any and at least one condition",
    );
  }
  const conditions: WaitSpec["conditions"][number][] = [];
  for (const candidate of spec.conditions) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return invalid(invocation.toolName, "wake condition must be an object");
    }
    const condition = candidate as Record<string, unknown>;
    switch (condition._tag) {
      case "DependencyChanged": {
        const dependencyId = parseId(
          invocation.toolName,
          parse(DependencyId),
          condition.dependencyId,
        );
        const observedRevision = parseId(
          invocation.toolName,
          parse(Revision),
          condition.observedRevision,
        );
        if (
          !hasOnly(condition, ["_tag", "dependencyId", "observedRevision"]) ||
          dependencyId === null ||
          observedRevision === null
        ) {
          return invalid(
            invocation.toolName,
            "invalid DependencyChanged condition",
          );
        }
        conditions.push({
          _tag: "DependencyChanged",
          dependencyId,
          observedRevision,
        });
        break;
      }
      case "DecisionChanged": {
        const decisionId = parseId(
          invocation.toolName,
          parse(DecisionId),
          condition.decisionId,
        );
        const observedRevision = parseId(
          invocation.toolName,
          parse(Revision),
          condition.observedRevision,
        );
        if (
          !hasOnly(condition, ["_tag", "decisionId", "observedRevision"]) ||
          decisionId === null ||
          observedRevision === null
        ) {
          return invalid(
            invocation.toolName,
            "invalid DecisionChanged condition",
          );
        }
        conditions.push({
          _tag: "DecisionChanged",
          decisionId,
          observedRevision,
        });
        break;
      }
      case "VerificationChanged": {
        const workId = parseId(
          invocation.toolName,
          parse(WorkId),
          condition.workId,
        );
        const targetWorkRevision = parseId(
          invocation.toolName,
          parse(Revision),
          condition.targetWorkRevision,
        );
        if (
          !hasOnly(condition, ["_tag", "workId", "targetWorkRevision"]) ||
          workId === null ||
          targetWorkRevision === null
        ) {
          return invalid(
            invocation.toolName,
            "invalid VerificationChanged condition",
          );
        }
        conditions.push({
          _tag: "VerificationChanged",
          workId,
          targetWorkRevision,
        });
        break;
      }
      case "InboxAdvanced": {
        const workspaceId = parseId(
          invocation.toolName,
          parse(WorkspaceId),
          condition.workspaceId,
        );
        if (
          !hasOnly(condition, ["_tag", "workspaceId", "observedSequence"]) ||
          workspaceId === null ||
          !Number.isInteger(condition.observedSequence) ||
          (condition.observedSequence as number) < 0
        ) {
          return invalid(
            invocation.toolName,
            "invalid InboxAdvanced condition",
          );
        }
        conditions.push({
          _tag: "InboxAdvanced",
          workspaceId,
          observedSequence: condition.observedSequence as number,
        });
        break;
      }
      case "EnvironmentChanged":
        if (
          !hasOnly(condition, ["_tag", "environmentRef", "observedRevision"]) ||
          !nonEmptyString(condition.environmentRef) ||
          !nonEmptyString(condition.observedRevision)
        ) {
          return invalid(
            invocation.toolName,
            "invalid EnvironmentChanged condition",
          );
        }
        conditions.push({
          _tag: "EnvironmentChanged",
          environmentRef: condition.environmentRef,
          observedRevision: condition.observedRevision,
        });
        break;
      case "TimeReached":
        if (
          !hasOnly(condition, ["_tag", "instant"]) ||
          !nonEmptyString(condition.instant) ||
          Number.isNaN(Date.parse(condition.instant))
        ) {
          return invalid(invocation.toolName, "invalid TimeReached condition");
        }
        conditions.push({ _tag: "TimeReached", instant: condition.instant });
        break;
      case "Manual":
        if (!hasOnly(condition, ["_tag"])) {
          return invalid(invocation.toolName, "invalid Manual condition");
        }
        conditions.push({ _tag: "Manual" });
        break;
      default:
        return invalid(invocation.toolName, "unknown wake condition");
    }
  }
  return Effect.succeed({ mode: "Any", conditions });
};

const parseObject = (
  invocation: ToolInvocation,
): Effect.Effect<Record<string, unknown>, ControlToolDecodeError> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(invocation.argumentsJson);
  } catch {
    return invalid(invocation.toolName, "arguments are not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return invalid(invocation.toolName, "arguments must be a JSON object");
  }
  return Effect.succeed(parsed as Record<string, unknown>);
};

const hasOnly = (
  object: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): boolean => Object.keys(object).every((key) => keys.includes(key));

const decodeInvocation = (
  invocation: ToolInvocation,
): Effect.Effect<ControlToolInvocation, ControlToolDecodeError> =>
  Effect.gen(function* () {
    if (
      invocation.toolName !== "arbor_wait" &&
      invocation.toolName !== "arbor_send_message"
    ) {
      return yield* Effect.fail<ControlToolDecodeError>({
        _tag: "UnknownControlTool",
        toolName: invocation.toolName,
      });
    }
    const object = yield* parseObject(invocation);
    if (invocation.toolName === "arbor_wait") {
      if (
        !hasOnly(object, ["reason", "waitSpec"]) ||
        typeof object.reason !== "string" ||
        object.reason.length === 0 ||
        typeof object.waitSpec !== "object" ||
        object.waitSpec === null ||
        Array.isArray(object.waitSpec)
      ) {
        return yield* invalid(invocation.toolName, "invalid Wait arguments");
      }
      const waitSpec = yield* decodeWaitSpec(invocation, object.waitSpec);
      return {
        invocation,
        action: {
          _tag: "Wait",
          reason: object.reason,
          waitSpec,
        },
      };
    }
    if (invocation.toolName === "arbor_send_message") {
      const kind = object.kind;
      const body = object.body;
      if (
        !hasOnly(object, [
          "kind",
          "body",
          "recipientWorkspaceId",
          "queryMessageId",
        ]) ||
        (kind !== "Query" &&
          kind !== "Reply" &&
          kind !== "Report" &&
          kind !== "DecisionRequest") ||
        typeof body !== "string" ||
        body.length === 0
      ) {
        return yield* invalid(
          invocation.toolName,
          "invalid SendMessage arguments",
        );
      }
      if (
        kind === "Query" &&
        (typeof object.recipientWorkspaceId !== "string" ||
          object.recipientWorkspaceId.length === 0)
      ) {
        return yield* invalid(
          invocation.toolName,
          "Query requires recipientWorkspaceId",
        );
      }
      const recipientWorkspaceId =
        object.recipientWorkspaceId === undefined
          ? undefined
          : parseId(
              invocation.toolName,
              parse(WorkspaceId),
              object.recipientWorkspaceId,
            );
      const queryMessageId =
        object.queryMessageId === undefined
          ? undefined
          : parseId(
              invocation.toolName,
              parse(MessageId),
              object.queryMessageId,
            );
      if (
        (object.recipientWorkspaceId !== undefined &&
          recipientWorkspaceId === null) ||
        (object.queryMessageId !== undefined && queryMessageId === null)
      ) {
        return yield* invalid(
          invocation.toolName,
          "target identity is malformed",
        );
      }
      return {
        invocation,
        action: {
          _tag: "SendMessage",
          kind,
          body,
          ...(recipientWorkspaceId !== undefined &&
          recipientWorkspaceId !== null
            ? { recipientWorkspaceId }
            : {}),
          ...(queryMessageId !== undefined && queryMessageId !== null
            ? { queryMessageId }
            : {}),
        },
      };
    }
    return yield* invalid(invocation.toolName, "unreachable control tool");
  });

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
  const allDefinitions = definitions();
  const definitionAction: Readonly<
    Record<(typeof allDefinitions)[number]["name"], AgentAction["_tag"]>
  > = {
    arbor_wait: "Wait",
    arbor_send_message: "SendMessage",
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
        ? decodeInvocation(invocation)
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
