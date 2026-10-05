import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  Actor,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "../../../packages/domain/src/index.js";
import {
  Clock,
  ProjectEnvironmentPort,
  ResourceAdmission,
  SandboxPort,
  type ToolDefinition,
  ToolDefinitionStore,
  type ToolExecutionContext,
  type ToolInvocationRecord,
  ToolInvocationStore,
  ToolRuntimePort,
  TransactionPort,
  TransactionScope,
} from "../../../packages/ports/src/index.js";
import {
  type ToolExecutor,
  ToolRuntimeLive,
} from "../../../packages/tool-runtime/src/index.js";

const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const principal = parse(Principal)("worker:ah7");
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const actor = parse(Actor)("worker:ah7");
const argumentsJson = "{}";
const priorObservation = {
  text: "the input was not readable",
  truncated: false,
};

const definition: ToolDefinition = {
  name: "read",
  version: "1",
  hash: "read-v1",
  description: "Read a bounded value.",
  inputSchemaJson: JSON.stringify({ type: "object" }),
  resultSchemaJson: JSON.stringify({ type: "object" }),
  capabilityMetadata: [],
  sideEffectSemantics: "ReadOnly",
  source: "Builtin",
};

const intent = {
  callRef: "call-ah7-expected-failure",
  toolName: "read",
  toolVersion: "1",
  argumentsJson,
  invocationId,
  approvalId: null,
} as const;

const context: ToolExecutionContext = {
  executionId,
  workspaceId,
  sessionId,
  projectId,
  actor,
  authenticatedPrincipal: principal,
  authority: {
    principal,
    workspaceId,
    executionId,
    toolName: "read",
    toolVersion: "1",
    resourceSpaceIds: [],
    allowedCapabilities: [],
    controlBasisDigest: "ah7-basis",
    expiresAt: "2999-01-01T00:00:00.000Z",
    delegationDepth: 0,
  },
  controlBasisDigest: "ah7-basis",
  requestedAt: "2026-10-05T00:00:00.000Z",
};

const settledExpectedFailure: ToolInvocationRecord = {
  invocationId,
  executionId,
  workspaceId,
  toolName: "read",
  toolVersion: "1",
  sideEffectSemantics: "ReadOnly",
  argumentsJson,
  resolvedRegions: [],
  approvalId: null,
  intentAt: "2026-10-05T00:00:00.000Z",
  settledAt: "2026-10-05T00:00:01.000Z",
  settlement: { _tag: "ExpectedFailure" },
  resultRef: null,
};

describe("pending AH7 ToolResult recovery", () => {
  it("restores the settled ExpectedFailure observation when Session append has not happened", async () => {
    let executorCalls = 0;
    let settlementWrites = 0;
    const executor: ToolExecutor = {
      name: "read",
      write: false,
      requiresApproval: () => false,
      execute: () => {
        executorCalls += 1;
        return Effect.succeed({
          settlement: { _tag: "ExpectedFailure" },
          observation: priorObservation,
          resultRef: null,
        });
      },
    };

    const tx = Layer.succeed(TransactionPort, {
      transact: <A, E, R>(body: Effect.Effect<A, E, R | TransactionScope>) =>
        Effect.provideService(body, TransactionScope, {
          session: { id: "ah7-expected-failure" },
        }),
    });
    const deps = Layer.mergeAll(
      tx,
      Layer.succeed(ToolDefinitionStore, {
        definition: () => Effect.succeed(Option.some(definition)),
        all: () => Effect.succeed([definition]),
      }),
      Layer.succeed(SandboxPort, {
        open: () =>
          Effect.succeed({
            handleId: "ah7-sandbox",
            rootPath: "/repo",
            writableRegions: [],
          }),
        close: () => Effect.void,
      }),
      Layer.succeed(ResourceAdmission, {
        admit: () => Effect.succeed({ _tag: "Admitted" as const }),
      }),
      Layer.succeed(ProjectEnvironmentPort, {
        resolve: () =>
          Effect.succeed({
            regions: [],
            observedEnvironmentRevision: "env-ah7",
          }),
      }),
      Layer.succeed(Clock, {
        now: () => Effect.succeed("2026-10-05T00:00:00.000Z"),
      }),
      Layer.succeed(ToolInvocationStore, {
        recordIntent: () => Effect.void,
        settle: () => {
          settlementWrites += 1;
          return Effect.void;
        },
        consumeApproval: () => Effect.succeed(false),
        findApproval: () => Effect.succeed(Option.none()),
        findById: () => Effect.succeed(Option.some(settledExpectedFailure)),
        findUnsettled: () => Effect.succeed([]),
      } as never),
    );
    const app = Layer.mergeAll(
      deps,
      Layer.provide(ToolRuntimeLive([executor]), deps),
    );

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* runtime.invoke(intent, context);
        }),
        app,
      ) as Effect.Effect<unknown, unknown, never>,
    );

    expect(result).toEqual({
      _tag: "ExpectedFailure",
      observation: priorObservation,
    });
    expect(executorCalls).toBe(0);
    expect(settlementWrites).toBe(0);
  });
});
