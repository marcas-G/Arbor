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
  type InvocationApproval,
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
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  actionDigestOf,
  type ToolExecutor,
  ToolRuntimeLive,
} from "../src/index.js";

const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const principal = parse(Principal)("worker:ah7-approval-reentry");
const actor = parse(Actor)("worker:ah7-approval-reentry");
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const approvalId = "iap_018f2b3c-4d5e-7abc-8def-0123456789a1";
const argumentsJson = "{}";

const definition: ToolDefinition = {
  name: "read",
  version: "1",
  hash: "read-v1",
  description: "Read a bounded value.",
  inputSchemaJson: JSON.stringify({ type: "object" }),
  resultSchemaJson: JSON.stringify({ type: "object" }),
  capabilityMetadata: [],
  sideEffectSemantics: "Idempotent",
  source: "Builtin",
};

const intent = {
  callRef: "call-ah7-approval-reentry",
  toolName: "read",
  toolVersion: "1",
  argumentsJson,
  invocationId,
  approvalId,
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
    controlBasisDigest: "ah7-approval-basis",
    expiresAt: "2999-01-01T00:00:00.000Z",
    delegationDepth: 0,
  },
  controlBasisDigest: "ah7-approval-basis",
  requestedAt: "2026-10-06T00:00:00.000Z",
};

describe("AH7 exact approval reentry before the tool effect", () => {
  it("reuses the consumed approval and recorded intent after a pre-effect interruption", async () => {
    let approval: InvocationApproval = {
      approvalId,
      toolName: intent.toolName,
      toolVersion: intent.toolVersion,
      actionDigest: actionDigestOf(intent),
      targetResourceSpaceIds: [],
      controlBasisDigest: context.controlBasisDigest,
      expiresAt: "2999-01-01T00:00:00.000Z",
      consumedBy: null,
    };
    let invocation: ToolInvocationRecord | undefined;
    let sandboxOpenCalls = 0;
    let executorCalls = 0;
    let intentWrites = 0;
    let approvalConsumeWrites = 0;
    let settlementWrites = 0;

    const executor: ToolExecutor = {
      name: "read",
      write: false,
      requiresApproval: () => true,
      execute: () => {
        executorCalls += 1;
        return Effect.succeed({
          settlement: { _tag: "Success" },
          observation: { text: "resumed exact invocation", truncated: false },
          resultRef: null,
        });
      },
    };
    const dependencies = Layer.mergeAll(
      Layer.succeed(TransactionPort, {
        transact: <A, E, R>(body: Effect.Effect<A, E, R | TransactionScope>) =>
          Effect.provideService(body, TransactionScope, {
            session: { id: "ah7-approval-reentry" },
          }),
      }),
      Layer.succeed(ToolDefinitionStore, {
        definition: () => Effect.succeed(Option.some(definition)),
        all: () => Effect.succeed([definition]),
      }),
      Layer.succeed(SandboxPort, {
        open: () => {
          sandboxOpenCalls += 1;
          return sandboxOpenCalls === 1
            ? Effect.fail({
                _tag: "SandboxError" as const,
                cause: "injected interruption before executor attempt",
              })
            : Effect.succeed({
                handleId: "ah7-sandbox",
                rootPath: "/repo",
                writableRegions: [],
              });
        },
        close: () => Effect.void,
      }),
      Layer.succeed(ResourceAdmission, {
        admit: () => Effect.succeed({ _tag: "Admitted" as const }),
      }),
      Layer.succeed(ProjectEnvironmentPort, {
        resolve: () =>
          Effect.succeed({
            regions: [],
            observedEnvironmentRevision: "ah7-env",
          }),
      }),
      Layer.succeed(Clock, {
        now: () => Effect.succeed("2026-10-06T00:00:00.000Z"),
      }),
      Layer.succeed(ToolInvocationStore, {
        recordIntent: (record: ToolInvocationRecord) => {
          intentWrites += 1;
          invocation = {
            ...record,
            settledAt: null,
            settlement: null,
            resultRef: null,
          };
          return Effect.void;
        },
        settle: (
          id: ToolInvocationRecord["invocationId"],
          settledAt: string,
          settlement: NonNullable<ToolInvocationRecord["settlement"]>,
          resultRef: string | null,
        ) => {
          expect(id).toBe(invocationId);
          settlementWrites += 1;
          if (invocation === undefined) {
            return Effect.die(new Error("settlement without recorded intent"));
          }
          invocation = {
            ...invocation,
            settledAt,
            settlement,
            resultRef,
          };
          return Effect.succeed(true);
        },
        consumeApproval: (id: string, consumer: ToolInvocationId) => {
          expect(id).toBe(approvalId);
          if (approval.consumedBy !== null) return Effect.succeed(false);
          approvalConsumeWrites += 1;
          approval = { ...approval, consumedBy: consumer };
          return Effect.succeed(true);
        },
        findApproval: () => Effect.succeed(Option.some(approval)),
        findById: (id: ToolInvocationId) => {
          expect(id).toBe(invocationId);
          return Effect.succeed(
            invocation === undefined ? Option.none() : Option.some(invocation),
          );
        },
        findUnsettled: () =>
          Effect.succeed(invocation?.settlement === null ? [invocation] : []),
      } as never),
    );
    const app = Layer.mergeAll(
      dependencies,
      Layer.provide(ToolRuntimeLive([executor]), dependencies),
    );
    const invoke = () =>
      Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const runtime = yield* ToolRuntimePort;
            return yield* runtime.invoke(intent, context);
          }),
          app,
        ) as Effect.Effect<unknown, unknown, never>,
      );

    await expect(invoke()).rejects.toMatchObject({
      _tag: "ToolRuntimeOperationalFailure",
      stage: "SandboxOpen",
    });
    expect(approval.consumedBy).toBe(invocationId);
    expect(invocation?.settlement).toBeNull();
    expect(executorCalls).toBe(0);

    const resumed = await invoke();

    expect(resumed).toMatchObject({
      _tag: "Success",
      observation: { text: "resumed exact invocation", truncated: false },
    });
    expect(approval.consumedBy).toBe(invocationId);
    expect(intentWrites).toBe(1);
    expect(approvalConsumeWrites).toBe(1);
    expect(executorCalls).toBe(1);
    expect(settlementWrites).toBe(1);
  });
});
