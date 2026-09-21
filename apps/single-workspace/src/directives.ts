import type { DirectiveHandler, DirectiveOutcome } from "@arbor/agent-runtime";
import { parse, ToolInvocationId } from "@arbor/domain";
import {
  AgentExecutionStateStore,
  type BoundedObservation,
  type CanonicalToolObservation,
  Clock,
  type ExecutionDriverError,
  SkillRegistry,
  type ToolExecutionContext,
  type ToolIntent,
  ToolRuntimePort,
  TransactionPort,
} from "@arbor/ports";
import { Context, Effect, Layer, Option } from "effect";

/** P5 `03` §2. The slice's directive handler set: `InvokeTool` (P4), plus the
 * observation-only directives. Directives whose owning phase is absent are left
 * to the driver's `DirectiveUnsupported` path. */
export class SliceDirectiveHandlers extends Context.Service<
  SliceDirectiveHandlers,
  ReadonlyArray<DirectiveHandler>
>()("arbor/SliceDirectiveHandlers") {}

const MAX_OBSERVATION_CHARS = 2000;

const bounded = (text: string): BoundedObservation =>
  text.length > MAX_OBSERVATION_CHARS
    ? { text: text.slice(0, MAX_OBSERVATION_CHARS), truncated: true }
    : { text, truncated: false };

const driverError = (cause: unknown): ExecutionDriverError => ({
  _tag: "ExecutionDriverError",
  cause,
});

const observation = (
  source: "Runtime" | "Tool",
  text: string,
): DirectiveOutcome => ({
  _tag: "Observation",
  source,
  observation: bounded(text),
});

const toOutcome = (result: CanonicalToolObservation): DirectiveOutcome => {
  switch (result._tag) {
    case "Success":
    case "ExpectedFailure":
      return {
        _tag: "Observation",
        source: "Tool",
        observation: result.observation,
      };
    case "Denied":
      return observation("Runtime", `tool denied: ${result.reason}`);
    case "Interrupted":
      return observation("Runtime", "tool invocation interrupted");
    case "OutcomeUnknown":
      return observation("Runtime", "tool outcome unknown");
    case "RuntimeFailure":
      return observation("Runtime", `tool runtime failure: ${result.cause}`);
  }
};

export const SliceDirectiveHandlersLive: Layer.Layer<
  SliceDirectiveHandlers,
  never,
  | ToolRuntimePort
  | SkillRegistry
  | AgentExecutionStateStore
  | Clock
  | TransactionPort
> = Layer.effect(
  SliceDirectiveHandlers,
  Effect.gen(function* () {
    const tools = yield* ToolRuntimePort;
    const skills = yield* SkillRegistry;
    const states = yield* AgentExecutionStateStore;
    const clock = yield* Clock;
    const tx = yield* TransactionPort;

    const invokeTool: DirectiveHandler = {
      kind: "InvokeTool",
      handle: ({ directive, execution, context }) =>
        Effect.gen(function* () {
          if (directive._tag !== "InvokeTool") {
            return {
              _tag: "Unsupported" as const,
              reason: "not an InvokeTool",
            };
          }
          const requestedAt = yield* clock.now();
          const toolVersion = "1";
          const intent: ToolIntent = {
            callRef: directive.intent.callRef,
            toolName: directive.intent.toolName,
            toolVersion,
            argumentsJson: directive.intent.argumentsJson,
            invocationId: parse(ToolInvocationId)(
              `tin_018f2b3c-4d5e-7abc-8def-${directive.intent.callRef.padEnd(12, "0").slice(0, 12)}`,
            ),
            approvalId: null,
          };
          const toolContext: ToolExecutionContext = {
            executionId: execution.executionId,
            workspaceId: execution.workspaceId,
            sessionId: execution.sessionId,
            projectId: execution.projectId,
            actor: context.principal as never,
            authenticatedPrincipal: context.principal,
            authority: {
              principal: context.principal,
              workspaceId: execution.workspaceId,
              executionId: execution.executionId,
              toolName: directive.intent.toolName,
              toolVersion,
              resourceSpaceIds: ["filesystem"],
              allowedCapabilities: ["fs:read", "fs:write", "shell:exec"],
              controlBasisDigest: "slice",
              expiresAt: "2999-01-01T00:00:00.000Z",
              delegationDepth: 0,
            },
            controlBasisDigest: "slice",
            requestedAt,
          };
          const result = yield* tools.invoke(intent, toolContext);
          return toOutcome(result);
        }).pipe(Effect.mapError(driverError)),
    };

    const communicate: DirectiveHandler = {
      kind: "Communicate",
      handle: ({ directive }) =>
        Effect.succeed(
          directive._tag === "Communicate"
            ? observation("Runtime", directive.message.text)
            : { _tag: "Unsupported" as const, reason: "not a Communicate" },
        ),
    };

    const loadSkill: DirectiveHandler = {
      kind: "LoadSkill",
      handle: ({ directive }) =>
        Effect.gen(function* () {
          if (directive._tag !== "LoadSkill") {
            return { _tag: "Unsupported" as const, reason: "not a LoadSkill" };
          }
          const loaded = yield* skills
            .load(directive.skillId, directive.tier)
            .pipe(
              Effect.map((skill) => skill.content),
              Effect.orElseSucceed(() => "skill unavailable"),
            );
          return observation("Runtime", loaded);
        }),
    };

    const changeMode: DirectiveHandler = {
      kind: "ChangeMode",
      handle: ({ directive, execution }) =>
        Effect.gen(function* () {
          if (directive._tag !== "ChangeMode") {
            return { _tag: "Unsupported" as const, reason: "not a ChangeMode" };
          }
          const existing = yield* tx.transact(
            states.find(execution.executionId),
          );
          const now = yield* clock.now();
          if (Option.isSome(existing)) {
            yield* tx.transact(
              states.upsert({
                ...existing.value,
                currentMode: directive.mode,
                updatedAt: now,
              }),
            );
          }
          return observation("Runtime", `mode set to ${directive.mode}`);
        }).pipe(Effect.mapError(driverError)),
    };

    const requestGovernance: DirectiveHandler = {
      kind: "RequestGovernance",
      handle: ({ directive }) =>
        Effect.succeed(
          directive._tag === "RequestGovernance"
            ? observation("Runtime", JSON.stringify(directive.request))
            : {
                _tag: "Unsupported" as const,
                reason: "not a RequestGovernance",
              },
        ),
    };

    return [invokeTool, communicate, loadSkill, changeMode, requestGovernance];
  }),
);
