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
const principal = parse(Principal)("worker:a");
const actor = parse(Actor)("worker:a");
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const approvalId = "iap_018f2b3c-4d5e-7abc-8def-0123456789a1";
const argumentsJson = "{}";

const toolDefinition: ToolDefinition = {
  name: "read",
  version: "1",
  hash: "read-v1",
  description: "Read a value.",
  inputSchemaJson: JSON.stringify({ type: "object" }),
  resultSchemaJson: JSON.stringify({ type: "object" }),
  capabilityMetadata: [],
  sideEffectSemantics: "Idempotent",
  source: "Builtin",
};

const intent = {
  callRef: "call-ah7-approval",
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
    controlBasisDigest: "basis-ah7",
    expiresAt: "2999-01-01T00:00:00.000Z",
    delegationDepth: 0,
  },
  controlBasisDigest: "basis-ah7",
  requestedAt: "2026-10-05T00:00:00.000Z",
};

const consumedApproval: InvocationApproval = {
  approvalId,
  toolName: "read",
  toolVersion: "1",
  actionDigest: actionDigestOf(intent),
  targetResourceSpaceIds: [],
  controlBasisDigest: context.controlBasisDigest,
  expiresAt: "2999-01-01T00:00:00.000Z",
  consumedBy: invocationId,
};

const pendingInvocation: ToolInvocationRecord = {
  invocationId,
  executionId,
  workspaceId,
  toolName: "read",
  toolVersion: "1",
  sideEffectSemantics: "Idempotent",
  argumentsJson,
  resolvedRegions: [],
  approvalId,
  intentAt: "2026-10-05T00:00:00.000Z",
  settledAt: null,
  settlement: null,
  resultRef: null,
};

describe("P4 exact approval recovery for the same ToolInvocationId", () => {
  it("does not treat this invocation's consumed approval as another invocation's consumption", async () => {
    let executorCalls = 0;
    let intentWrites = 0;
    let approvalConsumeAttempts = 0;
    let settlementWrites = 0;
    const executor: ToolExecutor = {
      name: "read",
      write: false,
      requiresApproval: () => true,
      execute: ({ intent: executedIntent }) => {
        executorCalls += 1;
        expect(executedIntent.invocationId).toBe(invocationId);
        return Effect.succeed({
          settlement: { _tag: "Success" },
          observation: { text: "same invocation resumed", truncated: false },
          resultRef: null,
        });
      },
    };

    const tx = Layer.succeed(TransactionPort, {
      transact: <A, E, R>(body: Effect.Effect<A, E, R | TransactionScope>) =>
        Effect.provideService(body, TransactionScope, {
          session: { id: "approval-reentry" },
        }),
    });
    const deps = Layer.mergeAll(
      tx,
      Layer.succeed(ToolDefinitionStore, {
        definition: () => Effect.succeed(Option.some(toolDefinition)),
        all: () => Effect.succeed([toolDefinition]),
      }),
      Layer.succeed(SandboxPort, {
        open: () =>
          Effect.succeed({
            handleId: "sandbox-ah7",
            rootPath: "/repo",
            writableRegions: [],
          }),
        close: () => Effect.void,
      }),
      Layer.succeed(ResourceAdmission, {
        admit: () => Effect.succeed({ _tag: "Admitted" as const }),
      }),
      Layer.succeed(ProjectEnvironmentPort, {
        resolve: (_targetProjectId, addresses) =>
          Effect.succeed({
            regions: addresses.map((address) => ({
              resourceSpaceId: "filesystem",
              normalizedRegion: address,
            })),
            observedEnvironmentRevision: "env-ah7",
          }),
      }),
      Layer.succeed(Clock, {
        now: () => Effect.succeed("2026-10-05T00:00:00.000Z"),
      }),
      Layer.succeed(ToolInvocationStore, {
        recordIntent: () => {
          intentWrites += 1;
          return Effect.void;
        },
        settle: (id: ToolInvocationRecord["invocationId"]) => {
          expect(id).toBe(invocationId);
          settlementWrites += 1;
          return Effect.void;
        },
        consumeApproval: (
          _id: string,
          consumer: ToolInvocationRecord["invocationId"],
        ) => {
          approvalConsumeAttempts += 1;
          expect(consumer).toBe(invocationId);
          // The durable approval row is already consumed by this exact
          // invocation. A replay must converge without consuming it twice.
          return Effect.succeed(false);
        },
        findApproval: () => Effect.succeed(Option.some(consumedApproval)),
        findById: (id: ToolInvocationRecord["invocationId"]) => {
          expect(id).toBe(invocationId);
          return Effect.succeed(Option.some(pendingInvocation));
        },
        findUnsettled: () => Effect.succeed([pendingInvocation]),
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

    expect(result).toMatchObject({ _tag: "Success" });
    expect(executorCalls).toBe(1);
    expect(intentWrites).toBe(0);
    expect(approvalConsumeAttempts).toBe(0);
    expect(settlementWrites).toBe(1);
  });
});
