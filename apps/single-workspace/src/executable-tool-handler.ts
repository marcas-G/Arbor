import { createHash } from "node:crypto";
import type {
  ExecutableInvocationHandler,
  ExecutableInvocationOutcome,
} from "@arbor/agent-runtime";
import { parse, ToolInvocationId } from "@arbor/domain";
import {
  type BoundedObservation,
  type CanonicalToolObservation,
  Clock,
  sha256Hex,
  type ToolExecutionContext,
  type ToolIntent,
  ToolRuntimePort,
} from "@arbor/ports";
import { Context, Effect, Layer } from "effect";

export class ExecutableToolHandler extends Context.Service<
  ExecutableToolHandler,
  ExecutableInvocationHandler
>()("arbor/ExecutableToolHandler") {}

const bounded = (text: string, limit = 2000): BoundedObservation => ({
  text: text.length > limit ? text.slice(0, limit) : text,
  truncated: text.length > limit,
});

export const toExecutableOutcome = (
  result: CanonicalToolObservation,
): ExecutableInvocationOutcome => {
  switch (result._tag) {
    case "Success":
      return {
        _tag: "Observation",
        source: "Tool",
        observation: result.observation,
        status: "Succeeded",
        ...(result.resultRef === null ? {} : { resultRef: result.resultRef }),
        artifactRefs: result.resultRef === null ? [] : [result.resultRef],
      };
    case "ExpectedFailure":
      return {
        _tag: "Observation",
        source: "Tool",
        observation: result.observation,
        status: "Failed",
      };
    case "Denied":
      return {
        _tag: "Observation",
        source: "Runtime",
        observation: bounded(`tool denied: ${result.reason}`),
        status: "Denied",
      };
    case "Interrupted":
      return {
        _tag: "Observation",
        source: "Runtime",
        observation: bounded("tool invocation interrupted"),
        status: "Interrupted",
      };
    case "OutcomeUnknown":
      return {
        _tag: "Observation",
        source: "Runtime",
        observation: bounded("tool outcome unknown"),
        status: "OutcomeUnknown",
      };
    case "RuntimeFailure":
      return {
        _tag: "Observation",
        source: "Runtime",
        observation: bounded(`tool runtime failure: ${result.cause}`),
        status: "Failed",
      };
  }
};

const toolInvocationIdFor = (callRef: string) =>
  parse(ToolInvocationId)(
    `tin_018f2b3c-4d5e-7abc-8def-${createHash("sha256")
      .update(callRef)
      .digest("hex")
      .slice(0, 12)}`,
  );

export const makeExecutableToolHandler = (
  tools: import("@arbor/ports").ToolRuntimePortService,
  clock: import("@arbor/ports").ClockService,
): ExecutableInvocationHandler => ({
  handle: ({ invocation, execution, context, controlBasis }) =>
    Effect.gen(function* () {
      const requestedAt = yield* clock.now();
      const toolVersion = "1";
      const intent: ToolIntent = {
        callRef: invocation.callRef,
        toolName: invocation.toolName,
        toolVersion,
        argumentsJson: invocation.argumentsJson,
        invocationId: toolInvocationIdFor(invocation.callRef),
        approvalId: null,
      };
      const controlBasisDigest = sha256Hex(JSON.stringify(controlBasis));
      const toolContext: ToolExecutionContext = {
        executionId: execution.executionId,
        workspaceId: execution.workspaceId,
        sessionId: execution.sessionId,
        projectId: execution.projectId,
        actor: context.principal as never,
        authenticatedPrincipal: context.principal,
        controlBasisDigest,
        delegationDepth:
          execution.binding._tag === "ExecutionBoundAgentBinding" ? 1 : 0,
        requestedAt,
      };
      const result = yield* tools.invoke(intent, toolContext);
      return toExecutableOutcome(result);
    }).pipe(
      Effect.mapError((cause) => ({
        _tag: "AgentActionError" as const,
        cause,
      })),
    ),
});

export const ExecutableToolHandlerLive: Layer.Layer<
  ExecutableToolHandler,
  never,
  ToolRuntimePort | Clock
> = Layer.effect(
  ExecutableToolHandler,
  Effect.gen(function* () {
    const tools = yield* ToolRuntimePort;
    const clock = yield* Clock;
    return ExecutableToolHandler.of(makeExecutableToolHandler(tools, clock));
  }),
);
