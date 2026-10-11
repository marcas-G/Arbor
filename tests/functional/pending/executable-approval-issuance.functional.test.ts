import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { makeExecutableToolHandler } from "../../../apps/single-workspace/src/executable-tool-handler.js";
import type {
  ExecutionId,
  Principal,
} from "../../../packages/domain/src/index.js";
import type {
  ExecutableApprovalRecord,
  ExecutableApprovalStoreService,
  TransactionPortService,
} from "../../../packages/ports/src/index.js";

describe("EA-DG-01 Executable approval issuance boundary", () => {
  it("persists the exact P3 binding and returns a durable same-action pause", async () => {
    let persisted: ExecutableApprovalRecord | undefined;
    const store: ExecutableApprovalStoreService = {
      findByActionKey: () => Effect.succeed(Option.none()),
      findById: () => Effect.succeed(Option.none()),
      putPendingExact: (request) => {
        persisted = {
          ...request,
          routeKind: "Executable",
          revision: 0,
          state: "Pending",
          decidedAt: null,
          decidedBy: null,
          decisionReason: null,
          cancelledAt: null,
          cancelledBy: null,
          cancellationReason: null,
          consumedAt: null,
          consumedBy: null,
        };
        return Effect.succeed(persisted);
      },
      decide: () => Effect.succeed(Option.none()),
      listResolved: () => Effect.succeed([]),
      consumeApproved: () => Effect.succeed(false),
      expireDue: () => Effect.succeed([]),
      cancelForExecution: () => Effect.succeed([]),
    };
    const tx = {
      transact: (effect: Effect.Effect<unknown, unknown, unknown>) => effect,
    } as unknown as TransactionPortService;
    const handler = makeExecutableToolHandler(
      {
        invoke: (intent) => {
          expect(intent.approvalId).toBeNull();
          return Effect.succeed({
            _tag: "ApprovalRequired" as const,
            authority: {
              principal: "worker:ea-test" as Principal,
              workspaceId: "ws_ea_test" as never,
              executionId: "exe_ea_test" as never,
              toolName: "write_file",
              toolVersion: "2",
              resourceSpaceIds: ["space_ea"],
              allowedCapabilities: ["fs:write"],
              controlBasisDigest: "basis-ea",
              expiresAt: "2026-10-11T00:15:00.000Z",
              delegationDepth: 0,
            },
            targetResourceSpaceIds: ["space_ea"],
            actionDigest: "digest-ea",
            requestedCapabilities: ["fs:write"],
            sideEffectSemantics: "Idempotent" as const,
            controlBasisDigest: "basis-ea",
          });
        },
      },
      { now: () => Effect.succeed("2026-10-11T00:00:00.000Z") },
      {
        visibleRefs: () =>
          Effect.succeed([{ name: "write_file", version: "2", hash: "tool" }]),
        resolveForModel: () => Effect.die("unused"),
      },
      undefined,
      {
        store,
        transaction: tx,
        resolveCandidate: () =>
          Effect.succeed({
            approvalId: "apr_runtime_issued",
            expiresAt: "2026-10-11T00:15:00.000Z",
          }),
      },
    );

    const outcome = await Effect.runPromise(
      handler.handle({
        invocation: {
          providerTurnId: "ptn_ea_test" as never,
          outputPosition: 0,
          callRef: "provider-call-ea-test",
          toolName: "write_file",
          argumentsJson: '{"path":"a.txt","content":"x"}',
        },
        execution: {
          executionId: "exe_ea_test" as ExecutionId,
          projectId: "prj_ea_test" as never,
          workspaceId: "ws_ea_test" as never,
          sessionId: "ses_ea_test" as never,
          binding: {
            _tag: "WorkspaceExecution",
            workspaceId: "ws_ea_test" as never,
            focus: { _tag: "Work" },
          },
          admittedAt: "2026-10-11T00:00:00.000Z",
          stopRequestedAt: null,
          state: { status: "Active", settlement: null },
        } as never,
        context: {
          _tag: "ExecutionOrigin",
          principal: "worker:ea-test" as Principal,
          executionId: "exe_ea_test" as never,
          workerId: "worker-ea-test",
          workerIncarnationId: "incarnation-ea-test",
          fencingGeneration: 0 as never,
        } as never,
        controlBasis: {} as never,
        action: {
          logicalStepNo: 2,
          repairAttempt: 1,
          actionIndex: 0,
          logicalActionId: "lac_ea_test",
        },
        executionFence: {
          executionId: "exe_ea_test" as never,
          workerId: "worker-ea-test",
          workerIncarnationId: "incarnation-ea-test",
          fencingGeneration: 0 as never,
        },
      }),
    );

    expect(outcome).toEqual({
      _tag: "ApprovalRequired",
      approvalId: "apr_runtime_issued",
      revision: 0,
    });
    expect(persisted).toMatchObject({
      approvalId: "apr_runtime_issued",
      routeKind: "Executable",
      state: "Pending",
      revision: 0,
      projectId: "prj_ea_test",
      executionId: "exe_ea_test",
      logicalStepNo: 2,
      repairAttempt: 1,
      actionIndex: 0,
      logicalActionId: "lac_ea_test",
      callRef: "provider-call-ea-test",
    });
  });
});
