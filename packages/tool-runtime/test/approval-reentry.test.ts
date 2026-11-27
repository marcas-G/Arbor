import { Principal, parse } from "@arbor/domain";
import {
  type ExecutableApprovalBinding,
  type ExecutableApprovalRecord,
  ExecutableApprovalStore,
  type ExecutableApprovalStoreService,
  type InvocationApproval,
  ToolInvocationStore,
  ToolRuntimePort,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  actionDigestOf,
  executableApprovalTerminalDenial,
  type ToolExecutor,
  ToolRuntimeLive,
} from "../src/index.js";
import {
  approvalContext,
  approvalExecutionId,
  approvalId,
  approvalIntent,
  approvalInvocationId,
  approvalPipelineDeps,
  approvalProjectId,
  approvalWorkspaceId,
  pendingInvocationRecord,
} from "./approval-support.js";

const intent = approvalIntent();
const context = approvalContext;
const invocationId = approvalInvocationId;

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

describe("exact approval recovery for the same ToolInvocationId", () => {
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

    const deps = approvalPipelineDeps({
      sandboxHandleId: "sandbox-ah7",
      environmentRevision: "env-ah7",
      now: "2026-10-05T00:00:00.000Z",
    });
    const dependencies = Layer.mergeAll(
      deps,
      Layer.succeed(ToolInvocationStore, {
        recordIntent: () => {
          intentWrites += 1;
          return Effect.succeed("Recorded" as const);
        },
        settle: (id: typeof invocationId) => {
          expect(id).toBe(invocationId);
          settlementWrites += 1;
          return Effect.succeed(true);
        },
        consumeApproval: (_id: string, consumer: typeof invocationId) => {
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
        findById: (id: typeof invocationId) => {
          expect(id).toBe(invocationId);
          return Effect.succeed(Option.some(pendingInvocationRecord()));
        },
        findUnsettled: () => Effect.succeed([pendingInvocationRecord()]),
      } as never),
    );
    const app = Layer.mergeAll(
      dependencies,
      Layer.provide(ToolRuntimeLive([executor]), dependencies),
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
    const principal = parse(Principal)("worker:a");
    const binding: ExecutableApprovalBinding = {
      projectId: approvalProjectId,
      workspaceId: approvalWorkspaceId,
      executionId: approvalExecutionId,
      logicalStepNo: 4,
      repairAttempt: 0,
      actionIndex: 0,
      logicalActionId: "lac_p4_same_invocation",
      subject: principal,
      callRef: intent.callRef,
      toolInvocationId: invocationId,
      toolName: "read",
      toolVersion: "1",
      sideEffectSemantics: "Idempotent",
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
    const executableContext = {
      ...context,
      authority: {
        ...context.authority,
        sourceRevision: "authority-revision-p38",
      },
      executionFence: {
        executionId: approvalExecutionId,
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
    } as typeof context;
    let recorded: import("@arbor/ports").ToolInvocationRecord | undefined;
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
        _id: typeof invocationId,
        settlement: import("@arbor/ports").ToolInvocationRecord["settlement"],
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
      approvalPipelineDeps({
        sandboxHandleId: "sandbox-p38",
        environmentRevision: "env-p38",
        now: "2026-10-05T00:00:02.000Z",
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
