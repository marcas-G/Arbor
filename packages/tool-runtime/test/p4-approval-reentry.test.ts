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
  type ExecutableApprovalBinding,
  type ExecutableApprovalRecord,
  ExecutableApprovalStore,
  type ExecutableApprovalStoreService,
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
  executableApprovalTerminalDenial,
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
    sourceRevision: "fixture-authority-revision",
    resourceSpaceIds: [],
    allowedCapabilities: [],
    controlBasisDigest: "basis-ah7",
    expiresAt: "2999-01-01T00:00:00.000Z",
    delegationDepth: 0,
  },
  controlBasisDigest: "basis-ah7",
  executionFence: {
    executionId,
    workerId: "worker:p4-approval-reentry",
    workerIncarnationId: "incarnation:p4-approval-reentry",
    fencingGeneration: 0 as never,
  },
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
  effectAdmissionState: "NotAdmitted",
  intentAt: "2026-10-05T00:00:00.000Z",
  settledAt: null,
  settlement: null,
  resultRef: null,
};

describe("P4 exact approval recovery for the same ToolInvocationId", () => {
  it("preserves a committed Reject after its historical TTL passes", () => {
    expect(
      executableApprovalTerminalDenial(
        { state: "Rejected", expiresAt: "2026-10-05T00:00:01.000Z" },
        "2026-10-12T00:00:00.000Z",
      ),
    ).toBe("ApprovalRejected");
    expect(
      executableApprovalTerminalDenial(
        { state: "Approved", expiresAt: "2026-10-05T00:00:01.000Z" },
        "2026-10-12T00:00:00.000Z",
      ),
    ).toBe("ApprovalExpired");
  });

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
          return Effect.succeed("Recorded" as const);
        },
        settle: (id: ToolInvocationRecord["invocationId"]) => {
          expect(id).toBe(invocationId);
          settlementWrites += 1;
          return Effect.succeed(true);
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
        recordNoEffectDenial: () => Effect.die(new Error("unexpected denial")),
        recordNoEffectInterruption: () => Effect.succeed(false),
        admitEffect: () => Effect.succeed({ _tag: "Admitted" as const }),
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

  it("replays the Runtime approvalId after claim commit and before effect admission", async () => {
    const runtimeApprovalId = "eap_p4_same_invocation";
    const p38Intent = { ...intent, approvalId: runtimeApprovalId };
    const binding: ExecutableApprovalBinding = {
      projectId,
      workspaceId,
      executionId,
      logicalStepNo: 4,
      repairAttempt: 0,
      actionIndex: 0,
      logicalActionId: "lac_p4_same_invocation",
      subject: principal,
      callRef: intent.callRef,
      toolInvocationId: invocationId,
      toolName: toolDefinition.name,
      toolVersion: toolDefinition.version,
      sideEffectSemantics: toolDefinition.sideEffectSemantics,
      argumentsJson: intent.argumentsJson,
      actionDigest: actionDigestOf(intent),
      targetResourceSpaceIds: [],
      controlBasisDigest: context.controlBasisDigest,
    };
    let approval: ExecutableApprovalRecord = {
      ...binding,
      approvalId: runtimeApprovalId,
      routeKind: "Executable",
      revision: 1,
      requestedAt: "2026-10-05T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z",
      state: "Approved",
      decidedAt: "2026-10-05T00:00:01.000Z",
      decidedBy: principal,
      decisionReason: null,
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
      consumedAt: null,
      consumedBy: null,
    };
    const executableContext: ToolExecutionContext = {
      ...context,
      authority: {
        ...(context.authority as NonNullable<
          ToolExecutionContext["authority"]
        >),
        sourceRevision: "authority-revision-p38",
      },
      executionFence: {
        executionId,
        workerId: "worker-p38",
        workerIncarnationId: "incarnation-p38",
        fencingGeneration: 7 as never,
      },
      executableApproval: {
        approvalId: runtimeApprovalId,
        expectedRevision: 1,
        state: "Approved",
        binding,
      },
    };
    let recorded: ToolInvocationRecord | undefined;
    let intentApprovalId: string | null = null;
    let consumeCalls = 0;
    let executorCalls = 0;
    let settlementCalls = 0;
    let interruptAfterClaim = true;
    const executor: ToolExecutor = {
      name: "read",
      write: false,
      requiresApproval: () => true,
      execute: () => {
        executorCalls += 1;
        return Effect.succeed({
          settlement: { _tag: "Success" },
          observation: {
            text: "recovered after approval claim",
            truncated: false,
          },
          resultRef: null,
        });
      },
    };
    const tx = Layer.succeed(TransactionPort, {
      transact: <A, E, R>(body: Effect.Effect<A, E, R | TransactionScope>) =>
        Effect.provideService(body, TransactionScope, {
          session: { id: "p38-approval-reentry" },
        }),
    });
    const p38Approvals: ExecutableApprovalStoreService = {
      findByActionKey: () => Effect.succeed(Option.none()),
      findById: () => Effect.succeed(Option.some(approval)),
      findPendingForExecution: () => Effect.succeed(Option.none()),
      putPendingExact: () => Effect.die(new Error("unexpected approval issue")),
      decide: () => Effect.succeed(Option.none()),
      listResolved: () => Effect.succeed([]),
      expireDue: () => Effect.succeed([]),
      cancelForExecution: () => Effect.succeed([]),
      consumeApproved: (input) => {
        consumeCalls += 1;
        if (
          approval.state === "Approved" &&
          input.expectedRevision === approval.revision &&
          input.consumedBy === invocationId
        ) {
          approval = {
            ...approval,
            state: "Consumed",
            revision: approval.revision + 1,
            consumedAt: input.consumedAt,
            consumedBy: input.consumedBy,
          };
        }
        return Effect.succeed({
          approvalId: runtimeApprovalId,
          preConsumeRevision: 1,
          consumedRevision: 2,
          approvalDigest: "digest:p38-consumed",
          binding,
          expiresAt: "2999-01-01T00:00:00.000Z",
          consumedBy: invocationId,
        });
      },
    };
    const toolInvocations = {
      recordIntent: (next: import("@arbor/ports").ToolInvocationIntent) => {
        intentApprovalId = next.approvalId;
        if (recorded === undefined) {
          recorded = {
            ...next,
            effectAdmissionState: "NotAdmitted",
            settledAt: null,
            settlement: null,
            resultRef: null,
          };
        }
        return Effect.succeed("Recorded" as const);
      },
      settle: (
        _id: ToolInvocationRecord["invocationId"],
        settlement: ToolInvocationRecord["settlement"],
      ) => {
        settlementCalls += 1;
        if (recorded !== undefined && settlement !== null) {
          recorded = {
            ...recorded,
            settledAt: "2026-10-05T00:00:02.000Z",
            settlement,
          };
        }
        return Effect.succeed(true);
      },
      consumeApproval: () =>
        Effect.die(new Error("legacy approval route used")),
      recordNoEffectDenial: () => Effect.die(new Error("unexpected denial")),
      recordNoEffectInterruption: () => Effect.succeed(false),
      admitEffect: () => {
        if (recorded !== undefined) {
          recorded = { ...recorded, effectAdmissionState: "MayHaveStarted" };
        }
        return Effect.succeed({ _tag: "Admitted" as const });
      },
      findApproval: () => Effect.succeed(Option.none()),
      findById: () =>
        Effect.succeed(
          recorded === undefined ? Option.none() : Option.some(recorded),
        ),
      findUnsettled: () =>
        Effect.succeed(recorded === undefined ? [] : [recorded]),
    };
    const dependencies = Layer.mergeAll(
      tx,
      Layer.succeed(ToolDefinitionStore, {
        definition: () => Effect.succeed(Option.some(toolDefinition)),
        all: () => Effect.succeed([toolDefinition]),
      }),
      Layer.succeed(SandboxPort, {
        open: () =>
          Effect.succeed({
            handleId: "sandbox-p38",
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
            observedEnvironmentRevision: "env-p38",
          }),
      }),
      Layer.succeed(Clock, {
        now: () => Effect.succeed("2026-10-05T00:00:02.000Z"),
      }),
      Layer.succeed(ToolInvocationStore, toolInvocations as never),
      Layer.succeed(ExecutableApprovalStore, p38Approvals),
    );
    const runtimeLayer = Layer.provide(
      ToolRuntimeLive([executor], {
        qualificationProbe: async (event) => {
          if (
            interruptAfterClaim &&
            event.boundary === "AH7AfterToolIntentCommit"
          ) {
            interruptAfterClaim = false;
            throw new Error("simulated interruption after durable claim");
          }
        },
      }),
      dependencies,
    );
    const app = Layer.mergeAll(dependencies, runtimeLayer);
    const first = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* runtime.invoke(p38Intent, executableContext);
        }),
        app,
      ),
    );
    expect(first._tag).toBe("Failure");
    expect(intentApprovalId).toBe(runtimeApprovalId);
    expect(approval.state).toBe("Consumed");
    expect(executorCalls).toBe(0);

    const replay = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* runtime.invoke(p38Intent, executableContext);
        }),
        app,
      ),
    );
    expect(replay._tag).toBe("Success");
    expect(consumeCalls).toBe(1);
    expect(executorCalls).toBe(1);
    expect(settlementCalls).toBe(1);
  });
});
