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
  ToolCatalogPort,
  type ToolCatalogPortService,
  type ToolExecutionContext,
  type ToolIntent,
  type ToolInvocationRecord,
  ToolInvocationStore,
  ToolRuntimePort,
  TransactionPort,
} from "@arbor/ports";
import { Context, Effect, Layer, Option } from "effect";

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
        _tag: "Settle",
        settlement: {
          _tag: "OutcomeUnknown",
          reconciliation: {
            _tag: "ReconciliationRequired",
            invocationRefs: result.reconciliationRefs,
          },
        },
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

const toolInvocationIdFor = (executionId: string, callRef: string) =>
  parse(ToolInvocationId)(
    `tin_018f2b3c-4d5e-7abc-8def-${createHash("sha256")
      .update(JSON.stringify({ executionId, callRef }))
      .digest("hex")
      .slice(0, 12)}`,
  );

/** Pre-AH7 identities were derived from callRef alone. Read the exact old
 * record before choosing it for an in-flight replay; never assign that ID to
 * a different Execution that happens to reuse the provider callRef. */
const legacyToolInvocationIdFor = (callRef: string) =>
  parse(ToolInvocationId)(
    `tin_018f2b3c-4d5e-7abc-8def-${createHash("sha256")
      .update(callRef)
      .digest("hex")
      .slice(0, 12)}`,
  );

export const makeExecutableToolHandler = (
  tools: import("@arbor/ports").ToolRuntimePortService,
  clock: import("@arbor/ports").ClockService,
  catalog: ToolCatalogPortService,
  legacyLookup?: (
    id: ToolInvocationId,
  ) => Effect.Effect<Option.Option<ToolInvocationRecord>, unknown>,
): ExecutableInvocationHandler => ({
  handle: ({ invocation, execution, context, controlBasis }) =>
    Effect.gen(function* () {
      const requestedAt = yield* clock.now();
      const matchingRefs = (yield* catalog.visibleRefs().pipe(
        Effect.mapError((cause) => ({
          _tag: "AgentActionOperationalFailure" as const,
          operation: "ToolCatalog.visibleRefs",
          cause,
        })),
      )).filter((ref) => ref.name === invocation.toolName);
      if (matchingRefs.length !== 1) {
        return yield* Effect.fail({
          _tag: "AgentActionRejected" as const,
          code: "action/tool-unavailable" as const,
          safeMessage:
            matchingRefs.length === 0
              ? `tool is not visible: ${invocation.toolName}`
              : `tool identity is ambiguous: ${invocation.toolName}`,
          correction: "ChooseAlternative" as const,
        });
      }
      const toolVersion = matchingRefs[0]?.version as string;
      let invocationId = toolInvocationIdFor(
        execution.executionId,
        invocation.callRef,
      );
      if (legacyLookup !== undefined) {
        const oldId = legacyToolInvocationIdFor(invocation.callRef);
        const old = yield* legacyLookup(oldId).pipe(
          Effect.mapError((cause) => ({
            _tag: "AgentActionOperationalFailure" as const,
            operation: "LegacyToolInvocationLookup",
            cause,
          })),
        );
        if (
          Option.isSome(old) &&
          old.value.executionId === execution.executionId &&
          old.value.workspaceId === execution.workspaceId &&
          old.value.toolName === invocation.toolName &&
          old.value.toolVersion === toolVersion &&
          old.value.argumentsJson === invocation.argumentsJson
        ) {
          invocationId = oldId;
        }
      }
      const intent: ToolIntent = {
        callRef: invocation.callRef,
        toolName: invocation.toolName,
        toolVersion,
        argumentsJson: invocation.argumentsJson,
        invocationId,
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
      const invoked = yield* Effect.match(tools.invoke(intent, toolContext), {
        onFailure: (cause) => ({ ok: false as const, cause }),
        onSuccess: (value) => ({ ok: true as const, value }),
      });
      if (!invoked.ok) {
        if (invoked.cause.effectDisposition === "OutcomeUncertain") {
          return {
            _tag: "Settle" as const,
            settlement: {
              _tag: "OutcomeUnknown" as const,
              reconciliation: {
                _tag: "ReconciliationRequired" as const,
                invocationRefs: [invoked.cause.invocationRef],
              },
            },
          };
        }
        return yield* Effect.fail({
          _tag: "AgentActionOperationalFailure" as const,
          operation: `ToolRuntime.${invoked.cause.stage}`,
          cause: invoked.cause,
        });
      }
      const result = invoked.value;
      const outcome = toExecutableOutcome(result);
      return outcome._tag === "Observation"
        ? { ...outcome, invocationId: intent.invocationId }
        : outcome;
    }),
});

export const ExecutableToolHandlerLive: Layer.Layer<
  ExecutableToolHandler,
  never,
  | ToolRuntimePort
  | Clock
  | ToolCatalogPort
  | ToolInvocationStore
  | TransactionPort
> = Layer.effect(
  ExecutableToolHandler,
  Effect.gen(function* () {
    const tools = yield* ToolRuntimePort;
    const clock = yield* Clock;
    const catalog = yield* ToolCatalogPort;
    const invocations = yield* ToolInvocationStore;
    const tx = yield* TransactionPort;
    return ExecutableToolHandler.of(
      makeExecutableToolHandler(tools, clock, catalog, (id) =>
        tx.transact(invocations.findById(id)),
      ),
    );
  }),
);
