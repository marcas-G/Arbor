import {
  Actor,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  ProjectEnvironmentPort,
  ResourceAdmission,
  SandboxPort,
  ToolDefinitionStore,
  type ToolExecutionContext,
  type ToolExecutor,
  ToolInvocationStore,
  ToolRuntimePort,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ToolRuntimeLive } from "../src/index.js";

const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);

const executorCalls: number[] = [];
const executor: ToolExecutor = {
  name: "read",
  write: false,
  requiresApproval: () => false,
  execute: () => {
    executorCalls.push(1);
    return Effect.die("invalid context reached executor");
  },
};

const runtimeLayer = (definitionCalls: number[]) => {
  const dependencies = Layer.mergeAll(
    Layer.succeed(ToolDefinitionStore, {
      definition: () => {
        definitionCalls.push(1);
        return Effect.succeed({ _tag: "None" as const });
      },
      all: () => Effect.succeed([]),
    }),
    Layer.succeed(SandboxPort, {} as never),
    Layer.succeed(ResourceAdmission, {} as never),
    Layer.succeed(ToolInvocationStore, {} as never),
    Layer.succeed(ProjectEnvironmentPort, {} as never),
    Layer.succeed(TransactionPort, {} as never),
    Layer.succeed(Clock, {} as never),
  );
  return Layer.provide(ToolRuntimeLive([executor]), dependencies);
};

const incompleteContexts: ReadonlyArray<ToolExecutionContext> = [
  {
    executionId,
    workspaceId,
    sessionId: parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1"),
    projectId: parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1"),
    actor: parse(Actor)("worker:test"),
    authenticatedPrincipal: parse(Principal)("worker:test"),
    controlBasisDigest: "digest",
    requestedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as ToolExecutionContext,
  {
    executionId,
    workspaceId,
    sessionId: parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1"),
    projectId: parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1"),
    actor: parse(Actor)("worker:test"),
    authenticatedPrincipal: parse(Principal)("worker:test"),
    controlBasisDigest: "digest",
    requestedAt: "2026-01-01T00:00:00.000Z",
    executionFence: { executionId },
  } as unknown as ToolExecutionContext,
];

describe("P4 requires a complete ExecutionOrigin fence", () => {
  it.each(incompleteContexts)(
    "fails before definition resolution or any tool effect",
    async (context) => {
      const definitionCalls: number[] = [];
      const result = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const runtime = yield* ToolRuntimePort;
            return yield* Effect.match(
              runtime.invoke(
                {
                  callRef: "call-1",
                  toolName: "read",
                  toolVersion: "1",
                  argumentsJson: "{}",
                  invocationId,
                  approvalId: null,
                },
                context,
              ),
              {
                onFailure: (error) => ({ _tag: "Rejected" as const, error }),
                onSuccess: (value) => ({ _tag: "Observed" as const, value }),
              },
            );
          }),
          runtimeLayer(definitionCalls),
        ) as Effect.Effect<unknown, never, never>,
      );

      expect(result).toMatchObject({
        _tag: "Rejected",
        error: {
          _tag: "ToolRuntimeOperationalFailure",
          stage: "IntentJournal",
          effectDisposition: "NotStarted",
        },
      });
      expect(definitionCalls).toHaveLength(0);
      expect(executorCalls).toHaveLength(0);
    },
  );
});
