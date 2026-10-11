import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { makeCloseProjectHandler } from "../../../packages/application/src/commands/project-management.js";
import {
  Actor,
  CommandId,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
} from "../../../packages/domain/src/index.js";
import { makeStopExecutionHandler } from "../../../packages/execution-runtime/src/commands/stop-execution.js";
import type { ExecutableApprovalRecord } from "../../../packages/ports/src/executable-approval.js";
import { TransactionScope } from "../../../packages/ports/src/session.js";

const actor = parse(Actor)("user:p38-stop-test");
const principal = parse(Principal)("user:p38-stop-test");
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1");

describe("EA-DG-01 Stop cancellation boundary", () => {
  it("Stop cancels exact approvals and emits resolved wake facts", async () => {
    let cancelledInput: unknown;
    const approval: ExecutableApprovalRecord = {
      approvalId: "apr_p38_stop",
      routeKind: "Executable",
      projectId,
      workspaceId: "ws_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
      executionId,
      logicalStepNo: 2,
      repairAttempt: 0,
      actionIndex: 1,
      logicalActionId: "lac_p38_stop",
      subject: principal,
      callRef: "call-p38-stop",
      toolInvocationId: "tin_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
      toolName: "write_file",
      toolVersion: "2",
      sideEffectSemantics: "Idempotent",
      argumentsJson: '{"path":"a.txt","content":"x"}',
      actionDigest: "digest-p38",
      targetResourceSpaceIds: ["rsp_project"],
      controlBasisDigest: "basis-p38",
      revision: 1,
      requestedAt: "2026-10-11T00:00:00.000Z",
      expiresAt: "2026-10-11T00:15:00.000Z",
      state: "Cancelled",
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
      cancelledAt: "2026-10-11T00:01:00.000Z",
      cancelledBy: principal,
      cancellationReason: "StopRequested",
      consumedAt: null,
      consumedBy: null,
    };
    const handler = makeStopExecutionHandler({
      executions: {
        findById: () =>
          Effect.succeed(
            Option.some({
              executionId,
              projectId,
              workspaceId: approval.workspaceId,
              sessionId: "ses_p38_stop" as never,
              binding: {
                _tag: "WorkspaceExecution",
                workspaceId: approval.workspaceId,
                focus: { _tag: "Work", workId: "wrk_p38_stop" },
              },
              admittedAt: "2026-10-11T00:00:00.000Z",
              stopRequestedAt: null,
              state: { status: "Active", settlement: null },
            } as never),
          ),
        requestStop: () => Effect.void,
      } as never,
      executableApprovals: {
        cancelForExecution: (input) => {
          cancelledInput = input;
          return Effect.succeed([approval]);
        },
      },
    });

    const result = await Effect.runPromise(
      Effect.provideService(
        handler.execute(
          {
            projectId,
            commandId,
            actor,
            issuedAt: "2026-10-11T00:01:00.000Z",
            payload: { executionId },
          } as never,
          { _tag: "System", principal, causationRef: "p38-stop-test" } as never,
        ),
        TransactionScope,
        { session: { id: "p38-stop-test" } },
      ),
    );

    expect(cancelledInput).toEqual({
      executionId,
      cancelledAt: "2026-10-11T00:01:00.000Z",
      cancelledBy: principal,
      reason: "StopRequested",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "ExecutableApprovalResolved",
            aggregateRef: approval.approvalId,
            payload: expect.objectContaining({
              approvalId: approval.approvalId,
              routeKind: "Executable",
              toolInvocationId: approval.toolInvocationId,
              revision: 1,
              resolution: "Cancelled",
              reasonCode: "StopRequested",
            }),
          }),
        ]),
      );
    }
  });

  it("Stop retry reconciles approval rows after the stop flag is set", async () => {
    let cancellationCount = 0;
    const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789a1" as never;
    const handler = makeStopExecutionHandler({
      executions: {
        findById: () =>
          Effect.succeed(
            Option.some({
              executionId,
              projectId,
              workspaceId,
              sessionId: "ses_p38_already_stopped" as never,
              binding: {
                _tag: "WorkspaceExecution",
                workspaceId,
                focus: { _tag: "Work", workId: "wrk_p38_already_stopped" },
              },
              admittedAt: "2026-10-11T00:00:00.000Z",
              stopRequestedAt: "2026-10-11T00:00:30.000Z",
              state: { status: "Active", settlement: null },
            } as never),
          ),
        requestStop: () => Effect.void,
      } as never,
      executableApprovals: {
        cancelForExecution: () => {
          cancellationCount += 1;
          return Effect.succeed([]);
        },
      },
    });
    const result = await Effect.runPromise(
      handler.execute(
        {
          projectId,
          commandId,
          actor,
          issuedAt: "2026-10-11T00:02:00.000Z",
          payload: { executionId },
        } as never,
        {
          _tag: "System",
          principal,
          causationRef: "p38-stop-recovery",
        } as never,
      ) as Effect.Effect<unknown, unknown, never>,
    );

    expect(cancellationCount).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      value: {
        result: { stopRequestedAt: "2026-10-11T00:00:30.000Z" },
      },
    });
  });

  it("CloseProject routes direct stops through the approval cancellation path", async () => {
    let stopCount = 0;
    let cancellationCount = 0;
    const closeWorkspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789a1" as never;
    const execution = {
      executionId,
      projectId,
      workspaceId: closeWorkspaceId,
      sessionId: "ses_p38_close" as never,
      binding: {
        _tag: "WorkspaceExecution",
        workspaceId: closeWorkspaceId,
        focus: { _tag: "Work", workId: "wrk_p38_close" as never },
      },
      admittedAt: "2026-10-11T00:00:00.000Z",
      stopRequestedAt: null,
      state: { status: "Active", settlement: null },
    } as never;
    const closeProject = makeCloseProjectHandler({
      projects: {
        findById: () =>
          Effect.succeed(
            Option.some({
              projectId,
              rootWorkspaceId: closeWorkspaceId,
              lifecycle: "Open",
              revision: 0,
            } as never),
          ),
        closeIfRevision: () => Effect.void,
      } as never,
      executions: {
        findUnsettledExecutions: () => Effect.succeed([execution]),
        requestStop: () => {
          stopCount += 1;
          return Effect.void;
        },
      } as never,
      responseJobs: {
        listForWorkspace: () => Effect.succeed([]),
        transition: () => Effect.void,
      } as never,
      inbox: { markConsumed: () => Effect.void } as never,
      executableApprovals: {
        cancelForExecution: () => {
          cancellationCount += 1;
          return Effect.succeed([]);
        },
      },
    });

    await Effect.runPromise(
      Effect.provideService(
        closeProject.execute(
          {
            projectId,
            commandId,
            actor,
            issuedAt: "2026-10-11T00:02:00.000Z",
            payload: { expectedRevision: 0 as never, confirmed: true },
          } as never,
          {
            _tag: "System",
            principal,
            causationRef: "p38-close-test",
          } as never,
        ),
        TransactionScope,
        { session: { id: "p38-close-test" } },
      ),
    );

    expect(stopCount).toBe(1);
    expect(cancellationCount).toBe(1);
  });
});
